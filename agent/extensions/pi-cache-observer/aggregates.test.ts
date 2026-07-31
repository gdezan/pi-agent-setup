import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AggregateStore, aggregateObservation, parseAggregateDocument, pruneAggregateDocument } from "./aggregates.ts";
import type { CacheObservation } from "./types.ts";

function observation(provider: string, model: string, at: number, promptTokens = 2_000): CacheObservation {
	return {
		at,
		provider,
		model,
		usage: { input: promptTokens, output: 10, cacheRead: 0, cacheWrite: 0, inputCost: 0.42, cacheFieldsComplete: true },
		promptTokens,
		classification: "miss",
		meaningfulMiss: true,
		reasons: ["cache-read-near-zero"],
		promptSizeChanged: false,
	};
}


test("persists an estimated cost only for meaningful misses", () => {
	assert.equal(aggregateObservation(observation("provider", "model", 1_000)).estimatedMissedCost, 0.42);
});

test("prunes entries older than thirty days and ignores unknown sensitive fields", () => {
	const now = 100 * 24 * 60 * 60 * 1_000;
	const parsed = parseAggregateDocument({
		version: 1,
		updatedAt: now,
		entries: [
			{ provider: "provider", model: "new", firstSeen: now, lastSeen: now, requests: 1, promptText: "secret prompt" },
			{ provider: "provider", model: "old", firstSeen: now - 31 * 24 * 60 * 60 * 1_000, lastSeen: now - 31 * 24 * 60 * 60 * 1_000, requests: 1 },
		],
	}, now);
	assert.ok(parsed);
	const pruned = pruneAggregateDocument(parsed, now);
	assert.equal(pruned.entries.length, 1);
	assert.equal(JSON.stringify(pruned).includes("secret prompt"), false);
});

test("stores redacted aggregates atomically and keeps them under the byte bound", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-cache-observer-"));
	const path = join(directory, "stats.json");
	const store = new AggregateStore({ path, maxBytes: 4_000, now: () => 10_000 });
	await store.load();
	for (let index = 0; index < 200; index++) {
		store.record(observation(`provider-${index}`, `model-${index}`, 10_000));
	}
	await store.flush();
	const raw = await readFile(path, "utf8");
	assert.ok(Buffer.byteLength(raw, "utf8") <= 4_000);
	assert.equal(raw.includes("promptText"), false);
	assert.equal(raw.includes("secret"), false);
	assert.equal(store.getHealth(), "ok");
});

test("malformed storage is reported and can be replaced by a later bounded write", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-cache-observer-"));
	const path = join(directory, "stats.json");
	await writeFile(path, "not json", "utf8");
	const store = new AggregateStore({ path, now: () => 20_000 });
	await store.load();
	assert.equal(store.getHealth(), "malformed");
	store.record(observation("provider", "model", 20_000));
	await store.flush();
	assert.equal(store.getHealth(), "ok");
	assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
});
