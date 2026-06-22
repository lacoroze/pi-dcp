import type { CompressionBlock, StableDcpState } from "./state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ExtensionAPI = any;
type ToolContext = any;

type RawMessage = {
	entryId: string;
	timestamp: number;
	isoTimestamp: string;
	role: string;
	toolName?: string;
	text: string;
};

interface ExpandBlockInput {
	blockId: string | number;
	query?: string;
	maxChars?: number;
}

interface SearchRawInput {
	query: string;
	blockId?: string | number;
	limit?: number;
	maxChars?: number;
}

const DEFAULT_MAX_CHARS = 6000;
const HARD_MAX_CHARS = 20000;
const DEFAULT_SEARCH_LIMIT = 8;

export const EXPAND_BLOCK_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["blockId"],
	properties: {
		blockId: {
			description: "Compressed DCP block id visible in the conversation, e.g. b2 or 2.",
			anyOf: [{ type: "string" }, { type: "number" }],
		},
		query: {
			type: "string",
			description:
				"Optional focused question/search terms. When present, only the most relevant raw snippets from the compressed block are returned.",
		},
		maxChars: {
			type: "number",
			description: `Approximate maximum characters to return. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.`,
		},
	},
} as any;

export const SEARCH_COMPRESSED_RAW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["query"],
	properties: {
		query: {
			type: "string",
			description: "Search terms for raw messages inside compressed DCP blocks.",
		},
		blockId: {
			description: "Optional compressed DCP block id to restrict the search, e.g. b2 or 2.",
			anyOf: [{ type: "string" }, { type: "number" }],
		},
		limit: {
			type: "number",
			description: `Maximum matching messages to return. Default ${DEFAULT_SEARCH_LIMIT}.`,
		},
		maxChars: {
			type: "number",
			description: `Approximate maximum characters to return. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.`,
		},
	},
} as any;

function clampMaxChars(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
	return Math.max(1000, Math.min(HARD_MAX_CHARS, Math.floor(n)));
}

function clampLimit(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
	return Math.max(1, Math.min(50, Math.floor(n)));
}

function normalizeBlockId(raw: string | number | undefined): number | null {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
	const text = String(raw ?? "").trim();
	const match = /^b?(\d+)$/i.exec(text);
	return match ? Number(match[1]) : null;
}

function findBlock(
	state: StableDcpState,
	blockId: string | number | undefined,
): CompressionBlock | null {
	const id = normalizeBlockId(blockId);
	if (!id) return null;
	return state.compressionBlocks.find((block) => block.id === id) ?? null;
}

function cleanText(text: string): string {
	return text
		.replace(/\n?<dcp-id>m\d{3}<\/dcp-id>/g, "")
		.replace(/\n?<dcp-block-id>b\d+<\/dcp-block-id>/g, "")
		.replace(/<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g, "")
		.trim();
}

function compactJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (typeof p.text === "string") parts.push(p.text);
		else if (typeof p.thinking === "string") parts.push(`[thinking]\n${p.thinking}`);
		else if (p.type === "toolCall") {
			const name = typeof p.name === "string" ? p.name : "tool";
			parts.push(`[toolCall ${name}] ${compactJson(p.arguments ?? {})}`);
		}
		else if (p.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function messageText(message: any): string {
	if (!message) return "";
	if (message.role === "bashExecution") {
		const command = typeof message.command === "string" ? message.command : "";
		const output = typeof message.output === "string" ? message.output : "";
		return [command ? `$ ${command}` : "", output].filter(Boolean).join("\n");
	}
	return contentText(message.content);
}

function entryTimestamp(entry: any, message: any): number {
	const mt = Number(message?.timestamp);
	if (Number.isFinite(mt)) return mt;
	const parsed = Date.parse(String(entry?.timestamp ?? ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

function rawMessagesFromBranch(ctx: ToolContext): RawMessage[] {
	const branch = ctx?.sessionManager?.getBranch?.() ?? [];
	const out: RawMessage[] = [];
	for (const entry of branch) {
		let message: any = null;
		if (entry?.type === "message") message = entry.message;
		else if (entry?.type === "custom_message") {
			message = {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				timestamp: Date.parse(String(entry.timestamp ?? "")),
			};
		}
		else if (entry?.type === "compaction") {
			message = {
				role: "compactionSummary",
				content: entry.summary,
				timestamp: Date.parse(String(entry.timestamp ?? "")),
			};
		}
		else if (entry?.type === "branch_summary") {
			message = {
				role: "branchSummary",
				content: entry.summary,
				timestamp: Date.parse(String(entry.timestamp ?? "")),
			};
		}
		if (!message) continue;
		const timestamp = entryTimestamp(entry, message);
		if (!Number.isFinite(timestamp)) continue;
		const role = String(message.role || entry.type || "message");
		const text = cleanText(messageText(message));
		if (!text) continue;
		out.push({
			entryId: String(entry.id || ""),
			timestamp,
			isoTimestamp: new Date(timestamp).toISOString(),
			role,
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			text,
		});
	}
	return out.sort((a, b) => a.timestamp - b.timestamp);
}

function messagesForBlock(ctx: ToolContext, block: CompressionBlock): RawMessage[] {
	const messages = rawMessagesFromBranch(ctx);
	return messages.filter(
		(message) =>
			block.startTimestamp <= message.timestamp &&
			message.timestamp <= block.endTimestamp,
	);
}

function termsForQuery(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}_./:-]+/u)
				.map((term) => term.trim())
				.filter((term) => term.length >= 2),
		),
	);
}

