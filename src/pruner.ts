import type { StableDcpConfig } from "./config.js";
import type { CompressionBlock, StableDcpState } from "./state.js";

const ID_ELIGIBLE_ROLES = new Set([
	"user",
	"assistant",
	"toolResult",
	"bashExecution",
]);
const PASSTHROUGH_ROLES = new Set([
	"compactionSummary",
	"branchSummary",
	"custom",
]);

export function estimateTokens(text: string): number {
	return Math.max(0, Math.round(text.length / 4));
}

export function messageText(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				if (typeof part.text === "string") return part.text;
				if (typeof part.thinking === "string") return part.thinking;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (typeof message.output === "string") return message.output;
	return "";
}

function messageTokens(message: any): number {
	if (!message) return 0;
	let total = estimateTokens(messageText(message));
	const content = message.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part?.type === "image") total += 500;
		}
	}
	if (message.role === "bashExecution" && typeof message.output === "string") {
		total += estimateTokens(message.output);
	}
	return total;
}

function cloneMessages(messages: any[]): any[] {
	return messages.map((message) => {
		const clone = { ...message };
		if (Array.isArray(clone.content)) {
			clone.content = clone.content.map((part: any) =>
				part && typeof part === "object" ? { ...part } : part,
			);
		}
		return clone;
	});
}

function appendText(message: any, text: string): void {
	if (typeof message.content === "string") {
		message.content += text;
		return;
	}
	if (Array.isArray(message.content)) {
		message.content = [...message.content, { type: "text", text }];
		return;
	}
	message.content = [{ type: "text", text }];
}

function addAssistantId(message: any, idTag: string): void {
	if (typeof message.content === "string") {
		message.content += idTag;
		return;
	}
	if (!Array.isArray(message.content)) {
		message.content = [{ type: "text", text: idTag }];
		return;
	}
	const firstToolCall = message.content.findIndex(
		(part: any) => part?.type === "toolCall",
	);
	const idBlock = { type: "text", text: idTag };
	if (firstToolCall < 0) {
		message.content = [...message.content, idBlock];
	} else {
		message.content = [
			...message.content.slice(0, firstToolCall),
			idBlock,
			...message.content.slice(firstToolCall),
		];
	}
}

function findIndexByTimestamp(messages: any[], timestamp: number): number {
	return messages.findIndex(
		(message) => Number(message.timestamp) === timestamp,
	);
}

function assistantToolIds(message: any): Set<string> {
	const ids = new Set<string>();
	if (message?.role !== "assistant" || !Array.isArray(message.content))
		return ids;
	for (const part of message.content) {
		if (part?.type === "toolCall" && typeof part.id === "string")
			ids.add(part.id);
	}
	return ids;
}

function expandToolPairs(
	messages: any[],
	lo: number,
	hi: number,
): [number, number] {
	let changed = true;
	while (changed) {
		changed = false;

		const resultIds = new Set<string>();
		for (let i = lo; i <= hi; i++) {
			const msg = messages[i];
			if (
				(msg.role === "toolResult" || msg.role === "bashExecution") &&
				typeof msg.toolCallId === "string"
			) {
				resultIds.add(msg.toolCallId);
			}
		}

		let scan = lo - 1;
		while (
			scan >= 0 &&
			(messages[scan].role === "toolResult" ||
				messages[scan].role === "bashExecution" ||
				PASSTHROUGH_ROLES.has(messages[scan].role))
		)
			scan--;
		if (scan >= 0 && messages[scan].role === "assistant") {
			const toolIds = assistantToolIds(messages[scan]);
			if ([...toolIds].some((id) => resultIds.has(id))) {
				lo = scan;
				changed = true;
			}
		}

		const toolIds = new Set<string>();
		for (let i = lo; i <= hi; i++) {
			for (const id of assistantToolIds(messages[i])) toolIds.add(id);
		}
		while (hi + 1 < messages.length) {
			const next = messages[hi + 1];
			if (
				(next.role === "toolResult" || next.role === "bashExecution") &&
				toolIds.has(next.toolCallId)
			) {
				hi++;
				changed = true;
			} else if (PASSTHROUGH_ROLES.has(next.role)) {
				hi++;
				changed = true;
			} else {
				break;
			}
		}
	}
	return [lo, hi];
}

