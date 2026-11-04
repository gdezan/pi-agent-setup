import assert from "node:assert/strict";
import test from "node:test";
import { createContextSection, resolveFooterContextBudget } from "./context.ts";

const theme = { fg: (_color: string, text: string) => text };

function moltProjection(tokensAfter: number, sequence = 1) {
  return {
    version: 1,
    sequence,
    removedEntryIds: ["assistant-group-1"],
    tokensBefore: 82_000,
    tokensAfter,
    reductionTokens: 82_000 - tokensAfter,
    elapsedMs: 10,
    jevRequestCount: 1,
    jevUsage: { inputTokens: 100, outputTokens: 10 },
    jevCostUsd: 0.001,
    jevModel: "jev-model",
    removalCutoff: 0.7,
    triggerTokens: 80_000,
    fallbackBoundaryTokens: 70_000,
    outcome: "committed",
    timestamp: 1,
    scores: [],
  };
}

test("Molt projection tokens replace stale pre-pruning provider usage", () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 80_000, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 82_000 },
      },
    },
    {
      type: "custom",
      customType: "molt-context-projection",
      data: moltProjection(31_250),
    },
  ];
  const context = {
    model: { contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 82_000, contextWindow: 100_000, percent: 82 }),
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => [],
    },
  };

  // SAFETY: this focused context double implements every member read by context-budget resolution.
  const budget = resolveFooterContextBudget(context as never);
  // SAFETY: the theme double implements the only Theme member read by the context section.
  const rendered = createContextSection().render(context as never, theme as never, "full");

  assert.deepEqual(budget, { tokens: 31_250, contextWindow: 100_000, estimated: true });
  assert.equal(rendered, "~31k/100k");
});

test("native compaction renders an estimated rebuilt context instead of an unknown budget", () => {
  const context = {
    model: { contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }),
    sessionManager: {
      getBranch: () => [{ type: "compaction" }],
      buildContextEntries: () => [
        { type: "compaction", summary: "x".repeat(4_000), tokensBefore: 80_000, timestamp: 1 },
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "y".repeat(2_000) }],
            timestamp: 2,
          },
        },
      ],
    },
  };

  // SAFETY: these focused doubles implement every context and theme member read by the context section.
  const rendered = createContextSection().render(context as never, theme as never, "full");

  assert.equal(rendered, "~1.5k/100k");
});

test("post-pruning assistant usage supersedes the persisted Molt estimate", () => {
  const branch = [
    { type: "custom", customType: "molt-context-projection", data: moltProjection(31_250) },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 33_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 33_500 },
      },
    },
  ];
  const context = {
    model: { contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 33_500, contextWindow: 100_000, percent: 33.5 }),
    sessionManager: { getBranch: () => branch, buildContextEntries: () => [] },
  };

  // SAFETY: this focused context double implements every member read by context-budget resolution.
  assert.deepEqual(resolveFooterContextBudget(context as never), {
    tokens: 33_500,
    contextWindow: 100_000,
    estimated: false,
  });
});

test("a malformed later Molt record fails closed instead of retaining an older estimate", () => {
  const branch = [
    { type: "custom", customType: "molt-context-projection", data: moltProjection(31_250) },
    {
      type: "custom",
      customType: "molt-context-projection",
      data: { version: 1, outcome: "committed", tokensAfter: 1 },
    },
  ];
  const context = {
    model: { contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 82_000, contextWindow: 100_000, percent: 82 }),
    sessionManager: { getBranch: () => branch, buildContextEntries: () => [] },
  };

  // SAFETY: this focused context double implements every member read by context-budget resolution.
  assert.deepEqual(resolveFooterContextBudget(context as never), {
    tokens: 82_000,
    contextWindow: 100_000,
    estimated: false,
  });
});

test("compaction clears the estimate without resetting Molt ancestry validation", () => {
  const branch = [
    { type: "custom", customType: "molt-context-projection", data: moltProjection(31_250) },
    { type: "compaction" },
    { type: "custom", customType: "molt-context-projection", data: moltProjection(1) },
  ];
  const context = {
    model: { contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 40_000, contextWindow: 100_000, percent: 40 }),
    sessionManager: { getBranch: () => branch, buildContextEntries: () => [] },
  };

  // SAFETY: this focused context double implements every member read by context-budget resolution.
  assert.deepEqual(resolveFooterContextBudget(context as never), {
    tokens: 40_000,
    contextWindow: 100_000,
    estimated: false,
  });
});
