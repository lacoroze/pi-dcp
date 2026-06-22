declare const process: { env: Record<string, string | undefined> };

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StableDcpConfig {
	enabled: boolean;
	debug: boolean;
	manualMode: {
		enabled: boolean;
		automaticStrategies: boolean;
		allowCriticalNudge: boolean;
	};
	compress: {
		// pi compatibility knob. "housekeeping" maps to opencode's normal soft nudging behavior.
		autonomous: "off" | "critical" | "housekeeping";
		// opencode-compatible knobs.
		mode: "range" | "message";
		permission: "allow" | "ask" | "deny";
		showCompression: boolean;
		summaryBuffer: boolean;
		maxContextLimit: number | string;
		minContextLimit: number | string;
		nudgeFrequency: number;
		iterationNudgeThreshold: number;
		nudgeForce: "soft" | "strong";
		protectedTools: string[];
		protectUserMessages: boolean;
	};
	strategies: {
		deduplication: { enabled: boolean; protectedTools: string[] };
		purgeErrors: { enabled: boolean; turns: number; protectedTools: string[] };
	};
	protectedFilePatterns: string[];
	pruneNotification: "off" | "minimal" | "detailed";
	pruneNotificationType: "chat" | "toast";
}

export const DEFAULT_CONFIG: StableDcpConfig = {
	enabled: true,
	debug: false,
	manualMode: {
		enabled: false,
		automaticStrategies: true,
		allowCriticalNudge: true,
	},
	compress: {
		autonomous: "housekeeping",
		mode: "range",
		permission: "allow",
		showCompression: false,
		summaryBuffer: true,
		maxContextLimit: 100000,
		minContextLimit: 50000,
		nudgeFrequency: 5,
		iterationNudgeThreshold: 15,
		nudgeForce: "soft",
		protectedTools: ["task", "skill", "todo", "todoread", "todowrite"],
		protectUserMessages: false,
	},
	strategies: {
		deduplication: {
			enabled: true,
			protectedTools: ["compress", "write", "edit"],
		},
		purgeErrors: {
			enabled: true,
			turns: 4,
			protectedTools: [],
		},
	},
	protectedFilePatterns: [],
	pruneNotification: "detailed",
	pruneNotificationType: "chat",
};

const DEFAULT_CONFIG_FILE = `{
  // pi-dcp-stable configuration
  // Defaults intentionally mirror opencode-dcp's normal pruning UX.
  //
  // "manualMode": { "enabled": false, "automaticStrategies": true, "allowCriticalNudge": true },
  // "compress": {
  //   "autonomous": "housekeeping", // off | critical | housekeeping
  //   "mode": "range",
  //   "permission": "allow",
  //   "showCompression": false,
  //   "summaryBuffer": true,
  //   "maxContextLimit": 100000,
  //   "minContextLimit": 50000,
  //   "nudgeFrequency": 5,
  //   "iterationNudgeThreshold": 15,
  //   "nudgeForce": "soft",
  //   "protectedTools": ["task", "skill", "todo", "todoread", "todowrite"],
  //   "protectUserMessages": false
  // },
  // "strategies": {
  //   "deduplication": { "enabled": true, "protectedTools": [] },
  //   "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] }
  // },
  // "pruneNotification": "detailed",
  // "pruneNotificationType": "chat"
}
`;

function deepMerge<T>(base: T, override: Partial<T>): T {
	if (override === null || override === undefined) return base;
	if (typeof base !== "object" || typeof override !== "object")
		return override as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const key of Object.keys(override as Record<string, unknown>)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = (override as Record<string, unknown>)[key];
		if (Array.isArray(baseVal) && Array.isArray(overVal)) {
			out[key] = [...new Set([...baseVal, ...overVal])];
		} else if (
			baseVal &&
			overVal &&
			typeof baseVal === "object" &&
			typeof overVal === "object" &&
			!Array.isArray(baseVal) &&
			!Array.isArray(overVal)
		) {
			out[key] = deepMerge(
				baseVal as Record<string, unknown>,
				overVal as Record<string, unknown>,
			);
		} else if (overVal !== undefined) {
			out[key] = overVal;
		}
	}
	return out as T;
}

function stripJsonComments(raw: string): string {
	return raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function readJsonc(file: string): Record<string, unknown> {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const trimmed = stripJsonComments(raw).trim();
		if (!trimmed) return {};
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}

function ensureGlobalConfig(file: string): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (!fs.existsSync(file))
			fs.writeFileSync(file, DEFAULT_CONFIG_FILE, "utf8");
	} catch {
		// Best effort only.
	}
}

function findProjectConfig(startDir: string): string | null {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, ".pi", "dcp-stable.jsonc");
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function loadConfig(projectDir: string): StableDcpConfig {
	let config = deepMerge(DEFAULT_CONFIG, {});

	const globalPath = path.join(
		os.homedir(),
		".config",
		"pi",
		"dcp-stable.jsonc",
	);
	ensureGlobalConfig(globalPath);
	config = deepMerge(config, readJsonc(globalPath) as Partial<StableDcpConfig>);

	const envDir = process.env.PI_DCP_CONFIG_DIR;
	if (envDir) {
		config = deepMerge(
			config,
			readJsonc(
				path.join(envDir, "dcp-stable.jsonc"),
			) as Partial<StableDcpConfig>,
		);
	}

	const projectPath = findProjectConfig(projectDir);
	if (projectPath) {
		config = deepMerge(
			config,
			readJsonc(projectPath) as Partial<StableDcpConfig>,
		);
	}

	config.compress.nudgeFrequency = Math.max(
		1,
		Number(config.compress.nudgeFrequency || 1),
	);
	config.compress.iterationNudgeThreshold = Math.max(
		1,
		Number(config.compress.iterationNudgeThreshold || 1),
	);
	config.strategies.purgeErrors.turns = Math.max(
		1,
		Number(config.strategies.purgeErrors.turns || 1),
	);
	if (
		!["off", "critical", "housekeeping"].includes(config.compress.autonomous)
	) {
		config.compress.autonomous = "housekeeping";
	}
	if (!["range", "message"].includes(config.compress.mode)) {
		config.compress.mode = "range";
	}
	if (!["allow", "ask", "deny"].includes(config.compress.permission)) {
		config.compress.permission = "allow";
	}
	if (!["soft", "strong"].includes(config.compress.nudgeForce)) {
		config.compress.nudgeForce = "soft";
	}
	if (!["off", "minimal", "detailed"].includes(config.pruneNotification)) {
		config.pruneNotification = "detailed";
	}
	if (!["chat", "toast"].includes(config.pruneNotificationType)) {
		config.pruneNotificationType = "chat";
	}
	return config;
}

export function resolveLimit(
	limit: number | string,
	contextWindow: number,
	fallbackRatio: number,
): number {
	if (typeof limit === "number" && Number.isFinite(limit) && limit > 0)
		return limit;
	if (typeof limit === "string") {
		const trimmed = limit.trim();
		if (trimmed.endsWith("%")) {
			const pct = Number(trimmed.slice(0, -1));
			if (Number.isFinite(pct) && pct > 0)
				return Math.floor((contextWindow * pct) / 100);
		}
		const numeric = Number(trimmed);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
	}
	return Math.floor(contextWindow * fallbackRatio);
}