function scoreMessage(message: RawMessage, terms: string[]): number {
	if (!terms.length) return 0;
	const hay = `${message.role}\n${message.toolName ?? ""}\n${message.text}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		let idx = hay.indexOf(term);
		while (idx >= 0) {
			score += term.length >= 5 ? 3 : 1;
			idx = hay.indexOf(term, idx + term.length);
		}
	}
	return score;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 20) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 20).trimEnd()}\n…[truncated]`;
}

function formatMessage(message: RawMessage, maxTextChars: number): string {
	const role = message.toolName
		? `${message.role}:${message.toolName}`
		: message.role;
	return `### ${message.isoTimestamp} · ${role} · ${message.entryId}\n${truncate(message.text, maxTextChars)}`;
}

function fitSections(header: string, sections: string[], maxChars: number): string {
	const out: string[] = [header.trim()];
	let used = out[0].length + 2;
	let omitted = 0;
	for (const section of sections) {
		const nextLen = section.length + 2;
		if (used + nextLen > maxChars) {
			omitted++;
			continue;
		}
		out.push(section);
		used += nextLen;
	}
	if (omitted > 0) out.push(`…omitted ${omitted} additional raw message(s) due to maxChars.`);
	return out.join("\n\n").trim();
}

function formatBlockHeader(block: CompressionBlock, messages: RawMessage[], query?: string): string {
	const status = block.active ? "active" : "inactive";
	const queryLine = query?.trim() ? `\nQuery: ${query.trim()}` : "";
	return [
		`DCP raw expansion for b${block.id} — ${block.topic} (${status})`,
		`Range: ${new Date(block.startTimestamp).toISOString()} → ${new Date(block.endTimestamp).toISOString()}`,
		`Raw messages found in current branch: ${messages.length}`,
		queryLine.trim(),
	]
		.filter(Boolean)
		.join("\n");
}

