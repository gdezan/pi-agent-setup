export type CacheClassification =
	| "unknown"
	| "unsupported"
	| "cache-write"
	| "cache-hit"
	| "partial-hit"
	| "miss";

export type CacheBoundaryReason =
	| "session-start"
	| "model-changed"
	| "session-compacted"
	| "session-tree-changed"
	| "manual-reset";

export interface NormalizedCacheUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheFieldsComplete: boolean;
	inputCost?: number;
}

export interface CacheBaseline {
	at: number;
	provider: string;
	model: string;
	promptTokens: number;
}

export interface CacheObservation {
	at: number;
	provider: string;
	model: string;
	usage: NormalizedCacheUsage;
	promptTokens: number;
	hitRate?: number;
	classification: CacheClassification;
	meaningfulMiss: boolean;
	reasons: string[];
	idleGapMs?: number;
	promptSizeChanged: boolean;
}

export interface CacheSessionTotals {
	requests: number;
	promptTokens: number;
	/** Prompt-token denominator from messages with complete cache fields. */
	cacheReportedPromptTokens: number;
	cacheRead: number;
	cacheWrite: number;
	unknown: number;
	unsupported: number;
	cacheWrites: number;
	cacheHits: number;
	partialHits: number;
	misses: number;
	meaningfulMisses: number;
}

export interface AggregateEntry {
	provider: string;
	model: string;
	firstSeen: number;
	lastSeen: number;
	requests: number;
	promptTokens: number;
	cacheRead: number;
	cacheWrite: number;
	unknown: number;
	unsupported: number;
	cacheWrites: number;
	cacheHits: number;
	partialHits: number;
	misses: number;
	meaningfulMisses: number;
	missedTokens: number;
	estimatedMissedCost: number;
	promptTokenBuckets: Record<string, number>;
}

export interface AggregateDocument {
	version: 1;
	updatedAt: number;
	entries: AggregateEntry[];
}

export interface OptimizerEntry {
	provider: string;
	model: string;
	promptCacheKey: string;
}

export type OptimizerMode = "off" | "preview" | "live";

export interface OptimizerConfig {
	mode: OptimizerMode;
	entries: OptimizerEntry[];
}

export interface LoadedProjectConfig {
	trusted: boolean;
	path: string;
	optimizer: OptimizerConfig;
	diagnostics: string[];
}

export interface OptimizerDecision {
	mode: OptimizerMode;
	adapter: "openai-compatible";
	eligible: boolean;
	mutated: boolean;
	providerMatched: boolean;
	modelMatched: boolean;
	fields: string[];
	keySource: "project-config" | "none";
	reason:
		| "not-allowlisted"
		| "optimizer-disabled"
		| "preview-only"
		| "payload-not-object"
		| "payload-model-missing"
		| "payload-model-mismatch"
		| "messages-missing"
		| "messages-unsupported"
		| "already-present"
		| "eligible"
		| "mutation-error";
}

export interface ObserverSnapshot {
	totals: CacheSessionTotals;
	lastObservation?: CacheObservation;
	baseline?: CacheBaseline;
	baselineReason?: CacheBoundaryReason;
	cacheActivityObserved: boolean;
	lastOptimizerDecision?: OptimizerDecision;
	optimizerDiagnostics: string[];
	storageHealth: "not-loaded" | "ok" | "malformed" | "unavailable" | "write-failed";
}
