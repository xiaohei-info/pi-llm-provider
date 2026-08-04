/**
 * Configurable dynamic LLM gateway provider for Pi.
 * https://github.com/xiaohei-info/pi-llm-provider
 *
 * Fetches model list from a NewAPI / OpenAI-compatible gateway at startup so
 * multiple machines stay in sync without hand-editing models.json.
 *
 * Config (env wins over file):
 *   LLM_API_KEY    (required) API key
 *   LLM_BASE_URL   (required) gateway origin, with or without /v1
 *   LLM_PROVIDER   (optional) Pi provider id, default "llm"
 *
 * File: ~/.pi/agent/llm-provider.env
 * Back-compat: NEWAPI_* env keys and ~/.pi/agent/newapi.env
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages";

type ModelDef = {
	id: string;
	name: string;
	api: ApiKind;
	baseUrl?: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: Array<{
			inputTokensAbove: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
		}>;
	};
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
};

type Override = Partial<Omit<ModelDef, "id" | "name" | "cost">> & {
	name?: string;
	/**
	 * When true, this entry's contextWindow/maxTokens always win over the
	 * OpenRouter live lookup (e.g. to stay inside a short-context pricing tier).
	 */
	pinLimits?: boolean;
	cost?: ModelDef["cost"];
};

const DEFAULT_PROVIDER = "llm";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LOG_PREFIX = "[llm-provider]";

const GPT_THINK = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
} as const;

const GPT_THINK_MAX = { ...GPT_THINK, max: "max" } as const;

const DEEPSEEK_THINK = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

const GLM_THINK = {
	minimal: null,
	low: "high",
	medium: "high",
	high: "high",
	xhigh: null,
	max: "max",
} as const;