function applyCompressionBlocks(messages: any[], state: StableDcpState): void {
	const blocks = state.compressionBlocks
		.filter(
			(block) =>
				block.active &&
				Number.isFinite(block.startTimestamp) &&
				Number.isFinite(block.endTimestamp),
		)
		.sort((a, b) => a.startTimestamp - b.startTimestamp);

	for (const block of blocks) {
		const startIdx = findIndexByTimestamp(messages, block.startTimestamp);
		const endIdx = findIndexByTimestamp(messages, block.endTimestamp);
		if (startIdx < 0 || endIdx < 0) continue;

		let lo = Math.min(startIdx, endIdx);
		let hi = Math.max(startIdx, endIdx);
		[lo, hi] = expandToolPairs(messages, lo, hi);

		let removedTokens = 0;
		for (let i = lo; i <= hi; i++) removedTokens += messageTokens(messages[i]);
		messages.splice(lo, hi - lo + 1);

		const synthetic = {
			role: "user",
			content: [
				{
					type: "text",
					text: `[Compressed section: ${block.topic}]\n\n${block.summary}\n\n<dcp-block-id>b${block.id}</dcp-block-id>`,
				},
			],
			timestamp: Number.isFinite(block.anchorTimestamp)
				? block.anchorTimestamp - 0.5
				: block.endTimestamp + 0.5,
		};

		const addedTokens = messageTokens(synthetic);
		const saved = removedTokens - addedTokens;
		if (saved > 0) state.tokensSaved += saved;
		messages.splice(lo, 0, synthetic);
	}
}

function repairOrphanedToolPairs(messages: any[]): void {
	const assistantCalls = new Set<string>();
	for (const message of messages) {
		for (const id of assistantToolIds(message)) assistantCalls.add(id);
	}

	const results = new Set<string>();
	for (const message of messages) {
		if (
			(message.role === "toolResult" || message.role === "bashExecution") &&
			typeof message.toolCallId === "string"
		) {
			results.add(message.toolCallId);
		}
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			(message.role === "toolResult" || message.role === "bashExecution") &&
			typeof message.toolCallId === "string" &&
			!assistantCalls.has(message.toolCallId)
		) {
			messages.splice(i, 1);
		}
	}

	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		const next = message.content.filter(
			(part: any) =>
				part?.type !== "toolCall" ||
				(typeof part.id === "string" && results.has(part.id)),
		);
		if (next.length !== message.content.length) message.content = next;
	}
}

function applyDeduplication(
	messages: any[],
	state: StableDcpState,
	config: StableDcpConfig,
): void {
	if (!config.strategies.deduplication.enabled) return;
	if (state.manualMode && !config.manualMode.automaticStrategies) return;
	const protectedTools = new Set([
		"compress",
		"write",
		"edit",
		...config.strategies.deduplication.protectedTools,
	]);
	const byFingerprint = new Map<string, string[]>();

	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (protectedTools.has(String(message.toolName || ""))) continue;
		const record = state.toolCalls.get(String(message.toolCallId || ""));
		if (!record) continue;
		const list = byFingerprint.get(record.inputFingerprint) ?? [];
		list.push(record.toolCallId);
		byFingerprint.set(record.inputFingerprint, list);
	}

	for (const ids of byFingerprint.values()) {
		for (const id of ids.slice(0, -1)) {
			if (!state.prunedToolIds.has(id)) state.totalPruneCount++;
			state.prunedToolIds.add(id);
		}
	}
}

function applyErrorPurging(
	messages: any[],
	state: StableDcpState,
	config: StableDcpConfig,
): void {
	if (!config.strategies.purgeErrors.enabled) return;
	if (state.manualMode && !config.manualMode.automaticStrategies) return;
	const protectedTools = new Set([
		"compress",
		...config.strategies.purgeErrors.protectedTools,
	]);
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.isError) continue;
		if (protectedTools.has(String(message.toolName || ""))) continue;
		const record = state.toolCalls.get(String(message.toolCallId || ""));
		if (!record) continue;
		if (
			state.currentTurn - record.turnIndex >=
			config.strategies.purgeErrors.turns
		) {
			if (!state.prunedToolIds.has(record.toolCallId)) state.totalPruneCount++;
			state.prunedToolIds.add(record.toolCallId);
		}
	}
}

