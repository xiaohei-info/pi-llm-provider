import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../extensions/llm-provider.ts";

// This test runs in its own process; never use real gateway credentials or fetches.
process.env.LLM_API_KEY = "test-only";
process.env.LLM_BASE_URL = "https://gateway.invalid";
process.env.LLM_PROVIDER = "test-gateway";
// A throwaway home: the real ~/.pi/agent/llm-provider.env must never decide these cases.
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-llm-provider-test-"));

/** Apply env values (undefined removes the key) and return the undo function. */
function setEnv(values) {
	const previous = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/** Register the provider against a fake gateway and return its models by id. */
async function loadModels(t, ids) {
	t.mock.method(console, "error", () => {});
	t.mock.method(globalThis, "fetch", async (url) => {
		if (url === "https://openrouter.ai/api/v1/models") return { ok: false, json: async () => ({}) };
		assert.equal(url, "https://gateway.invalid/v1/models");
		return { ok: true, json: async () => ({ data: ids.map(id => ({ id })) }) };
	});
	let config;
	await register({
		registerProvider(id, value) {
			assert.equal(id, "test-gateway");
			config = value;
		},
	});
	return new Map(config.models.map(model => [model.id, model]));
}

for (const mode of ["live-metadata", "no-metadata", "gateway-unavailable"]) {
	test(`Astra supports max without user overrides: ${mode}`, async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(globalThis, "fetch", async (url) => {
			if (url === "https://openrouter.ai/api/v1/models") {
				return {
					ok: mode === "live-metadata",
					json: async () => ({ data: [{
						id: "openai/gpt-6-astra",
						context_length: 1050000,
						top_provider: { max_completion_tokens: 128000 },
						supported_parameters: ["reasoning"],
					}] }),
				};
			}
			assert.equal(url, "https://gateway.invalid/v1/models");
			return {
				ok: mode !== "gateway-unavailable",
				status: 503,
				statusText: "Service Unavailable",
				json: async () => ({ data: ["gpt-6-astra", "gpt-5.5", "gpt-5.6-luna"].map(id => ({ id })) }),
			};
		});
		let models;
		await register({ registerProvider(id, config) {
			assert.equal(id, "test-gateway");
			models = config.models;
		} });
		const astra = models.find(model => model.id === "gpt-6-astra");
		assert.ok(astra, "Astra must also exist in the offline fallback catalogue");
		assert.equal(astra.api, "openai-responses");
		assert.equal(astra.reasoning, true);
		assert.equal(astra.thinkingLevelMap.xhigh, "xhigh");
		assert.equal(astra.thinkingLevelMap.max, "max");
		if (mode === "live-metadata") assert.equal(astra.contextWindow, 1050000);
		assert.equal(models.find(model => model.id === "gpt-5.5").thinkingLevelMap.max, null);
		assert.equal(models.find(model => model.id === "gpt-5.6-luna").thinkingLevelMap.max, "max");
	});
}

