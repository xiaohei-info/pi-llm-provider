import assert from "node:assert/strict";
import test from "node:test";
import { registerAdaptiveCompaction, resolveAdaptiveCompactionConfig } from "../extensions/llm-provider.ts";

const defaults = resolveAdaptiveCompactionConfig({}, {});
function harness(options = {}) {
	const handlers = new Map();
	const calls = [];
	let leaf = "entry-1";
	let session = "session-1";
	let idle = true;
	let queued = false;
	const ctx = {
		model: { provider: "gateway", id: "model", contextWindow: 1000000 },
		mode: "rpc", hasUI: false,
		get ui() { throw new Error("RPC test forbids UI access"); },
		usage: { tokens: 500000, contextWindow: 1000000, percent: 50 },
		getContextUsage() { return this.usage; },
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		sessionManager: { getLeafId: () => leaf, getSessionId: () => session },
		compact(callbacks) { calls.push(callbacks); options.compact?.(callbacks); },
	};
	registerAdaptiveCompaction({ on(name, handler) { handlers.set(name, handler); } }, "gateway", {
		...defaults, enabled: true, ...options.config,
	});
	return {
		ctx, calls, handlers,
		emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
		leaf: value => { leaf = value; }, session: value => { session = value; },
		idle: value => { idle = value; }, queued: value => { queued = value; },
	};
}
function complete(h, pending) { h.calls.at(-1).onComplete({}); return pending; }

test("config: opt-in defaults and env-over-file boolean switch", () => {
	assert.deepEqual(defaults, { enabled: false, windowBoundary: 500000, largeWindowRatio: 0.5, smallWindowRatio: 0.8 });
	assert.equal(resolveAdaptiveCompactionConfig({ LLM_COMPACTION_ENABLED: "true" }, { LLM_COMPACTION_ENABLED: "false" }).enabled, false);
	assert.equal(resolveAdaptiveCompactionConfig({ LLM_COMPACTION_ENABLED: " TRUE " }, {}).enabled, true);
	const h = harness({ config: { enabled: false } });
	assert.equal(h.handlers.size, 0);
});

test("config: rejects invalid boolean, boundary and ratios", () => {
	for (const raw of ["1", "yes", ""]) assert.throws(() => resolveAdaptiveCompactionConfig({ LLM_COMPACTION_ENABLED: raw }, {}));
	for (const key of ["LLM_COMPACTION_WINDOW_BOUNDARY", "LLM_COMPACTION_LARGE_WINDOW_RATIO", "LLM_COMPACTION_SMALL_WINDOW_RATIO"]) {
		for (const raw of ["", "0", "-1", "NaN", "Infinity", "junk"]) assert.throws(() => resolveAdaptiveCompactionConfig({ [key]: raw }, {}));
	}
	assert.throws(() => resolveAdaptiveCompactionConfig({ LLM_COMPACTION_WINDOW_BOUNDARY: "1.5" }, {}));
	assert.throws(() => resolveAdaptiveCompactionConfig({ LLM_COMPACTION_SMALL_WINDOW_RATIO: "1.01" }, {}));
	assert.throws(() => resolveAdaptiveCompactionConfig({ LLM_COMPACTION_LARGE_WINDOW_RATIO: "1.01" }, {}));
});

for (const [window, threshold] of [[500001, 250000.5], [500000, 400000], [499999, 399999.2], [1000000, 500000], [272000, 217600], [128000, 102400]]) {
	test(`window ${window}: below threshold skips, at threshold compacts`, async () => {
		const h = harness();
		h.ctx.usage = { tokens: threshold - 1, contextWindow: window, percent: null };
		await h.emit("session_start");
		assert.equal(h.calls.length, 0);
		h.ctx.usage.tokens = threshold;
		const p = h.emit("agent_settled");
		assert.equal(h.calls.length, 1);
		await complete(h, p);
	});
}

test("custom boundary/ratios work", async () => {
	const h = harness({ config: { windowBoundary: 100000, largeWindowRatio: 0.6, smallWindowRatio: 0.9 } });
	h.ctx.usage = { tokens: 60000, contextWindow: 100001 };
	await h.emit("session_start");
	assert.equal(h.calls.length, 0);
	h.ctx.usage.tokens = 60001;
	await complete(h, h.emit("agent_settled"));
});

test("unknown/invalid usage and other providers never trigger", async () => {
	const h = harness();
	for (const usage of [undefined, { tokens: null, contextWindow: 1000000 }, { tokens: NaN, contextWindow: 1000000 }, { tokens: Infinity, contextWindow: 1000000 }, { tokens: -1, contextWindow: 1000000 }, { tokens: 500000, contextWindow: 0 }, { tokens: 500000, contextWindow: Infinity }]) {
		h.ctx.usage = usage;
		await h.emit("agent_settled");
	}
	h.ctx.usage = { tokens: 500000, contextWindow: 1000000 };
	h.ctx.model.provider = "other";
	await h.emit("agent_settled");
	assert.equal(h.calls.length, 0);
});

