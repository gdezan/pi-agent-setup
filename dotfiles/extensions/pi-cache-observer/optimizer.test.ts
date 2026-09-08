import assert from "node:assert/strict";
import test from "node:test";
import { applyCacheKeyOptimizer, decideCacheKeyMutation, previewNextOptimizerDecision } from "./optimizer.ts";
import type { OptimizerConfig } from "./types.ts";

const preview: OptimizerConfig = {
	mode: "preview",
	entries: [{ provider: "openai-compatible", model: "model-a", promptCacheKey: "stable-project-key" }],
};
const live: OptimizerConfig = { ...preview, mode: "live" };
const model = { provider: "openai-compatible", model: "model-a" };
const payload = { model: "model-a", messages: [{ role: "user", content: "opaque" }], temperature: 0.2 };

test("matches the exact provider and model allowlist", () => {
	assert.equal(decideCacheKeyMutation(payload, model, preview).providerMatched, true);
	assert.equal(decideCacheKeyMutation(payload, { ...model, model: "model-b" }, preview).eligible, false);
	assert.equal(decideCacheKeyMutation(payload, { provider: "other", model: "model-a" }, preview).eligible, false);
});

test("preview mode never mutates or prints payload content", () => {
	const result = applyCacheKeyOptimizer(payload, model, preview);
	assert.deepEqual(result.payload, payload);
	assert.equal(result.decision.reason, "preview-only");
	assert.equal(result.decision.fields[0], "prompt_cache_key");
	assert.equal(JSON.stringify(result.decision).includes("opaque"), false);
});

test("live mode adds only the explicit cache-key field", () => {
	const result = applyCacheKeyOptimizer(payload, model, live);
	assert.deepEqual(payload, { model: "model-a", messages: [{ role: "user", content: "opaque" }], temperature: 0.2 });
	assert.equal((result.payload as Record<string, unknown>).prompt_cache_key, "stable-project-key");
	assert.deepEqual(result.payload, { ...payload, prompt_cache_key: "stable-project-key" });
	assert.equal(result.decision.mutated, true);
});

test("malformed, unsupported, and already-keyed payloads remain unchanged", () => {
	for (const candidate of [null, [], { model: "model-a" }, { model: "model-a", messages: ["not a message"] }]) {
		const result = applyCacheKeyOptimizer(candidate, model, live);
		assert.equal(result.payload, candidate);
		assert.equal(result.decision.mutated, false);
	}
	const already = { ...payload, prompt_cache_key: "existing" };
	const result = applyCacheKeyOptimizer(already, model, live);
	assert.equal(result.payload, already);
	assert.equal(result.decision.reason, "already-present");
});

test("preview command state is structural when no payload has been inspected", () => {
	const result = previewNextOptimizerDecision(model, preview);
	assert.equal(result.eligible, true);
	assert.equal(result.reason, "payload-model-missing");
	assert.deepEqual(result.fields, ["prompt_cache_key"]);
});