function applyToolPruning(messages: any[], state: StableDcpState): void {
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (!state.prunedToolIds.has(String(message.toolCallId || ""))) continue;
		message.content = [
			{
				type: "text",
				text: message.isError
					? "[Error output removed by pi-dcp-stable after becoming stale]"
					: "[Tool output removed by pi-dcp-stable; a newer duplicate or summary supersedes it]",
			},
		];
	}
}

function injectMessageIds(messages: any[], state: StableDcpState): void {
	state.messageIdSnapshot.clear();
	state.messageTokenSnapshot.clear();
	let counter = 1;
	for (const message of messages) {
		const role = String(message.role || "");
		if (!ID_ELIGIBLE_ROLES.has(role)) continue;
		const timestamp = Number(message.timestamp);
		if (Number.isFinite(timestamp)) {
			state.messageTokenSnapshot.set(timestamp, {
				timestamp,
				role,
				tokenEstimate: messageTokens(message),
				toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			});
		}
		const id = `m${String(counter++).padStart(3, "0")}`;
		const idTag = `\n<dcp-id>${id}</dcp-id>`;
		if (role === "assistant") addAssistantId(message, idTag);
		else appendText(message, idTag);
		if (Number.isFinite(timestamp)) state.messageIdSnapshot.set(id, timestamp);
	}
}

export function applyPruning(
	messages: any[],
	state: StableDcpState,
	config: StableDcpConfig,
): any[] {
	const cloned = cloneMessages(messages);
	state.currentTurn = cloned.filter(
		(message) => message.role === "user",
	).length;
	applyCompressionBlocks(cloned, state);
	repairOrphanedToolPairs(cloned);
	applyDeduplication(cloned, state, config);
	applyErrorPurging(cloned, state, config);
	applyToolPruning(cloned, state);
	injectMessageIds(cloned, state);
	return cloned;
}

export function pushSyntheticUserMessage(messages: any[], text: string): void {
	messages.push({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
}

export function stripDcpArtifactsFromText(text: string): string {
	return text
		.replace(/\n?<dcp-id>m\d{3}<\/dcp-id>/g, "")
		.replace(/\n?<dcp-block-id>b\d+<\/dcp-block-id>/g, "")
		.replace(/<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g, "");
}

export function stripDcpArtifactsFromMessage(message: any): any {
	if (!message || message.role !== "assistant") return message;
	const clone = { ...message };
	if (typeof clone.content === "string") {
		clone.content = stripDcpArtifactsFromText(clone.content);
	} else if (Array.isArray(clone.content)) {
		clone.content = clone.content.map((part: any) => {
			if (part?.type === "text" && typeof part.text === "string") {
				return { ...part, text: stripDcpArtifactsFromText(part.text) };
			}
			return part;
		});
	}
	return clone;
}

export function activeCompressedOnly(messages: any[]): boolean {
	const text = messages.map(messageText).join("\n");
	return (
		text.includes("[Compressed section:") &&
		!messages.some((m) => m.role === "toolResult" || m.role === "bashExecution")
	);
}

export function latestUserText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return messageText(messages[i]);
	}
	return "";
}

export function shouldAvoidNudgeForUserRequest(text: string): boolean {
	const lowered = text.toLowerCase();
	return (
		lowered.includes("작업 요약") ||
		lowered.includes("작업 내역") ||
		lowered.includes("요약해줘") ||
		lowered.includes("summarize") ||
		lowered.includes("summary") ||
		lowered.includes("what did you do")
	);
}

export function compressionSummary(block: CompressionBlock): string {
	const removed = Number(block.compressedTokenEstimate || 0);
	const summary = Number(block.summaryTokenEstimate || 0);
	return `b${block.id} — ${block.topic} (-${removed} / +${summary} tokens)`;
}
