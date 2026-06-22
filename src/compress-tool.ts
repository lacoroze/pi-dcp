type ExtensionAPI = any;

type ToolContext = {
	ui: { notify(message: string, level?: string): void };
};

import type { StableDcpConfig } from "./config.js";
import type { CompressionBlock, StableDcpState } from "./state.js";
import {
	CONTINUE_AFTER_COMPRESS,
	COMPRESS_RANGE_DESCRIPTION,
} from "./prompts.js";
import { estimateTokens } from "./pruner.js";

interface CompressRangeInput {
	startId: string;
	endId: string;
	summary: string;
}

interface CompressInput {
	topic: string;
	ranges: CompressRangeInput[];
}

interface RangeMetrics {
	compressedTokens: number;
	messageCount: number;
	toolCount: number;
}

export const COMPRESS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["topic", "ranges"],
	properties: {
		topic: {
			type: "string",
			description: "Short label for this compression, usually 3-5 words.",
		},
		ranges: {
			type: "array",
			minItems: 1,
			description: "Closed conversation ranges to compress.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["startId", "endId", "summary"],
				properties: {
					startId: {
						type: "string",
						description: "Range start boundary, e.g. m001 or b2.",
					},
					endId: {
						type: "string",
						description: "Range end boundary, e.g. m042 or b5.",
					},
					summary: {
						type: "string",
						description: "Exhaustive technical summary replacing the range.",
					},
				},
			},
		},
	},
} as any;

function expandBlockPlaceholders(
	summary: string,
	state: StableDcpState,
): string {
	return summary.replace(/\(b(\d+)\)/g, (match, idText) => {
		const id = Number(idText);
		const block = state.compressionBlocks.find(
			(candidate) => candidate.id === id && candidate.active,
		);
		if (!block) return match;
		return `[Previously compressed: ${block.topic}]\n${block.summary}`;
	});
}

function resolveIdToTimestamp(
	idRaw: string,
	field: "startTimestamp" | "endTimestamp",
	state: StableDcpState,
): number {
	const id = idRaw.trim();
	const blockMatch = /^b(\d+)$/i.exec(id);
	if (blockMatch) {
		const blockId = Number(blockMatch[1]);
		const block = state.compressionBlocks.find(
			(candidate) => candidate.id === blockId && candidate.active,
		);
		if (!block) throw new Error(`Unknown message ID: ${id}`);
		return block[field];
	}

	const timestamp = state.messageIdSnapshot.get(id);
	if (timestamp === undefined) throw new Error(`Unknown message ID: ${id}`);
	return timestamp;
}

function resolveAnchorTimestamp(
	endTimestamp: number,
	state: StableDcpState,
): number {
	let anchor: number | undefined;
	for (const timestamp of state.messageIdSnapshot.values()) {
		if (
			timestamp > endTimestamp &&
			(anchor === undefined || timestamp < anchor)
		)
			anchor = timestamp;
	}
	return anchor ?? endTimestamp + 1;
}

function deactivateCoveredBlocks(
	startTimestamp: number,
	endTimestamp: number,
	state: StableDcpState,
): number[] {
	const deactivated: number[] = [];
	for (const block of state.compressionBlocks) {
		if (!block.active) continue;
		if (
			!Number.isFinite(block.startTimestamp) ||
			!Number.isFinite(block.endTimestamp)
		)
			continue;
		const fullyCovered =
			startTimestamp <= block.startTimestamp &&
			block.endTimestamp <= endTimestamp;
		const overlaps =
			startTimestamp <= block.endTimestamp &&
			block.startTimestamp <= endTimestamp;
		if (fullyCovered) {
			block.active = false;
			deactivated.push(block.id);
			continue;
		}
		if (overlaps) {
			throw new Error(
				`Compression range partially overlaps active block b${block.id}. ` +
					`Use boundaries that fully include or fully exclude existing compressed blocks.`,
			);
		}
	}
	return deactivated;
}

function rangeMetrics(
	startTimestamp: number,
	endTimestamp: number,
	state: StableDcpState,
): RangeMetrics {
	let compressedTokens = 0;
	let messageCount = 0;
	let toolCount = 0;
	for (const snapshot of state.messageTokenSnapshot.values()) {
		if (snapshot.timestamp < startTimestamp || snapshot.timestamp > endTimestamp)
			continue;
		compressedTokens += Math.max(0, snapshot.tokenEstimate || 0);
		messageCount++;
		if (snapshot.role === "toolResult" || snapshot.role === "bashExecution")
			toolCount++;
	}
	return { compressedTokens, messageCount, toolCount };
}

