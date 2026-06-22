declare const process: { cwd(): string };

import { loadConfig, resolveLimit } from "./config.js";
import { registerCommands } from "./commands.js";
import { registerCompressTool } from "./compress-tool.js";
import { registerExpandTools } from "./expand-tool.js";
import {
	CONTINUE_AFTER_COMPRESS,
	CRITICAL_NUDGE,
	ITERATION_NUDGE,
	MANUAL_MODE_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
	TURN_NUDGE,
} from "./prompts.js";
import {
	createInputFingerprint,
	createState,
	resetState,
	type StableDcpState,
} from "./state.js";
import {
	activeCompressedOnly,
	applyPruning,
	latestUserText,
	pushSyntheticUserMessage,
	shouldAvoidNudgeForUserRequest,
	stripDcpArtifactsFromMessage,
} from "./pruner.js";

type ExtensionAPI = any;
type ExtensionContext = any;
type NudgeDecision = { text: string; target: "assistant" | "user" };

const STATE_TYPE = "pi-dcp-stable-state";
const INTERNAL_AGENT_SIGNATURES = [
	"You are a title generator",
	"You are a helpful AI assistant tasked with summarizing conversations",
	"Summarize what was done in this conversation",
	"Summarize the conversation",
];

function saveState(pi: ExtensionAPI, state: StableDcpState): void {
	try {
		pi.appendEntry(STATE_TYPE, {
			compressionBlocks: state.compressionBlocks,
			nextBlockId: state.nextBlockId,
			prunedToolIds: [...state.prunedToolIds],
			tokensSaved: state.tokensSaved,
			totalPruneCount: state.totalPruneCount,
			manualMode: state.manualMode,
			lastCompressAt: state.lastCompressAt,
			lastCompressRangeCount: state.lastCompressRangeCount,
		});
	} catch {
		// Persistence is best-effort; never break the agent loop for DCP state.
	}
}

function restoreState(
	ctx: ExtensionContext,
	state: StableDcpState,
	configManualMode: boolean,
): void {
	resetState(state);
	state.manualMode = configManualMode;

	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (const entry of branch) {
		if (entry?.type !== "custom" || entry?.customType !== STATE_TYPE) continue;
		const data = entry.data ?? {};
		if (Array.isArray(data.compressionBlocks)) {
			state.compressionBlocks = data.compressionBlocks
				.filter(
					(block: any) =>
						Number.isFinite(block?.startTimestamp) &&
						Number.isFinite(block?.endTimestamp),
				)
				.map((block: any) => ({
					...block,
					active: block.active !== false,
					anchorTimestamp: Number.isFinite(block.anchorTimestamp)
						? block.anchorTimestamp
						: block.endTimestamp + 1,
					compressedTokenEstimate: Number.isFinite(block.compressedTokenEstimate)
						? block.compressedTokenEstimate
						: 0,
					directMessageCount: Number.isFinite(block.directMessageCount)
						? block.directMessageCount
						: 0,
					directToolCount: Number.isFinite(block.directToolCount)
						? block.directToolCount
						: 0,
				}));
			state.nextBlockId = Number.isFinite(data.nextBlockId)
				? data.nextBlockId
				: state.compressionBlocks.reduce(
						(max, block) => Math.max(max, Number(block.id) || 0),
						0,
					) + 1;
		}
		if (Array.isArray(data.prunedToolIds))
			state.prunedToolIds = new Set(data.prunedToolIds.map(String));
		if (Number.isFinite(data.tokensSaved)) state.tokensSaved = data.tokensSaved;
		if (Number.isFinite(data.totalPruneCount))
			state.totalPruneCount = data.totalPruneCount;
		if (typeof data.manualMode === "boolean")
			state.manualMode = data.manualMode;
		if (Number.isFinite(data.lastCompressAt))
			state.lastCompressAt = data.lastCompressAt;
		if (Number.isFinite(data.lastCompressRangeCount))
			state.lastCompressRangeCount = data.lastCompressRangeCount;
	}
}

function systemPromptLooksInternal(systemPrompt: string): boolean {
	return INTERNAL_AGENT_SIGNATURES.some((signature) =>
		systemPrompt.includes(signature),
	);
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part?.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function toolResultText(event: any): string {
	if (Array.isArray(event.content)) return contentText(event.content);
	return contentText(event.content ?? "");
}

function countMessagesSinceLastUser(messages: any[]): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "user") break;
		count++;
	}
	return count;
}

function latestRole(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = String(messages[i]?.role || "");
		if (role) return role;
	}
	return "";
}

function appendTextToMessage(message: any, text: string): boolean {
	if (!message) return false;
	if (typeof message.content === "string") {
		message.content += text;
		return true;
	}
	if (Array.isArray(message.content)) {
		for (let i = message.content.length - 1; i >= 0; i--) {
			const part = message.content[i];
			if (part?.type === "text" && typeof part.text === "string") {
				part.text += text;
				return true;
			}
		}
		message.content.push({ type: "text", text });
		return true;
	}
	message.content = [{ type: "text", text }];
	return true;
}

function injectNudge(messages: any[], decision: NudgeDecision): void {
	if (decision.target === "assistant") {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				appendTextToMessage(messages[i], `\n${decision.text}`);
				return;
			}
		}
	}
	pushSyntheticUserMessage(messages, decision.text);
}

