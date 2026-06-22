import type { StableDcpConfig } from "./config.js";
import type { StableDcpState } from "./state.js";
import { compressionSummary } from "./pruner.js";

type ExtensionAPI = any;
type CommandContext = {
	waitForIdle?: () => Promise<void>;
	ui: {
		notify(message: string, level?: string): void;
		setStatus?(key: string, value?: string): void;
	};
	getContextUsage?: () =>
		| { tokens: number | null; contextWindow: number }
		| undefined;
};

function fmt(n: number): string {
	return Math.round(n).toLocaleString();
}

function contextText(ctx: CommandContext, state: StableDcpState): string {
	const usage = ctx.getContextUsage?.();
	const lines: string[] = [];
	if (usage && usage.tokens !== null) {
		const pct = ((usage.tokens / usage.contextWindow) * 100).toFixed(1);
		lines.push(
			`Context: ${pct}% (${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens)`,
		);
	} else if (usage) {
		lines.push(`Context: unknown / ${fmt(usage.contextWindow)} tokens`);
	} else {
		lines.push("Context: unavailable");
	}
	lines.push(
		`Active compression blocks: ${state.compressionBlocks.filter((b) => b.active).length}`,
	);
	lines.push(`Pruned tool outputs: ${state.prunedToolIds.size}`);
	lines.push(`Tracked tool calls: ${state.toolCalls.size}`);
	lines.push(`Estimated tokens saved: ${fmt(state.tokensSaved)}`);
	lines.push(`Manual mode: ${state.manualMode ? "on" : "off"}`);
	return lines.join("\n");
}

function statsText(state: StableDcpState): string {
	const active = state.compressionBlocks.filter((b) => b.active);
	const lines = [
		"pi-dcp-stable stats:",
		`  Active blocks: ${active.length} / ${state.compressionBlocks.length}`,
		`  Estimated tokens saved: ${fmt(state.tokensSaved)}`,
		`  Total prune operations: ${fmt(state.totalPruneCount)}`,
		`  Tracked tool calls: ${fmt(state.toolCalls.size)}`,
		`  Manual mode: ${state.manualMode ? "on" : "off"}`,
	];
	if (active.length) {
		lines.push("", "Active blocks:");
		for (const block of active) lines.push(`  ${compressionSummary(block)}`);
	}
	return lines.join("\n");
}

async function sweepRecentTools(
	ctx: CommandContext,
	state: StableDcpState,
	config: StableDcpConfig,
	count: number,
): Promise<void> {
	await ctx.waitForIdle?.();
	const protectedTools = new Set([
		"compress",
		"write",
		"edit",
		...config.strategies.deduplication.protectedTools,
	]);
	const records = [...state.toolCalls.values()].sort(
		(a, b) => a.timestamp - b.timestamp,
	);
	const selected =
		count > 0
			? records.slice(-count)
			: records.filter((record) => record.turnIndex >= state.currentTurn - 1);
	let swept = 0;
	for (const record of selected) {
		if (protectedTools.has(record.toolName)) continue;
		if (!state.prunedToolIds.has(record.toolCallId)) {
			state.prunedToolIds.add(record.toolCallId);
			state.totalPruneCount++;
			swept++;
		}
	}
	ctx.ui.notify(`Swept ${swept} tool output${swept === 1 ? "" : "s"}`, "info");
}

function decompress(
	ctx: CommandContext,
	state: StableDcpState,
	rawId: string | undefined,
): void {
	if (!rawId) {
		const active = state.compressionBlocks.filter((block) => block.active);
		if (!active.length) {
			ctx.ui.notify("No active compression blocks.", "info");
			return;
		}
		ctx.ui.notify(
			[
				"Active compression blocks:",
				...active.map((block) => `  ${compressionSummary(block)}`),
				"",
				"Run /dcp decompress N to restore.",
			].join("\n"),
			"info",
		);
		return;
	}
	const id = Number(String(rawId).replace(/^b/i, ""));
	const block = state.compressionBlocks.find(
		(candidate) => candidate.id === id,
	);
	if (!block) {
		ctx.ui.notify(`No compression block found: ${rawId}`, "error");
		return;
	}
	if (!block.active) {
		ctx.ui.notify(`Block b${id} is already decompressed.`, "info");
		return;
	}
	block.active = false;
	ctx.ui.notify(`Decompressed b${id}: ${block.topic}`, "info");
}

