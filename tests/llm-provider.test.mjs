import assert from "node:assert/strict";
import test from "node:test";
import register from "../extensions/llm-provider.ts";

// This test runs in its own process; never use real gateway credentials or fetches.
process.env.LLM_API_KEY = "test-only";
process.env.LLM_BASE_URL = "https://gateway.invalid";
process.env.LLM_PROVIDER = "test-gateway";

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

test("Gemini models route to google-generative-ai (/v1beta) without affecting other families", async (t) => {
	const prevBase = process.env.LLM_BASE_URL;
	process.env.LLM_BASE_URL = "https://gateway.invalid/v1";
	t.after(() => {
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