test("Gemini models route to google-generative-ai (/v1beta) when configured", async (t) => {
	const prevBase = process.env.LLM_BASE_URL;
	process.env.LLM_BASE_URL = "https://gateway.invalid/v1";
	const undo = setEnv({ LLM_PROTOCOLS: "gpt-*:responses,claude-*:messages,gemini-*:gemini" });
	t.after(() => {
		undo();
		process.env.LLM_BASE_URL = prevBase;
	});
	t.mock.method(console, "error", () => {});
	const catalog = [
		"gemini-4-neon",
		"gemini-3.8-flash",
		"gemini-3.1-pro",
		"gemini-3.5-flash",
		"gemini-2.5-flash",
		"gpt-6-astra",
		"claude-sonnet-5-5",
		"deepseek-v4-pro",
		"qwen3.8-max",
		"kimi-k2.7",
		"glm-5.2",
		"grok-4.5",
	];
	t.mock.method(globalThis, "fetch", async (url) => {
		if (url === "https://openrouter.ai/api/v1/models") {
			return {
				ok: true,
				json: async () => ({
					data: [
						{
							id: "google/gemini-3.8-flash",
							context_length: 1048576,
							top_provider: { max_completion_tokens: 65536 },
							architecture: { input_modalities: ["text", "image"] },
							supported_parameters: ["reasoning"],
							pricing: { prompt: "0.00000075", completion: "0.00000375", input_cache_read: "0.000000075" },
						},
					],
				}),
			};
		}
		assert.equal(url, "https://gateway.invalid/v1/models");
		return { ok: true, json: async () => ({ data: catalog.map(id => ({ id })) }) };
	});

	let registered;
	await register({
		registerProvider(id, config) {
			assert.equal(id, "test-gateway");
			registered = config;
		},
	});
	const byId = new Map(registered.models.map(m => [m.id, m]));

	for (const id of ["gemini-4-neon", "gemini-3.8-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-2.5-flash"]) {
		const m = byId.get(id);
		assert.ok(m, `${id} must be registered`);
		assert.equal(m.api, "google-generative-ai");
		assert.equal(m.baseUrl, "https://gateway.invalid/v1beta");
		assert.equal(m.compat, undefined);
		assert.equal(m.reasoning, true);
		assert.deepEqual(m.input, ["text", "image"]);
	}

	assert.deepEqual(byId.get("gemini-4-neon").thinkingLevelMap, {
		off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null,
	});
	assert.deepEqual(byId.get("gemini-3.8-flash").thinkingLevelMap, {
		off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null,
	});
	assert.equal(byId.get("gemini-3.8-flash").cost.input, 0.75);
	assert.equal(byId.get("gemini-3.8-flash").cost.output, 3.75);
	assert.deepEqual(byId.get("gemini-3.1-pro").thinkingLevelMap, {
		off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null,
	});
	assert.equal(byId.get("gemini-2.5-flash").thinkingLevelMap, undefined);

	// Non-Gemini regression checks
	assert.equal(byId.get("gpt-6-astra").api, "openai-responses");
	assert.equal(byId.get("gpt-6-astra").baseUrl, "https://gateway.invalid/v1");
	assert.equal(byId.get("claude-sonnet-5-5").api, "anthropic-messages");
	assert.equal(byId.get("claude-sonnet-5-5").baseUrl, "https://gateway.invalid");
	for (const id of ["deepseek-v4-pro", "qwen3.8-max", "kimi-k2.7", "glm-5.2", "grok-4.5"]) {
		assert.equal(byId.get(id).api, "openai-completions");
		assert.equal(byId.get(id).baseUrl, "https://gateway.invalid/v1");
	}
});

const CATALOG = [
	"gpt-6-astra",
	"gpt-4o-mini",
	"claude-opus-5-5",
	"gemini-4-hydrogen",
	"deepseek-v4-flash",
	"newapi/kimi-k2.7",
];

function route(byId, id) {
	const model = byId.get(id);
	assert.ok(model, `${id} must be registered`);
	return [model.api, model.baseUrl];
}

test("no LLM_PROTOCOLS key: built-in series rules, unknown families fall back to chat", async (t) => {
	const undo = setEnv({ LLM_PROTOCOLS: undefined, LLM_DEFAULT_PROTOCOL: undefined, NEWAPI_PROTOCOLS: undefined });
	t.after(undo);
	const byId = await loadModels(t, CATALOG);
	assert.deepEqual(route(byId, "gpt-6-astra"), ["openai-responses", "https://gateway.invalid/v1"]);
	assert.deepEqual(route(byId, "claude-opus-5-5"), ["anthropic-messages", "https://gateway.invalid"]);
	assert.deepEqual(route(byId, "gemini-4-hydrogen"), ["anthropic-messages", "https://gateway.invalid"]);
	assert.deepEqual(route(byId, "deepseek-v4-flash"), ["openai-completions", "https://gateway.invalid/v1"]);
	// A provider/ prefix is stripped before matching, so the family rule still applies.
	assert.deepEqual(route(byId, "newapi/kimi-k2.7"), ["openai-completions", "https://gateway.invalid/v1"]);
});

test("configured series rules win: gemini as native, gemini as chat, deepseek as responses", async (t) => {
	let undo = setEnv({ LLM_PROTOCOLS: "gemini-*:gemini,deepseek-*:responses" });
	t.after(() => undo());
	let byId = await loadModels(t, CATALOG);
	assert.deepEqual(route(byId, "gemini-4-hydrogen"), ["google-generative-ai", "https://gateway.invalid/v1beta"]);
	assert.deepEqual(route(byId, "deepseek-v4-flash"), ["openai-responses", "https://gateway.invalid/v1"]);
	// Unlisted families now fall through to the default protocol, not the built-in rules.
	assert.deepEqual(route(byId, "claude-opus-5-5"), ["openai-completions", "https://gateway.invalid/v1"]);

	undo();
	undo = setEnv({ LLM_PROTOCOLS: "gemini-*=chat" });
	t.after(() => undo());
	byId = await loadModels(t, CATALOG);
	assert.deepEqual(route(byId, "gemini-4-hydrogen"), ["openai-completions", "https://gateway.invalid/v1"]);
});

