import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_UTILITY_MODEL_CONFIG,
  mergeUtilityModelSettings,
  parseUtilityModelConfig,
  readUtilitySettings,
  saveUtilityModelConfig,
} from "../utility-model/utility-model-config.ts";
import {
  requestUtilityResponse,
  resolveUtilityModel,
} from "../utility-model/utility-model-request.ts";

test("utility selection resolves new, legacy, and default fields independently", () => {
  assert.deepEqual(parseUtilityModelConfig({}), DEFAULT_UTILITY_MODEL_CONFIG);
  assert.deepEqual(
    parseUtilityModelConfig({
      utilityModel: { model: "example/new" },
      sessionAutoname: { model: "example/old", thinkingLevel: "high" },
    }),
    { model: { provider: "example", id: "new" }, thinkingLevel: "high" },
  );
  assert.deepEqual(
    parseUtilityModelConfig({
      utilityModel: { thinkingLevel: "low" },
      sessionAutoname: { model: "example/old", thinkingLevel: "high" },
    }),
    { model: { provider: "example", id: "old" }, thinkingLevel: "low" },
  );
  assert.deepEqual(
    parseUtilityModelConfig({ utilityModel: { model: "broken", thinkingLevel: "extreme" } }),
    DEFAULT_UTILITY_MODEL_CONFIG,
  );
});

test("utility migration preserves unrelated and unknown settings without mutating input", () => {
  const original = {
    theme: "dark",
    packages: ["npm:example"],
    utilityModel: { extra: true },
    sessionAutoname: { enabled: false, model: "example/old", thinkingLevel: "high", other: 42 },
    nextPrompt: { enabled: false },
  };
  const snapshot = structuredClone(original);
  const migrated = mergeUtilityModelSettings(original, DEFAULT_UTILITY_MODEL_CONFIG);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(migrated, {
    ...original,
    utilityModel: { extra: true, model: "openai/gpt-6-luna", thinkingLevel: "low" },
    sessionAutoname: { enabled: false, other: 42 },
  });
  assert.deepEqual(mergeUtilityModelSettings(migrated, DEFAULT_UTILITY_MODEL_CONFIG), migrated);
});

test("utility settings are fresh, writes preserve disk keys, and malformed settings are never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-utility-settings-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({ sessionAutoname: { model: "example/old" }, theme: "dark" }),
    );
    const before = readFileSync(path, "utf8");
    assert.equal(parseUtilityModelConfig(readUtilitySettings(undefined, path)).model.id, "old");
    assert.equal(readFileSync(path, "utf8"), before);
    saveUtilityModelConfig(DEFAULT_UTILITY_MODEL_CONFIG, path);
    assert.equal(
      parseUtilityModelConfig(readUtilitySettings(undefined, path)).model.id,
      "gpt-6-luna",
    );
    assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "dark");
    writeFileSync(path, "{ malformed");
    assert.throws(() => saveUtilityModelConfig(DEFAULT_UTILITY_MODEL_CONFIG, path));
    assert.equal(readFileSync(path, "utf8"), "{ malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("utility settings honor trusted project fields and never read untrusted overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-utility-project-"));
  try {
    const path = join(dir, "settings.json");
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      path,
      JSON.stringify({
        utilityModel: { model: "example/global", thinkingLevel: "low" },
        nextPrompt: { enabled: true },
      }),
    );
    writeFileSync(
      join(dir, ".pi/settings.json"),
      JSON.stringify({ utilityModel: { thinkingLevel: "high" }, nextPrompt: { enabled: false } }),
    );
    assert.deepEqual(
      parseUtilityModelConfig(
        readUtilitySettings({ cwd: dir, isProjectTrusted: () => true }, path),
      ),
      {
        model: { provider: "example", id: "global" },
        thinkingLevel: "high",
      },
    );
    assert.deepEqual(
      parseUtilityModelConfig(
        readUtilitySettings({ cwd: dir, isProjectTrusted: () => false }, path),
      ),
      {
        model: { provider: "example", id: "global" },
        thinkingLevel: "low",
      },
    );
    writeFileSync(join(dir, ".pi/settings.json"), "{ broken");
    assert.doesNotThrow(() =>
      readUtilitySettings({ cwd: dir, isProjectTrusted: () => false }, path),
    );
    assert.throws(() => readUtilitySettings({ cwd: dir, isProjectTrusted: () => true }, path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("utility requests terminate on timeout or cancellation even when a provider ignores abort", async () => {
  const controller = new AbortController();
  let resolveResponse: (value: unknown) => void = () => {};
  const ctx = {
    modelRegistry: {
      streamSimple: () => ({
        result: () =>
          new Promise((resolve) => {
            resolveResponse = resolve;
          }),
      }),
    },
  } as never;
  const model = { reasoning: true } as never;
  const context = { messages: [] };
  const limits = { signal: controller.signal, timeoutMs: 10, maxTokens: 512 };
  const keepalive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(requestUtilityResponse(ctx, model, context, "low", limits), {
      name: "TimeoutError",
    });
    const request = requestUtilityResponse(ctx, model, context, "low", {
      ...limits,
      timeoutMs: 1_000,
    });
    controller.abort();
    resolveResponse({ stopReason: "stop" });
    await assert.rejects(request, { name: "AbortError" });
  } finally {
    clearTimeout(keepalive);
  }
});

test("synchronous provider failures reject normally and pre-cancelled requests never start", async () => {
  const controller = new AbortController();
  let calls = 0;
  const ctx = {
    modelRegistry: {
      streamSimple: () => {
        calls++;
        throw new Error("Fixture auth failure");
      },
    },
  } as never;
  const limits = { signal: controller.signal, timeoutMs: 1_000, maxTokens: 512 };
  await assert.rejects(
    requestUtilityResponse(ctx, {} as never, { messages: [] }, "off", limits),
    /Fixture auth failure/,
  );
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(requestUtilityResponse(ctx, {} as never, { messages: [] }, "off", limits), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
});

test("utility model never falls back when its model or credentials are missing", () => {
  const model = { provider: "openai", id: "gpt-6-luna" };
  assert.equal(
    resolveUtilityModel(
      { find: () => model, hasConfiguredAuth: () => true } as never,
      DEFAULT_UTILITY_MODEL_CONFIG,
    ),
    model,
  );
  assert.equal(
    resolveUtilityModel(
      { find: () => model, hasConfiguredAuth: () => false } as never,
      DEFAULT_UTILITY_MODEL_CONFIG,
    ),
    undefined,
  );
  assert.equal(
    resolveUtilityModel(
      { find: () => undefined, hasConfiguredAuth: () => true } as never,
      DEFAULT_UTILITY_MODEL_CONFIG,
    ),
    undefined,
  );
});
