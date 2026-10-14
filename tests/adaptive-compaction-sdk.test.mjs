import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import register from "../extensions/llm-provider.ts";

// Real installed Pi SDK/ExtensionRunner/AgentSession compaction lifecycle. The
// gateway catalogue and summary are explicit fixtures, never real inference.
for (const trigger of ["resume", "settled"]) {
test(`Pi SDK RPC ${trigger}: real ctx.compact saves summary without native competition or UI`, { timeout: 10000 }, async t => {
	process.env.LLM_API_KEY = "test-only";
	process.env.LLM_BASE_URL = "https://gateway.invalid";
	process.env.LLM_PROVIDER = "test-gateway";
	process.env.LLM_COMPACTION_ENABLED = "true";
	const dir = mkdtempSync(join(tmpdir(), "pi-adaptive-sdk-"));
	t.mock.method(console, "error", () => {});
	t.mock.method(globalThis, "fetch", async url => {
		assert.ok(["https://gateway.invalid/v1/models", "https://openrouter.ai/api/v1/models"].includes(String(url)), `unexpected network: ${url}`);
		return { ok: true, json: async () => ({ data: String(url).includes("openrouter") ? [{ id: "anthropic/claude-opus-4-8", context_length: 1000000 }] : [{ id: "claude-opus-4-8" }] }) };
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
		retry: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), refreshOnCreate: false });
	const sm = SessionManager.inMemory(dir);
	const assistant = {
		role: "assistant", content: [{ type: "text", text: "fixture response" }],
		api: "anthropic-messages", provider: "test-gateway", model: "claude-opus-4-8",
		usage: { input: 600000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 600010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	};
	for (let i = 0; i < 6; i++) {
		sm.appendMessage({ role: "user", content: `fixture user ${i}`, timestamp: i });
		sm.appendMessage({ ...assistant, usage: { ...assistant.usage, input: trigger === "resume" ? 600000 : 100000, totalTokens: trigger === "resume" ? 600010 : 100010 }, timestamp: i });
	}
	let summaries = 0;
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [register, pi => {
			pi.on("session_before_compact", event => {
				assert.equal(event.reason, "manual");
				summaries++;
				return { compaction: { summary: "explicit fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
			});
		}],
	});
	let session;
	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const model = modelRuntime.getModel("test-gateway", "claude-opus-4-8") ?? {
			...assistant, id: "claude-opus-4-8", name: "fixture model", baseUrl: "https://gateway.invalid",
			reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000,
		};
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model,
			resourceLoader, settingsManager, sessionManager: sm, tools: [], thinkingLevel: "off" }));
		await session.bindExtensions({ mode: "rpc", onError: err => { throw new Error(JSON.stringify(err)); } });
		if (trigger === "settled") {
			assert.equal(summaries, 0);
			const events = [];
			session.subscribe(event => events.push(event.type));
			session.agent.streamFunction = () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: { ...assistant, timestamp: Date.now() } }); stream.end(); });
				return stream;
			};
			await session.prompt("explicit fixture prompt");
			assert.ok(events.indexOf("compaction_end") < events.indexOf("agent_settled"));
			assert.ok(events.includes("compaction_start"));
		}
		assert.equal(summaries, 1);
		assert.equal(sm.getBranch().filter(e => e.type === "compaction").length, 1);
		assert.equal(sm.getBranch().find(e => e.type === "compaction").summary, "explicit fixture summary");
		assert.equal(session.getContextUsage().tokens, null);
		assert.equal(session.autoCompactionEnabled, true);
		assert.equal(session.isIdle, true);
	} finally { session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
}