/** Hand-tuned metadata for important models. Unknown models use heuristics. */
const OVERRIDES: Record<string, Override> = {
	"gpt-5.6-sol": {
		api: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK_MAX },
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
		},
	},
	"gpt-5.6-terra": {
		api: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK_MAX },
		cost: {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 3.125,
			tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 6.25 }],
		},
	},
	"gpt-5.6-luna": {
		api: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK_MAX },
		cost: {
			input: 1,
			output: 6,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			tiers: [{ inputTokensAbove: 272000, input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5 }],
		},
	},
	"gpt-5.5": {
		api: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK },
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
		},
	},
	"gpt-5.4": {
		api: "openai-responses",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK },
		cost: {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
		},
	},
	"gpt-5.4-mini": {
		api: "openai-responses",
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: { ...GPT_THINK },
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	},
	"gpt-5.3-codex-spark": {
		api: "openai-responses",
		contextWindow: 128000,
		maxTokens: 32000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictMode: true, supportsReasoningEffort: true },
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
	},
	"claude-opus-4-8": {
		api: "anthropic-messages",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	"claude-sonnet-5": {
		api: "anthropic-messages",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	},
	"claude-fable-5": {
		api: "anthropic-messages",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	},
	"claude-haiku-4-5": {
		api: "anthropic-messages",
		contextWindow: 200000,
		maxTokens: 64000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictTools: true },
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	"claude-haiku-4-5-20251001": {
		api: "anthropic-messages",
		contextWindow: 200000,
		maxTokens: 64000,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsStrictTools: true },
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	"deepseek-v4-pro": {
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 384000,
		reasoning: true,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
		thinkingLevelMap: { ...DEEPSEEK_THINK },
		cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
	},
	"deepseek-v4-flash": {
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 384000,
		reasoning: true,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
		thinkingLevelMap: { ...DEEPSEEK_THINK },
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	},
	"kimi-k2.7": {
		api: "openai-completions",
		contextWindow: 262144,
		maxTokens: 262144,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
		},
		thinkingLevelMap: { off: null },
	},
	"glm-5.2": {
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 131072,
		reasoning: true,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
		},
		thinkingLevelMap: { ...GLM_THINK },
	},
	"gemini-3.1-pro": {
		api: "openai-completions",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
	},
	"gemini-3.5-flash": {
		api: "openai-completions",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
		thinkingLevelMap: { off: null },
		cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
	},
	"grok-4.5": {
		api: "openai-completions",
		contextWindow: 500000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		},
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
		cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	},
	"minimax-m3": {
		api: "openai-completions",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	},
	"minimax-m2.5": {
		api: "openai-completions",
		contextWindow: 204800,
		maxTokens: 131072,
		reasoning: true,
		input: ["text"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	"qwen3.8-max": {
		api: "openai-completions",
		contextWindow: 1048576,
		maxTokens: 131072,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	"composer-2.5": {
		api: "openai-completions",
		contextWindow: 200000,
		maxTokens: 64000,
		reasoning: true,
		input: ["text", "image"],
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
};

function normalizeBase(raw: string): string {
	return raw.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function normalizeProviderId(raw: string): string {
	const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
	return id || DEFAULT_PROVIDER;
}

/** Parse KEY=value lines from a dotenv-style file. */
function parseDotEnv(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

/**
 * Load config files. Later files override earlier ones.
 * Priority (low → high): newapi.env → llm-provider.env → process.env
 */
function loadConfigFiles(): Record<string, string> {
	const agentDir = join(homedir(), ".pi", "agent");
	return {
		...parseDotEnv(join(agentDir, "newapi.env")),
		...parseDotEnv(join(agentDir, "llm-provider.env")),
	};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const v of values) {
		const t = v?.trim();
		if (t) return t;
	}
	return undefined;
}

function resolveConfig(): { apiKey?: string; base?: string; provider: string } {
	const file = loadConfigFiles();

	const apiKey = firstNonEmpty(
		process.env.LLM_API_KEY,
		process.env.NEWAPI_API_KEY,
		file.LLM_API_KEY,
		file.NEWAPI_API_KEY,
	);

	const baseRaw = firstNonEmpty(
		process.env.LLM_BASE_URL,
		process.env.NEWAPI_BASE_URL,
		file.LLM_BASE_URL,
		file.NEWAPI_BASE_URL,
	);

	const provider = normalizeProviderId(
		firstNonEmpty(
			process.env.LLM_PROVIDER,
			process.env.NEWAPI_PROVIDER,
			file.LLM_PROVIDER,
			file.NEWAPI_PROVIDER,
			DEFAULT_PROVIDER,
		) ?? DEFAULT_PROVIDER,
	);

	const base = baseRaw ? normalizeBase(baseRaw) : undefined;

	// Expose resolved values for any downstream $ENV expansion.
	if (apiKey) {
		process.env.LLM_API_KEY ??= apiKey;
		process.env.NEWAPI_API_KEY ??= apiKey;
	}
	if (base) {
		process.env.LLM_BASE_URL ??= base;
		process.env.NEWAPI_BASE_URL ??= base;
	}
	process.env.LLM_PROVIDER ??= provider;

	return { apiKey, base, provider };
}

function titleize(id: string): string {
	return id
		.split(/[-_/]+/)
		.filter(Boolean)
		.map((part) => {
			if (/^\d+(\.\d+)*$/.test(part)) return part;
			if (/^[a-z0-9]+$/i.test(part) && part.length <= 4 && /[0-9]/.test(part)) return part.toUpperCase();
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function isImageModel(id: string): boolean {
	const x = id.toLowerCase();
	return (
		x.includes("image") ||
		x.includes("dall-e") ||
		x.includes("gpt-image") ||
		x.includes("flux") ||
		x.includes("stable-diffusion") ||
		x.endsWith("-tts") ||
		x.includes("whisper") ||
		x.includes("embedding") ||
		x.includes("moderation")
	);
}

function heuristic(id: string): Omit<ModelDef, "id" | "name" | "cost" | "baseUrl"> & { cost: ModelDef["cost"] } {
	const x = id.toLowerCase();

	if (x.includes("claude")) {
		return {
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: x.includes("haiku") ? 200000 : 1000000,
			maxTokens: x.includes("haiku") ? 64000 : 128000,
			cost: ZERO_COST,
			compat: {
				supportsStrictTools: true,
				...(x.includes("opus") || x.includes("sonnet") || x.includes("fable")
					? { forceAdaptiveThinking: true }
					: {}),
			},
		};
	}

	if (x.startsWith("gpt-") || x.includes("codex")) {
		return {
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
			cost: ZERO_COST,
			compat: { supportsStrictMode: true, supportsReasoningEffort: true },
			thinkingLevelMap: { ...GPT_THINK },
		};
	}

	if (x.includes("deepseek")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 1000000,
			maxTokens: 384000,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				maxTokensField: "max_tokens",
			},
			thinkingLevelMap: { ...DEEPSEEK_THINK },
		};
	}

	if (x.includes("kimi") || x.includes("moonshot")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 262144,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				thinkingFormat: "deepseek",
			},
		};
	}

	if (x.includes("glm") || x.startsWith("chatglm")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 1000000,
			maxTokens: 131072,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "zai",
			},
			thinkingLevelMap: { ...GLM_THINK },
		};
	}

	if (x.includes("gemini")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		};
	}

	if (x.includes("grok")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500000,
			maxTokens: 128000,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		};
	}

	if (x.includes("minimax")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 128000,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		};
	}

	if (x.includes("qwen") || x.includes("tongyi")) {
		return {
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 32768,
			cost: ZERO_COST,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		};
	}

	// Default: OpenAI-compatible chat completions
	return {
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: ZERO_COST,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	};
}

