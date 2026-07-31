import {
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
	chmod,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { AggregateDocument, AggregateEntry, CacheObservation } from "./types.ts";

export const AGGREGATE_SCHEMA_VERSION = 1 as const;
export const AGGREGATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const AGGREGATE_MAX_BYTES = 1_000_000;
const MAX_BUCKETS_PER_ENTRY = 64;
const MAX_NAME_LENGTH = 120;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 2_000;

type AggregateStoreHealth = "not-loaded" | "ok" | "malformed" | "unavailable" | "write-failed";

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integerNonNegative(value: unknown): number | undefined {
	const number = finiteNonNegative(value);
	return number === undefined ? undefined : Math.floor(number);
}

function boundedName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim().slice(0, MAX_NAME_LENGTH);
	return name || undefined;
}

function emptyEntry(provider: string, model: string, at: number): AggregateEntry {
	return {
		provider,
		model,
		firstSeen: at,
		lastSeen: at,
		requests: 0,
		promptTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		unknown: 0,
		unsupported: 0,
		cacheWrites: 0,
		cacheHits: 0,
		partialHits: 0,
		misses: 0,
		meaningfulMisses: 0,
		missedTokens: 0,
		estimatedMissedCost: 0,
		promptTokenBuckets: {},
	};
}

export function createEmptyAggregateDocument(now = Date.now()): AggregateDocument {
	return { version: AGGREGATE_SCHEMA_VERSION, updatedAt: now, entries: [] };
}

function sanitizeBuckets(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const buckets: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!/^\d+$/.test(key)) continue;
		const count = integerNonNegative(raw);
		if (count !== undefined && count > 0) buckets[key] = count;
	}
	return Object.fromEntries(Object.entries(buckets).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, MAX_BUCKETS_PER_ENTRY));
}

function sanitizeEntry(value: unknown): AggregateEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const provider = boundedName(record.provider);
	const model = boundedName(record.model);
	const firstSeen = finiteNonNegative(record.firstSeen);
	const lastSeen = finiteNonNegative(record.lastSeen);
	if (!provider || !model || firstSeen === undefined || lastSeen === undefined) return undefined;

	const entry = emptyEntry(provider, model, Math.max(firstSeen, lastSeen));
	entry.firstSeen = Math.min(firstSeen, lastSeen);
	entry.lastSeen = Math.max(firstSeen, lastSeen);
	for (const key of [
		"requests",
		"promptTokens",
		"cacheRead",
		"cacheWrite",
		"unknown",
		"unsupported",
		"cacheWrites",
		"cacheHits",
		"partialHits",
		"misses",
		"meaningfulMisses",
		"missedTokens",
		"estimatedMissedCost",
	] as const) {
		const number = finiteNonNegative(record[key]);
		if (number !== undefined) entry[key] = number;
	}
	entry.promptTokenBuckets = sanitizeBuckets(record.promptTokenBuckets);
	return entry;
}

/** Parse only the versioned, redacted schema. Unknown fields are discarded. */
export function parseAggregateDocument(value: unknown, now = Date.now()): AggregateDocument | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== AGGREGATE_SCHEMA_VERSION || !Array.isArray(record.entries)) return undefined;
	const updatedAt = finiteNonNegative(record.updatedAt) ?? now;
	const byKey = new Map<string, AggregateEntry>();
	for (const raw of record.entries) {
		const entry = sanitizeEntry(raw);
		if (!entry) continue;
		const key = `${entry.provider}\0${entry.model}`;
		const current = byKey.get(key);
		byKey.set(key, current ? mergeAggregateEntries(current, entry) : entry);
	}
	return { version: AGGREGATE_SCHEMA_VERSION, updatedAt, entries: Array.from(byKey.values()) };
}

export function pruneAggregateDocument(
	document: AggregateDocument,
	now = Date.now(),
	retentionMs = AGGREGATE_RETENTION_MS,
): AggregateDocument {
	const cutoff = now - retentionMs;
	return {
		version: AGGREGATE_SCHEMA_VERSION,
		updatedAt: now,
		entries: document.entries
			.filter((entry) => entry.lastSeen >= cutoff)
			.sort((a, b) => b.lastSeen - a.lastSeen),
	};
}

function mergeAggregateEntries(left: AggregateEntry, right: AggregateEntry): AggregateEntry {
	const merged = emptyEntry(left.provider, left.model, Math.min(left.firstSeen, right.firstSeen));
	merged.firstSeen = Math.min(left.firstSeen, right.firstSeen);
	merged.lastSeen = Math.max(left.lastSeen, right.lastSeen);
	for (const key of [
		"requests",
		"promptTokens",
		"cacheRead",
		"cacheWrite",
		"unknown",
		"unsupported",
		"cacheWrites",
		"cacheHits",
		"partialHits",
		"misses",
		"meaningfulMisses",
		"missedTokens",
		"estimatedMissedCost",
	] as const) {
		merged[key] = left[key] + right[key];
	}
	merged.promptTokenBuckets = { ...left.promptTokenBuckets };
	for (const [bucket, count] of Object.entries(right.promptTokenBuckets)) {
		merged.promptTokenBuckets[bucket] = (merged.promptTokenBuckets[bucket] ?? 0) + count;
	}
	merged.promptTokenBuckets = sanitizeBuckets(merged.promptTokenBuckets);
	return merged;
}

function promptBucket(promptTokens: number): string {
	return String(Math.floor(promptTokens / 1_000) * 1_000);
}

