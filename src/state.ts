export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	inputArgs: Record<string, unknown>;
	inputFingerprint: string;
	isError: boolean;
	turnIndex: number;
	timestamp: number;
	tokenEstimate: number;
}

export interface CompressionBlock {
	id: number;
	topic: string;
	summary: string;
	startTimestamp: number;
	endTimestamp: number;
	anchorTimestamp: number;
	active: boolean;
	summaryTokenEstimate: number;
	compressedTokenEstimate: number;
	directMessageCount: number;
	directToolCount: number;
	createdAt: number;
	durationMs?: number;
}

export interface MessageSnapshot {
	timestamp: number;
	role: string;
	tokenEstimate: number;
	toolName?: string;
}

export interface StableDcpState {
	compressionBlocks: CompressionBlock[];
	nextBlockId: number;
	prunedToolIds: Set<string>;
	toolCalls: Map<string, ToolRecord>;
	messageIdSnapshot: Map<string, number>;
	messageTokenSnapshot: Map<number, MessageSnapshot>;
	currentTurn: number;
	tokensSaved: number;
	totalPruneCount: number;
	nudgeCounter: number;
	manualMode: boolean;
	lastCompressAt: number;
	lastCompressRangeCount: number;
}

export function createState(): StableDcpState {
	return {
		compressionBlocks: [],
		nextBlockId: 1,
		prunedToolIds: new Set(),
		toolCalls: new Map(),
		messageIdSnapshot: new Map(),
		messageTokenSnapshot: new Map(),
		currentTurn: 0,
		tokensSaved: 0,
		totalPruneCount: 0,
		nudgeCounter: 0,
		manualMode: false,
		lastCompressAt: 0,
		lastCompressRangeCount: 0,
	};
}

export function resetState(state: StableDcpState): void {
	state.compressionBlocks = [];
	state.nextBlockId = 1;
	state.prunedToolIds = new Set();
	state.toolCalls = new Map();
	state.messageIdSnapshot = new Map();
	state.messageTokenSnapshot = new Map();
	state.currentTurn = 0;
	state.tokensSaved = 0;
	state.totalPruneCount = 0;
	state.nudgeCounter = 0;
	state.manualMode = false;
	state.lastCompressAt = 0;
	state.lastCompressRangeCount = 0;
}

export function createInputFingerprint(
	toolName: string,
	input: Record<string, unknown>,
): string {
	return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}