function recompress(
	ctx: CommandContext,
	state: StableDcpState,
	rawId: string | undefined,
): void {
	if (!rawId) {
		const inactive = state.compressionBlocks.filter((block) => !block.active);
		if (!inactive.length) {
			ctx.ui.notify("No decompressed blocks to recompress.", "info");
			return;
		}
		ctx.ui.notify(
			[
				"Recompressible blocks:",
				...inactive.map((block) => `  ${compressionSummary(block)}`),
			].join("\n"),
			"info",
		);
		return;
	}
	const id = Number(String(rawId).replace(/^b/i, ""));
	const block = state.compressionBlocks.find(
		(candidate) => candidate.id === id,
	);
	if (!block) {
		ctx.ui.notify(`No compression block found: ${rawId}`, "error");
		return;
	}
	if (block.active) {
		ctx.ui.notify(`Block b${id} is already active.`, "info");
		return;
	}
	block.active = true;
	ctx.ui.notify(`Recompressed b${id}: ${block.topic}`, "info");
}

function commandDefinition(
	pi: ExtensionAPI,
	state: StableDcpState,
	config: StableDcpConfig,
) {
	const description =
		"DCP commands: context, stats, manual, compress, decompress, recompress, sweep";
	const items = [
		"context",
		"stats",
		"manual",
		"compress",
		"decompress",
		"recompress",
		"sweep",
		"help",
	];
	return {
		description,
		getArgumentCompletions(prefix: string) {
			return items
				.filter((item) => item.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		async handler(args: string, ctx: CommandContext) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] || "help").toLowerCase();
			if (sub === "help") {
				ctx.ui.notify(
					[
						"DCP commands:",
						"  /dcp context",
						"  /dcp stats",
						"  /dcp manual [on|off]",
						"  /dcp compress [focus]",
						"  /dcp decompress [N]",
						"  /dcp recompress [N]",
						"  /dcp sweep [N]",
						"",
						"/dcp-stable is kept as a compatibility alias.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "context") {
				ctx.ui.notify(contextText(ctx, state), "info");
				return;
			}
			if (sub === "stats") {
				ctx.ui.notify(statsText(state), "info");
				return;
			}
			if (sub === "manual") {
				const next = parts[1]?.toLowerCase();
				if (next === "on") state.manualMode = true;
				else if (next === "off") state.manualMode = false;
				ctx.ui.notify(
					`Manual mode: ${state.manualMode ? "on" : "off"}`,
					"info",
				);
				return;
			}
			if (sub === "decompress") {
				decompress(ctx, state, parts[1]);
				return;
			}
			if (sub === "recompress") {
				recompress(ctx, state, parts[1]);
				return;
			}
			if (sub === "sweep") {
				const count = Math.max(0, Number(parts[1] || 0) || 0);
				await sweepRecentTools(ctx, state, config, count);
				return;
			}
			if (sub === "compress") {
				await ctx.waitForIdle?.();
				const focus = parts.slice(1).join(" ").trim();
				pi.sendMessage(
					{
						customType: "pi-dcp-stable-trigger",
						content: `The user explicitly requested DCP compression.${focus ? ` Focus: ${focus}` : ""} Compress only closed stale ranges, then continue the user-facing answer if one was pending.`,
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				ctx.ui.notify("Triggered explicit DCP compression.", "info");
				return;
			}
			ctx.ui.notify(`Unknown /dcp command: ${sub}`, "error");
		},
	};
}

export function registerCommands(
	pi: ExtensionAPI,
	state: StableDcpState,
	config: StableDcpConfig,
): void {
	const definition = commandDefinition(pi, state, config);
	pi.registerCommand("dcp", definition);
	pi.registerCommand("dcp-stable", definition);
}