function formatTokenCount(value: number, signed = false): string {
	const rounded = Math.round(value || 0);
	const abs = Math.abs(rounded);
	const body =
		abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k` : `${abs}`;
	return `${signed && rounded >= 0 ? "+" : rounded < 0 ? "-" : ""}${body}`;
}

function buildProgressBar(state: StableDcpState, width = 50): string {
	const snapshots = [...state.messageTokenSnapshot.values()].sort(
		(a, b) => a.timestamp - b.timestamp,
	);
	if (!snapshots.length) return "";
	const activeBlocks = state.compressionBlocks.filter((block) => block.active);
	let output = "";
	for (let index = 0; index < width; index++) {
		const snap = snapshots[Math.floor((index / width) * snapshots.length)];
		const compressed = activeBlocks.some(
			(block) =>
				block.startTimestamp <= snap.timestamp &&
				snap.timestamp <= block.endTimestamp,
		);
		output += compressed ? "█" : "░";
	}
	return output;
}

function buildCompressionNotification(
	state: StableDcpState,
	config: StableDcpConfig,
	blocks: CompressionBlock[],
	batchTopic: string,
): string {
	const compressedTokens = blocks.reduce(
		(sum, block) => sum + (block.compressedTokenEstimate || 0),
		0,
	);
	const summaryTokens = blocks.reduce(
		(sum, block) => sum + (block.summaryTokenEstimate || 0),
		0,
	);
	const totalActiveSummary = state.compressionBlocks
		.filter((block) => block.active)
		.reduce((sum, block) => sum + (block.summaryTokenEstimate || 0), 0);
	const totalRemoved = state.compressionBlocks
		.filter((block) => block.active)
		.reduce((sum, block) => sum + (block.compressedTokenEstimate || 0), 0);
	const header = `▣ DCP | -${formatTokenCount(totalRemoved)} removed, +${formatTokenCount(totalActiveSummary)} summary`;
	if (config.pruneNotification === "minimal") return `${header} — Compression`;

	const lines = [header];
	const bar = buildProgressBar(state);
	if (bar) lines.push("", bar);
	lines.push(
		`▣ Compression ${blocks.map((block) => `#${block.id}`).join(", ")} -${formatTokenCount(compressedTokens)} removed, +${formatTokenCount(summaryTokens)} summary`,
		`→ Topic: ${batchTopic}`,
	);
	const messageCount = blocks.reduce(
		(sum, block) => sum + (block.directMessageCount || 0),
		0,
	);
	const toolCount = blocks.reduce(
		(sum, block) => sum + (block.directToolCount || 0),
		0,
	);
	lines.push(
		`→ Items: ${messageCount} messages${toolCount ? ` and ${toolCount} tools` : ""} compressed`,
	);
	if (config.compress.showCompression) {
		const summary = blocks
			.map((block) => `### ${block.topic}\n${block.summary}`)
			.join("\n\n");
		lines.push(`→ Compression (~${formatTokenCount(summaryTokens)}): ${summary}`);
	}
	return lines.join("\n").trim();
}

function notifyCompression(
	pi: ExtensionAPI,
	ctx: ToolContext,
	config: StableDcpConfig,
	message: string,
): void {
	if (config.pruneNotification === "off") return;
	if (config.pruneNotificationType === "chat") {
		try {
			pi.sendMessage?.(
				{
					customType: "pi-dcp-stable-notification",
					content: message,
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		} catch {
			// Fall through to toast-like notify.
		}
	}
	ctx.ui.notify(message, "info");
}

export function registerCompressTool(
	pi: ExtensionAPI,
	state: StableDcpState,
	config: StableDcpConfig,
): void {
	pi.registerTool({
		name: "compress",
		label: "Compress Context",
		description: COMPRESS_RANGE_DESCRIPTION,
		promptSnippet:
			"Compress closed stale conversation ranges into high-fidelity summaries",
		parameters: COMPRESS_SCHEMA,
		async execute(
			_toolCallId: string,
			params: CompressInput,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			if (
				!params ||
				!Array.isArray(params.ranges) ||
				params.ranges.length === 0
			) {
				throw new Error("compress requires at least one range");
			}

			const newBlockIds: number[] = [];
			const deactivatedBlockIds: number[] = [];
			const newBlocks: CompressionBlock[] = [];

			for (const range of params.ranges) {
				const startTimestamp = resolveIdToTimestamp(
					range.startId,
					"startTimestamp",
					state,
				);
				const endTimestamp = resolveIdToTimestamp(
					range.endId,
					"endTimestamp",
					state,
				);

				if (
					!Number.isFinite(startTimestamp) ||
					!Number.isFinite(endTimestamp)
				) {
					throw new Error(
						`Range ${range.startId}..${range.endId} resolved to non-finite timestamps`,
					);
				}
				if (startTimestamp > endTimestamp) {
					throw new Error(
						`Range start ${range.startId} must appear before end ${range.endId}`,
					);
				}

				const expandedSummary = expandBlockPlaceholders(range.summary, state);
				deactivatedBlockIds.push(
					...deactivateCoveredBlocks(startTimestamp, endTimestamp, state),
				);
				const metrics = rangeMetrics(startTimestamp, endTimestamp, state);

				const block: CompressionBlock = {
					id: state.nextBlockId++,
					topic: params.topic,
					summary: expandedSummary,
					startTimestamp,
					endTimestamp,
					anchorTimestamp: resolveAnchorTimestamp(endTimestamp, state),
					active: true,
					summaryTokenEstimate: estimateTokens(expandedSummary),
					compressedTokenEstimate: metrics.compressedTokens,
					directMessageCount: metrics.messageCount,
					directToolCount: metrics.toolCount,
					createdAt: Date.now(),
				};
				state.compressionBlocks.push(block);
				newBlockIds.push(block.id);
				newBlocks.push(block);
			}

			state.lastCompressAt = Date.now();
			state.lastCompressRangeCount = params.ranges.length;

			notifyCompression(
				pi,
				ctx,
				config,
				buildCompressionNotification(state, config, newBlocks, params.topic),
			);

			const deactivated =
				deactivatedBlockIds.length > 0
					? ` Deactivated nested block(s): ${deactivatedBlockIds.map((id) => `b${id}`).join(", ")}.`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `Compressed ${params.ranges.length} range(s): ${params.topic}.${deactivated}\n\n${CONTINUE_AFTER_COMPRESS}`,
					},
				],
				details: {
					blockIds: newBlockIds,
					deactivatedBlockIds,
					topic: params.topic,
				},
			};
		},
	});
}
