import assert from "node:assert/strict";
import test from "node:test";
import { CacheAlertDeduplicator } from "./alerts.ts";

const miss = {
  provider: "provider",
  model: "model",
  promptTokens: 2_100,
  reasons: ["cache-read-near-zero", "idle-gap-over-five-minutes"],
};

test("deduplicates equivalent meaningful misses and can reset", () => {
  const deduplicator = new CacheAlertDeduplicator();
  assert.equal(deduplicator.shouldAlert(miss), true);
  assert.equal(deduplicator.shouldAlert({ ...miss, reasons: [...miss.reasons].reverse() }), false);
  assert.equal(deduplicator.shouldAlert({ ...miss, promptTokens: 3_200 }), true);
  deduplicator.reset();
  assert.equal(deduplicator.shouldAlert(miss), true);
});
