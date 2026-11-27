import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_IDLE_GAP_MS,
  CACHE_TOKEN_FLOOR,
  calculateCacheHitRate,
  calculatePromptTokens,
  classifyCacheUsage,
  normalizeCacheUsage,
} from "./classifier.ts";
import type { CacheBaseline, NormalizedCacheUsage } from "./types.ts";

function usage(cacheRead = 0, cacheWrite = 0, input = 1_000): NormalizedCacheUsage {
  return { input, output: 10, cacheRead, cacheWrite, cacheFieldsComplete: true };
}

function baseline(promptTokens = 2_000, at = 1_000): CacheBaseline {
  return { at, provider: "provider", model: "model", promptTokens };
}

function classify(
  current: NormalizedCacheUsage,
  options: Partial<Parameters<typeof classifyCacheUsage>[1]> = {},
) {
  return classifyCacheUsage(current, {
    at: 2_000,
    provider: "provider",
    model: "model",
    baseline: baseline(),
    cacheActivityObserved: true,
    ...options,
  });
}

test("calculates prompt tokens and hit rate from normalized usage", () => {
  const current = usage(3_000, 1_000, 2_000);
  assert.equal(calculatePromptTokens(current), 6_000);
  assert.equal(calculateCacheHitRate(current), 0.5);
  assert.equal(calculateCacheHitRate(usage(0, 0, 0)), undefined);
  assert.equal(
    calculateCacheHitRate({ input: 2_000, cacheRead: undefined, cacheWrite: undefined }),
    undefined,
  );
});

test("normalizes missing provider cache fields without inventing activity", () => {
  const current = normalizeCacheUsage({ input: 2_000, output: 10 });
  assert.ok(current);
  assert.equal(current.cacheFieldsComplete, false);
  assert.equal(current.cacheRead, undefined);
  assert.equal(current.cacheWrite, undefined);
});

test("classifies every reported cache state", () => {
  assert.equal(classify(usage(0, 2_000)).classification, "cache-write");
  assert.equal(classify(usage(2_000, 0)).classification, "cache-hit");
  assert.equal(classify(usage(1_000, 2_000)).classification, "partial-hit");
  const miss = classify(usage(0, 0, 2_000));
  assert.equal(miss.classification, "miss");
  assert.equal(miss.meaningfulMiss, true);
});

test("does not call first turns or unsupported providers misses", () => {
  const first = classifyCacheUsage(usage(0, 2_000), {
    at: 1_000,
    provider: "provider",
    model: "model",
    cacheActivityObserved: false,
    boundaryReason: "session-start",
  });
  assert.equal(first.classification, "unknown");
  assert.ok(first.reasons.includes("session-start"));

  const unsupported = classifyCacheUsage(
    { input: 2_000, output: 10, cacheFieldsComplete: false },
    {
      at: 2_000,
      provider: "provider",
      model: "model",
      baseline: baseline(),
      cacheActivityObserved: true,
    },
  );
  assert.equal(unsupported.classification, "unsupported");
  assert.equal(unsupported.meaningfulMiss, false);
});

test("uses the prompt floor before declaring a meaningful miss", () => {
  const result = classify(usage(0, 0, CACHE_TOKEN_FLOOR - 1));
  assert.equal(result.classification, "unknown");
  assert.equal(result.meaningfulMiss, false);
  assert.ok(result.reasons.includes("prompt-below-cache-floor"));
});

test("retains idle and prompt-size evidence on a miss", () => {
  const result = classify(usage(0, 0, 4_000), {
    baseline: baseline(2_000, 2_000 - CACHE_IDLE_GAP_MS - 1),
  });
  assert.equal(result.classification, "miss");
  assert.ok(result.reasons.includes("idle-gap-over-five-minutes"));
  assert.ok(result.reasons.includes("prompt-size-changed"));
});

test("requires a fresh baseline after a provider or model change", () => {
  const result = classify(usage(0, 0), { baseline: { ...baseline(), model: "other-model" } });
  assert.equal(result.classification, "unknown");
  assert.equal(result.meaningfulMiss, false);
  assert.ok(result.reasons.includes("baseline-reset-required"));
});

test("treats lifecycle boundaries as unknown baselines", () => {
  for (const boundaryReason of [
    "model-changed",
    "session-compacted",
    "session-tree-changed",
    "manual-reset",
  ]) {
    const result = classifyCacheUsage(usage(0, 0), {
      at: 2_000,
      provider: "provider",
      model: "model",
      cacheActivityObserved: true,
      boundaryReason,
    });
    assert.equal(result.classification, "unknown");
    assert.equal(result.meaningfulMiss, false);
    assert.ok(result.reasons.includes(boundaryReason));
  }
});