function selectedMessagesForQuery(
	messages: RawMessage[],
	query: string,
	limit: number,
): { selected: RawMessage[]; matched: boolean } {
	const terms = termsForQuery(query);
	if (!terms.length) return { selected: messages.slice(0, limit), matched: false };
	const scored = messages
		.map((message) => ({ message, score: scoreMessage(message, terms) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.message.timestamp - b.message.timestamp);
	if (!scored.length) return { selected: messages.slice(0, limit), matched: false };
	return {
		selected: scored
			.slice(0, limit)
			.map((item) => item.message)
			.sort((a, b) => a.timestamp - b.timestamp),
		matched: true,
	};
}

function expandBlockText(
	ctx: ToolContext,
	state: StableDcpState,
	params: ExpandBlockInput,
): { text: string; details: Record<string, unknown> } {
	const block = findBlock(state, params.blockId);
	if (!block) throw new Error(`Unknown DCP block id: ${String(params.blockId)}`);
	const maxChars = clampMaxChars(params.maxChars);
	const messages = messagesForBlock(ctx, block);
	const query = String(params.query ?? "").trim();
	const perMessageMax = Math.max(800, Math.min(4000, Math.floor(maxChars / 3)));
	const selected = query
		? selectedMessagesForQuery(messages, query, DEFAULT_SEARCH_LIMIT)
		: { selected: messages, matched: false };
	const note = query && !selected.matched
		? "No exact query matches were found inside this block; returning chronological preview instead."
		: "";
	const header = [formatBlockHeader(block, messages, query), note].filter(Boolean).join("\n");
	const sections = selected.selected.map((message) => formatMessage(message, perMessageMax));
	return {
		text: fitSections(header, sections, maxChars),
		details: {
			blockId: block.id,
			topic: block.topic,
			active: block.active,
			messageCount: messages.length,
			returnedCount: selected.selected.length,
			query: query || undefined,
			matched: query ? selected.matched : undefined,
		},
	};
}

function searchCompressedRawText(
	ctx: ToolContext,
	state: StableDcpState,
	params: SearchRawInput,
): { text: string; details: Record<string, unknown> } {
	const query = String(params.query ?? "").trim();
	if (!query) throw new Error("dcp_search_compressed_raw requires a non-empty query");
	const maxChars = clampMaxChars(params.maxChars);
	const limit = clampLimit(params.limit);
	const restrictedBlock = params.blockId === undefined ? null : findBlock(state, params.blockId);
	if (params.blockId !== undefined && !restrictedBlock)
		throw new Error(`Unknown DCP block id: ${String(params.blockId)}`);
	const blocks = restrictedBlock ? [restrictedBlock] : state.compressionBlocks;
	const terms = termsForQuery(query);
	const results: Array<{ block: CompressionBlock; message: RawMessage; score: number }> = [];
	for (const block of blocks) {
		for (const message of messagesForBlock(ctx, block)) {
			const score = scoreMessage(message, terms);
			if (score > 0) results.push({ block, message, score });
		}
	}
	results.sort((a, b) => b.score - a.score || a.message.timestamp - b.message.timestamp);
	const selected = results.slice(0, limit).sort((a, b) => a.message.timestamp - b.message.timestamp);
	const header = [
		`DCP compressed raw search`,
		`Query: ${query}`,
		`Blocks searched: ${blocks.map((block) => `b${block.id}`).join(", ") || "none"}`,
		`Matches returned: ${selected.length}${results.length > selected.length ? ` of ${results.length}` : ""}`,
	].join("\n");
	const perMessageMax = Math.max(500, Math.min(2500, Math.floor(maxChars / 4)));
	const sections = selected.map(
		({ block, message, score }) =>
			`## b${block.id} — ${block.topic} · score ${score}\n${formatMessage(message, perMessageMax)}`,
	);
	return {
		text: fitSections(header, sections, maxChars),
		details: {
			query,
			blockId: restrictedBlock?.id,
			blocksSearched: blocks.map((block) => block.id),
			matchCount: results.length,
			returnedCount: selected.length,
		},
	};
}

export function registerExpandTools(pi: ExtensionAPI, state: StableDcpState): void {
	pi.registerTool({
		name: "dcp_expand_block",
		label: "Expand DCP Block",
		description:
			"Inspect targeted raw history for a visible pi-dcp-stable compressed block. Use only when the existing compressed summary is insufficient; prefer a focused query over expanding the whole block.",
		promptSnippet:
			"Inspect targeted raw snippets for a visible DCP compressed block when its summary is insufficient",
		promptGuidelines: [
			"Use dcp_expand_block only when a visible DCP compressed summary is insufficient to answer safely; prefer a focused query and avoid requesting full raw history.",
		],
		parameters: EXPAND_BLOCK_SCHEMA,
		async execute(
			_toolCallId: string,
			params: ExpandBlockInput,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const result = expandBlockText(ctx, state, params);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerTool({
		name: "dcp_search_compressed_raw",
		label: "Search DCP Raw",
		description:
			"Search raw messages inside pi-dcp-stable compressed blocks. Use only when visible DCP summaries are insufficient and you need targeted details from compressed history.",
		promptSnippet:
			"Search targeted raw snippets inside DCP compressed history when summaries are insufficient",
		promptGuidelines: [
			"Use dcp_search_compressed_raw only for targeted lookup across compressed DCP blocks; do not use it for routine context review when visible summaries are enough.",
		],
		parameters: SEARCH_COMPRESSED_RAW_SCHEMA,
		async execute(
			_toolCallId: string,
			params: SearchRawInput,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const result = searchCompressedRawText(ctx, state, params);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});
}