/** Add one observation to an aggregate entry without retaining request data. */
export function aggregateObservation(observation: CacheObservation): AggregateEntry {
	const entry = emptyEntry(observation.provider.slice(0, MAX_NAME_LENGTH), observation.model.slice(0, MAX_NAME_LENGTH), observation.at);
	entry.requests = 1;
	entry.promptTokens = observation.promptTokens;
	entry.cacheRead = observation.usage.cacheRead ?? 0;
	entry.cacheWrite = observation.usage.cacheWrite ?? 0;
	entry[observation.classification === "unknown" ? "unknown" : observation.classification === "unsupported" ? "unsupported" : observation.classification === "cache-write" ? "cacheWrites" : observation.classification === "cache-hit" ? "cacheHits" : observation.classification === "partial-hit" ? "partialHits" : "misses"] = 1;
	entry.meaningfulMisses = observation.meaningfulMiss ? 1 : 0;
	entry.missedTokens = observation.meaningfulMiss ? observation.promptTokens : 0;
	entry.estimatedMissedCost = observation.meaningfulMiss ? observation.usage.inputCost ?? 0 : 0;
	entry.promptTokenBuckets[promptBucket(observation.promptTokens)] = 1;
	return entry;
}

function mergeDocuments(document: AggregateDocument, delta: Map<string, AggregateEntry>, now: number): AggregateDocument {
	const byKey = new Map(document.entries.map((entry) => [`${entry.provider}\0${entry.model}`, entry]));
	for (const [key, value] of delta) {
		const current = byKey.get(key);
		byKey.set(key, current ? mergeAggregateEntries(current, value) : value);
	}
	return { version: AGGREGATE_SCHEMA_VERSION, updatedAt: now, entries: Array.from(byKey.values()) };
}

function boundedDocument(document: AggregateDocument, maxBytes: number): AggregateDocument {
	let entries = [...document.entries].sort((a, b) => b.lastSeen - a.lastSeen);
	const make = (): AggregateDocument => ({ ...document, entries });
	while (entries.length > 0 && Buffer.byteLength(`${JSON.stringify(make(), null, 2)}\n`, "utf8") > maxBytes) entries = entries.slice(0, -1);
	return make();
}

async function readDisk(path: string, now: number): Promise<AggregateDocument | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return parseAggregateDocument(JSON.parse(raw), now);
	} catch {
		return undefined;
	}
}

async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const started = Date.now();
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - started >= LOCK_TIMEOUT_MS) throw error;
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await work();
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function writeAtomic(path: string, document: AggregateDocument): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(temporaryPath, 0o600).catch(() => undefined);
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export interface AggregateStoreOptions {
	path: string;
	now?: () => number;
	retentionMs?: number;
	maxBytes?: number;
}

/** Bounded, redacted, lock-protected aggregate persistence. */
export class AggregateStore {
	private readonly options: AggregateStoreOptions;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxBytes: number;
	private document: AggregateDocument;
	private pending = new Map<string, AggregateEntry>();
	private needsWrite = false;
	private health: AggregateStoreHealth = "not-loaded";

	constructor(options: AggregateStoreOptions) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
		this.retentionMs = options.retentionMs ?? AGGREGATE_RETENTION_MS;
		this.maxBytes = options.maxBytes ?? AGGREGATE_MAX_BYTES;
		this.document = createEmptyAggregateDocument(this.now());
	}

	getHealth(): AggregateStoreHealth {
		return this.health;
	}

	getDocument(): AggregateDocument {
		return this.document;
	}

	async load(): Promise<AggregateDocument> {
		const now = this.now();
		try {
			const raw = await readFile(this.options.path, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				this.document = createEmptyAggregateDocument(now);
				this.health = "malformed";
				return this.document;
			}
			const document = parseAggregateDocument(parsed, now);
			if (!document) {
				this.document = createEmptyAggregateDocument(now);
				this.health = "malformed";
				return this.document;
			}
			this.document = pruneAggregateDocument(document, now, this.retentionMs);
			this.needsWrite = this.document.entries.length !== document.entries.length;
			this.health = "ok";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.document = createEmptyAggregateDocument(now);
				this.health = "ok";
			} else {
				this.document = createEmptyAggregateDocument(now);
				this.health = "unavailable";
			}
		}
		return this.document;
	}

	record(observation: CacheObservation): void {
		const delta = aggregateObservation(observation);
		const key = `${delta.provider}\0${delta.model}`;
		const current = this.pending.get(key);
		this.pending.set(key, current ? mergeAggregateEntries(current, delta) : delta);
		this.document = mergeDocuments(this.document, new Map([[key, delta]]), this.now());
		this.document = pruneAggregateDocument(this.document, this.now(), this.retentionMs);
		this.needsWrite = true;
	}

	async flush(): Promise<void> {
		if (!this.needsWrite && this.pending.size === 0) return;
		try {
			await withFileLock(this.options.path, async () => {
				const disk = (await readDisk(this.options.path, this.now())) ?? createEmptyAggregateDocument(this.now());
				const merged = pruneAggregateDocument(mergeDocuments(disk, this.pending, this.now()), this.now(), this.retentionMs);
				const bounded = boundedDocument(merged, this.maxBytes);
				await writeAtomic(this.options.path, bounded);
				this.document = bounded;
				this.pending.clear();
				this.needsWrite = false;
				this.health = "ok";
			});
		} catch {
			this.health = "write-failed";
		}
	}

	async clear(): Promise<boolean> {
		try {
			await withFileLock(this.options.path, async () => {
				await rm(this.options.path, { force: true });
			});
			this.document = createEmptyAggregateDocument(this.now());
			this.pending.clear();
			this.needsWrite = false;
			this.health = "ok";
			return true;
		} catch {
			this.health = "write-failed";
			return false;
		}
	}
}
