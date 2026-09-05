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