function shouldInjectNudge(
	messages: any[],
	ctx: ExtensionContext,
	state: StableDcpState,
	config: ReturnType<typeof loadConfig>,
): NudgeDecision | null {
	const usage = ctx.getContextUsage?.();
	if (
		!usage ||
		usage.tokens === null ||
		!Number.isFinite(usage.tokens) ||
		!Number.isFinite(usage.contextWindow)
	)
		return null;
	if (config.compress.autonomous === "off") return null;
	if (config.compress.permission === "deny") return null;

	const latestText = latestUserText(messages);
	const isUserAskingForSummary = shouldAvoidNudgeForUserRequest(latestText);
	const isCompressedOnly = activeCompressedOnly(messages);
	const maxLimit = resolveLimit(
		config.compress.maxContextLimit,
		usage.contextWindow,
		0.85,
	);
	const minLimit = resolveLimit(
		config.compress.minContextLimit,
		usage.contextWindow,
		0.6,
	);

	const criticalAllowed =
		!state.manualMode || config.manualMode.allowCriticalNudge;
	if (
		usage.tokens >= maxLimit &&
		criticalAllowed &&
		!isUserAskingForSummary &&
		!isCompressedOnly
	) {
		if (state.nudgeCounter >= config.compress.nudgeFrequency)
			return {
				text: CRITICAL_NUDGE,
				target: config.compress.nudgeForce === "soft" ? "assistant" : "user",
			};
		state.nudgeCounter++;
		return null;
	}

	if (state.manualMode) return null;
	if (config.compress.autonomous !== "housekeeping") return null;
	if (usage.tokens < minLimit || isUserAskingForSummary || isCompressedOnly)
		return null;

	if (latestRole(messages) === "user") {
		return {
			text: TURN_NUDGE,
			target: config.compress.nudgeForce === "soft" ? "assistant" : "user",
		};
	}

	const messagesSinceUser = countMessagesSinceLastUser(messages);
	if (
		messagesSinceUser >= config.compress.iterationNudgeThreshold &&
		state.nudgeCounter >= config.compress.nudgeFrequency
	) {
		return {
			text: ITERATION_NUDGE,
			target: config.compress.nudgeForce === "soft" ? "assistant" : "user",
		};
	}
	state.nudgeCounter++;
	return null;
}

export default function stableDcpExtension(pi: ExtensionAPI): void {
	const config = loadConfig(process.cwd());
	if (!config.enabled) return;

	const state = createState();
	state.manualMode = config.manualMode.enabled;

	if (config.compress.permission !== "deny") registerCompressTool(pi, state, config);
	registerExpandTools(pi, state);
	registerCommands(pi, state, config);

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		restoreState(ctx, state, config.manualMode.enabled);
		ctx.ui?.setStatus?.(
			"dcp",
			state.manualMode ? "DCP stable [manual]" : "DCP stable",
		);
	});

	pi.on("session_shutdown", async () => {
		saveState(pi, state);
	});

	pi.on("before_agent_start", async (event: any) => {
		const currentPrompt = String(event.systemPrompt || "");
		if (systemPromptLooksInternal(currentPrompt)) return;
		const addition = state.manualMode
			? MANUAL_MODE_SYSTEM_PROMPT
			: SYSTEM_PROMPT;
		return { systemPrompt: `${currentPrompt}\n\n${addition}` };
	});

	pi.on("tool_call", async (event: any) => {
		if (!event?.toolCallId || !event?.toolName) return;
		if (!state.toolCalls.has(event.toolCallId)) {
			const inputArgs =
				event.input && typeof event.input === "object"
					? (event.input as Record<string, unknown>)
					: {};
			state.toolCalls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputArgs,
				inputFingerprint: createInputFingerprint(event.toolName, inputArgs),
				isError: false,
				turnIndex: state.currentTurn,
				timestamp: 0,
				tokenEstimate: 0,
			});
		}
	});

	pi.on("tool_result", async (event: any) => {
		if (!event?.toolCallId || !event?.toolName) return;
		const output = toolResultText(event);
		const tokenEstimate = Math.round(output.length / 4);
		const existing = state.toolCalls.get(event.toolCallId);
		if (existing) {
			existing.isError = !!event.isError;
			existing.timestamp = Date.now();
			existing.tokenEstimate = tokenEstimate;
		} else {
			state.toolCalls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputArgs: {},
				inputFingerprint: createInputFingerprint(event.toolName, {}),
				isError: !!event.isError,
				turnIndex: state.currentTurn,
				timestamp: Date.now(),
				tokenEstimate,
			});
		}
	});

	pi.on("context", async (event: any, ctx: ExtensionContext) => {
		const prunedMessages = applyPruning(event.messages ?? [], state, config);
		const nudge = shouldInjectNudge(prunedMessages, ctx, state, config);
		if (nudge) {
			injectNudge(prunedMessages, nudge);
			state.nudgeCounter = 0;
		}
		return { messages: prunedMessages };
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role !== "assistant") return;
		const message = stripDcpArtifactsFromMessage(event.message);
		return { message };
	});

	pi.on("agent_end", async () => {
		saveState(pi, state);
	});

	// Keep the continuation rule near active model context after compress calls.
	pi.on("tool_result", async (event: any) => {
		if (event?.toolName !== "compress") return;
		if (event?.content && Array.isArray(event.content)) {
			const text = contentText(event.content);
			if (!text.includes(CONTINUE_AFTER_COMPRESS)) {
				return {
					content: [
						...event.content,
						{ type: "text", text: `\n\n${CONTINUE_AFTER_COMPRESS}` },
					],
				};
			}
		}
	});
}