test("a more specific rule beats a broader one; ties keep config order", async (t) => {
	const undo = setEnv({ LLM_PROTOCOLS: "gpt-*:responses,gpt-4o*:chat,claude-*:messages,claude-opus-*:gemini" });
	t.after(undo);
	const byId = await loadModels(t, [...CATALOG, "claude-opus-5-5"]);
	assert.deepEqual(route(byId, "gpt-6-astra"), ["openai-responses", "https://gateway.invalid/v1"]);
	assert.deepEqual(route(byId, "gpt-4o-mini"), ["openai-completions", "https://gateway.invalid/v1"]);
	assert.deepEqual(route(byId, "claude-opus-5-5"), ["google-generative-ai", "https://gateway.invalid/v1beta"]);
});

test("an explicit empty LLM_PROTOCOLS falls everything back to LLM_DEFAULT_PROTOCOL", async (t) => {
	let undo = setEnv({ LLM_PROTOCOLS: "", LLM_DEFAULT_PROTOCOL: undefined });
	t.after(() => undo());
	let byId = await loadModels(t, CATALOG);
	for (const id of CATALOG) {
		assert.deepEqual(route(byId, id), ["openai-completions", "https://gateway.invalid/v1"], id);
	}

	undo();
	undo = setEnv({ LLM_PROTOCOLS: "", LLM_DEFAULT_PROTOCOL: "messages" });
	t.after(() => undo());
	byId = await loadModels(t, CATALOG);
	for (const id of CATALOG) {
		assert.deepEqual(route(byId, id), ["anthropic-messages", "https://gateway.invalid"], id);
	}
});

test("env overrides the config file, and NEWAPI_* remains a compatible alias", async (t) => {
	const home = process.env.HOME;
	const previousHome = home;
	process.env.HOME = mkdtempSync(join(tmpdir(), "pi-llm-provider-home-"));
	mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(process.env.HOME, ".pi", "agent", "llm-provider.env"),
		"LLM_PROTOCOLS=gemini-*:gemini\nLLM_DEFAULT_PROTOCOL=messages\n",
	);
	const undo = setEnv({ LLM_PROTOCOLS: undefined, LLM_DEFAULT_PROTOCOL: undefined, NEWAPI_PROTOCOLS: undefined });
	t.after(() => {
		undo();
		process.env.HOME = previousHome;
	});

	let byId = await loadModels(t, CATALOG);
	assert.deepEqual(route(byId, "gemini-4-hydrogen"), ["google-generative-ai", "https://gateway.invalid/v1beta"]);
	assert.deepEqual(route(byId, "deepseek-v4-flash"), ["anthropic-messages", "https://gateway.invalid"]);

	const undoEnv = setEnv({ NEWAPI_PROTOCOLS: "gemini-*:chat" });
	t.after(() => undoEnv());
	byId = await loadModels(t, CATALOG);
	assert.deepEqual(route(byId, "gemini-4-hydrogen"), ["openai-completions", "https://gateway.invalid/v1"]);
	assert.deepEqual(route(byId, "deepseek-v4-flash"), ["anthropic-messages", "https://gateway.invalid"]);
});

test("an unknown protocol or malformed rule fails loudly instead of falling back", async (t) => {
	t.mock.method(console, "error", () => {});
	const undo = setEnv({ LLM_PROTOCOLS: "gemini-*:telepathy" });
	t.after(() => undo());
	await assert.rejects(register({ registerProvider() {} }), /Unknown protocol "telepathy"/);

	process.env.LLM_PROTOCOLS = "gemini-*";
	await assert.rejects(register({ registerProvider() {} }), /Invalid protocol rule "gemini-\*"/);

	process.env.LLM_PROTOCOLS = "gemini-*:gemini";
	process.env.LLM_DEFAULT_PROTOCOL = "telepathy";
	await assert.rejects(register({ registerProvider() {} }), /Unknown protocol "telepathy"/);
});