test("restored high session compacts without needing a crossing; repeats and in-flight deduplicate", async () => {
	const h = harness();
	let settled = false;
	const p = h.emit("session_start").then(() => { settled = true; });
	await h.emit("model_select"); await h.emit("agent_settled");
	assert.equal(h.calls.length, 1);
	assert.equal(settled, false);
	await complete(h, p);
	await h.emit("session_start"); await h.emit("agent_settled");
	assert.equal(h.calls.length, 1);
});

test("tool turns, native active compaction and queued messages wait until idle settlement", async () => {
	const h = harness();
	assert.equal(h.handlers.has("turn_end"), false);
	assert.equal(h.handlers.has("agent_end"), false);
	h.idle(false); await h.emit("model_select"); await h.emit("agent_settled");
	h.idle(true); h.queued(true); await h.emit("agent_settled");
	assert.equal(h.calls.length, 0);
	h.queued(false); await complete(h, h.emit("agent_settled"));
});

test("successful compaction still above ratio waits for material growth; below threshold rearms", async () => {
	const h = harness();
	await complete(h, h.emit("agent_settled"));
	h.ctx.usage.tokens = null; h.leaf("summary"); await h.emit("agent_settled");
	h.ctx.usage.tokens = 510000; h.leaf("new-turn"); await h.emit("agent_settled");
	assert.equal(h.calls.length, 1);
	h.ctx.usage.tokens = 550000; h.leaf("growth-turn");
	await complete(h, h.emit("agent_settled"));
	assert.equal(h.calls.length, 2);
	h.ctx.usage.tokens = 100000; h.leaf("small-turn"); await h.emit("agent_settled");
	h.ctx.usage.tokens = 500000; h.leaf("next-crossing");
	await complete(h, h.emit("agent_settled"));
	assert.equal(h.calls.length, 3);
});

test("failure retry requires cooldown and new history; synchronous failure releases lock", async t => {
	t.mock.method(console, "error", () => {});
	let now = 100000;
	t.mock.method(Date, "now", () => now);
	const h = harness();
	const p = h.emit("agent_settled"); h.calls[0].onError(new Error("offline")); await p;
	h.leaf("new-turn"); await h.emit("agent_settled"); assert.equal(h.calls.length, 1);
	now += 60000;
	await complete(h, h.emit("agent_settled")); assert.equal(h.calls.length, 2);
	const thrown = harness({ compact() { throw new Error("sync failure"); } });
	await thrown.emit("agent_settled");
	now += 60000; await thrown.emit("agent_settled"); assert.equal(thrown.calls.length, 1);
	thrown.leaf("new-turn"); await thrown.emit("agent_settled"); assert.equal(thrown.calls.length, 2);
});

test("model/window changes and different sessions reevaluate; returning model keeps suppression", async () => {
	const h = harness();
	await complete(h, h.emit("agent_settled"));
	h.ctx.model.id = "second"; await complete(h, h.emit("model_select"));
	h.ctx.model.id = "model"; await h.emit("model_select"); assert.equal(h.calls.length, 2);
	h.ctx.usage.contextWindow = 500000; await complete(h, h.emit("model_select"));
	h.session("session-2"); await complete(h, h.emit("session_start")); assert.equal(h.calls.length, 4);
});

test("native success/failure suppress immediate competing adaptive attempt", async t => {
	let now = 100000; t.mock.method(Date, "now", () => now);
	for (const event of ["session_compact", "session_compact_failed"]) {
		const h = harness();
		await h.emit("session_before_compact"); await h.emit("agent_settled"); assert.equal(h.calls.length, 0);
		await h.emit(event); await h.emit("agent_settled"); assert.equal(h.calls.length, 0);
		h.leaf("new-turn"); await h.emit("agent_settled"); assert.equal(h.calls.length, 0);
		if (event === "session_compact_failed") { now += 60000; await complete(h, h.emit("agent_settled")); }
	}
});

test("shutdown invalidates stale callbacks and clears old session state", async () => {
	const h = harness();
	const first = h.emit("session_start");
	await h.emit("session_shutdown");
	h.session("replacement"); const second = h.emit("session_start");
	h.calls[0].onComplete({}); await first;
	await h.emit("agent_settled"); assert.equal(h.calls.length, 2);
	h.calls[1].onComplete({}); await second;
});