type OrLimits = { contextWindow: number; maxTokens?: number };
type OrIndex = Map<string, OrLimits>;

/**
 * Best-effort lookup of context windows from OpenRouter's public model index
 * (no auth required). Primary source of contextWindow/maxTokens for every
 * model; OVERRIDES and heuristics only fill gaps when the lookup misses
 * (e.g. relay-only model names or network failure).
 */
async function fetchOpenRouterIndex(timeoutMs = 8000): Promise<OrIndex> {
	const index: OrIndex = new Map();
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch("https://openrouter.ai/api/v1/models", {
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return index;
		const payload = (await res.json()) as {
			data?: Array<{
				id?: string;
				context_length?: number;
				top_provider?: { max_completion_tokens?: number };
			}>;
		};
		for (const m of payload.data ?? []) {
			if (!m.id || typeof m.context_length !== "number") continue;
			const entry: OrLimits = { contextWindow: m.context_length };
			const maxOut = m.top_provider?.max_completion_tokens;
			if (typeof maxOut === "number" && maxOut > 0) entry.maxTokens = maxOut;
			const bare = m.id.split("/").pop();
			if (bare) index.set(bare.toLowerCase(), entry);
			index.set(m.id.toLowerCase(), entry);
		}
	} catch {
		// Best effort: network failure must never block provider registration.
	}
	return index;
}

function buildModel(id: string, base: string, orIndex: OrIndex): ModelDef | undefined {
	if (isImageModel(id)) return undefined;

	const ov = OVERRIDES[id] ?? {};
	const or = ov.pinLimits ? undefined : orIndex.get(id.toLowerCase());
	const h = heuristic(id);
	const api = (ov.api ?? h.api) as ApiKind;
	const openAiBase = `${base}/v1`;
	const anthropicBase = base;

	const model: ModelDef = {
		id,
		name: ov.name ?? titleize(id),
		api,
		baseUrl: api === "anthropic-messages" ? anthropicBase : openAiBase,
		reasoning: ov.reasoning ?? h.reasoning,
		input: ov.input ?? h.input,
		contextWindow: or?.contextWindow ?? ov.contextWindow ?? h.contextWindow,
		maxTokens: or?.maxTokens ?? ov.maxTokens ?? h.maxTokens,
		cost: ov.cost ?? h.cost ?? ZERO_COST,
	};

	const compat = ov.compat ?? h.compat;
	const thinkingLevelMap = ov.thinkingLevelMap ?? h.thinkingLevelMap;
	if (compat) model.compat = compat;
	if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
	return model;
}

export default async function (pi: ExtensionAPI) {
	const { apiKey, base, provider } = resolveConfig();

	if (!apiKey || !base) {
		const missing = [
			!apiKey ? "LLM_API_KEY" : null,
			!base ? "LLM_BASE_URL" : null,
		]
			.filter(Boolean)
			.join(", ");
		console.error(
			`${LOG_PREFIX} missing ${missing} (set env or ~/.pi/agent/llm-provider.env); provider not registered`,
		);
		return;
	}

	let ids: string[] = [];
	try {
		const res = await fetch(`${base}/v1/models`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}
		const payload = (await res.json()) as {
			data?: Array<{ id?: string }>;
		};
		ids = (payload.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0);
	} catch (err) {
		console.error(
			`${LOG_PREFIX} failed to fetch models from ${base}/v1/models:`,
			err instanceof Error ? err.message : err,
		);
		// Fall back to overrides so machines still have known models offline/partial outage
		ids = Object.keys(OVERRIDES);
	}

	const orIndex = await fetchOpenRouterIndex();

	const models = ids
		.map((id) => buildModel(id, base, orIndex))
		.filter((m): m is ModelDef => Boolean(m))
		.sort((a, b) => a.id.localeCompare(b.id));

	if (models.length === 0) {
		console.error(`${LOG_PREFIX} no models to register`);
		return;
	}

	// Use resolved key directly so file-based config works without shell exports.
	pi.registerProvider(provider, {
		name: provider,
		baseUrl: `${base}/v1`,
		apiKey,
		authHeader: true,
		api: "openai-completions",
		models,
	});

	console.error(`${LOG_PREFIX} registered provider "${provider}" with ${models.length} models from ${base}`);
}
