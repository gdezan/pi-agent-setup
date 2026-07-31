import type {
	CacheBaseline,
	CacheClassification,
	CacheObservation,
	NormalizedCacheUsage,
} from "./types.ts";

export const CACHE_TOKEN_FLOOR = 1_024;
export const CACHE_IDLE_GAP_MS = 5 * 60 * 1_000;
export const CACHE_PROMPT_SIZE_CHANGE_RATIO = 0.1;

export interface CacheClassificationOptions {
	at: number;
	provider: string;
	model: string;
	baseline?: CacheBaseline;
	cacheActivityObserved: boolean;
	boundaryReason?: string;
	minimumPromptTokens?: number;
	idleGapMs?: number;
	promptSizeChangeRatio?: number;
}

export function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Normalize only the usage fields needed by the observer. */
export function normalizeCacheUsage(value: unknown): NormalizedCacheUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const input = finiteNonNegative(record.input);
	const output = finiteNonNegative(record.output);
	if (input === undefined || output === undefined) return undefined;

	const cacheRead = finiteNonNegative(record.cacheRead);
	const cacheWrite = finiteNonNegative(record.cacheWrite);
	const cost = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? (record.cost as Record<string, unknown>) : undefined;
	const inputCost = finiteNonNegative(cost?.input);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		inputCost,
		cacheFieldsComplete: cacheRead !== undefined && cacheWrite !== undefined,
	};
}

/** Pi's prompt-token accounting includes input, cache reads, and cache writes. */
export function calculatePromptTokens(usage: Pick<NormalizedCacheUsage, "input" | "cacheRead" | "cacheWrite">): number {
	return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export function calculateCacheHitRate(
	usage: Pick<NormalizedCacheUsage, "input" | "cacheRead" | "cacheWrite">,
): number | undefined {
	if (usage.cacheRead === undefined || usage.cacheWrite === undefined) return undefined;
	const promptTokens = calculatePromptTokens(usage);
	if (promptTokens === 0) return undefined;
	return usage.cacheRead / promptTokens;
}

function hasMeaningfulPromptSizeChange(previous: number, current: number, ratio: number): boolean {
	if (previous <= 0) return current > 0;
	return Math.abs(current - previous) / previous >= ratio;
}

function pushReason(reasons: string[], reason: string): void {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function classifyReportedUsage(
	usage: NormalizedCacheUsage,
	promptTokens: number,
	cacheActivityObserved: boolean,
	minimumPromptTokens: number,
): { classification: CacheClassification; meaningfulMiss: boolean } {
	if (!usage.cacheFieldsComplete) {
		return { classification: "unsupported", meaningfulMiss: false };
	}

	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	if (cacheRead > 0 && cacheWrite > 0) return { classification: "partial-hit", meaningfulMiss: false };
	if (cacheRead > 0) return { classification: "cache-hit", meaningfulMiss: false };
	if (cacheWrite > 0) return { classification: "cache-write", meaningfulMiss: false };

	if (!cacheActivityObserved) return { classification: "unsupported", meaningfulMiss: false };
	if (promptTokens < minimumPromptTokens) return { classification: "unknown", meaningfulMiss: false };
	return { classification: "miss", meaningfulMiss: true };
}

/**
 * Classify one completed assistant usage record.
 *
 * A baseline is deliberately required before classifying a turn. This keeps
 * the first request after startup, model changes, compaction, and tree
 * navigation from being presented as a provider miss.
 */
export function classifyCacheUsage(
	usage: NormalizedCacheUsage,
	options: CacheClassificationOptions,
): CacheObservation {
	const promptTokens = calculatePromptTokens(usage);
	const hitRate = calculateCacheHitRate(usage);
	const reasons: string[] = [];

	if (!usage.cacheFieldsComplete) pushReason(reasons, "provider-cache-fields-missing");

	const idleGapMs = options.baseline ? Math.max(0, options.at - options.baseline.at) : undefined;
	if (idleGapMs !== undefined && idleGapMs >= (options.idleGapMs ?? CACHE_IDLE_GAP_MS)) {
		pushReason(reasons, "idle-gap-over-five-minutes");
	}

	const promptSizeChanged = options.baseline
		? hasMeaningfulPromptSizeChange(
				options.baseline.promptTokens,
				promptTokens,
				options.promptSizeChangeRatio ?? CACHE_PROMPT_SIZE_CHANGE_RATIO,
			)
		: false;
	if (promptSizeChanged) pushReason(reasons, "prompt-size-changed");
	if (options.baseline && (options.baseline.provider !== options.provider || options.baseline.model !== options.model)) {
		pushReason(reasons, "provider-or-model-changed");
	}

	let classification: CacheClassification;
	let meaningfulMiss = false;
	if (!options.baseline) {
		classification = "unknown";
		pushReason(reasons, options.boundaryReason ?? "first-request");
	} else if (options.baseline.provider !== options.provider || options.baseline.model !== options.model) {
		classification = "unknown";
		pushReason(reasons, "baseline-reset-required");
	} else {
		const result = classifyReportedUsage(
			usage,
			promptTokens,
			options.cacheActivityObserved,
			options.minimumPromptTokens ?? CACHE_TOKEN_FLOOR,
		);
		classification = result.classification;
		meaningfulMiss = result.meaningfulMiss;

		if (classification === "unsupported" && usage.cacheFieldsComplete && !options.cacheActivityObserved) {
			pushReason(reasons, "no-cache-activity-observed");
		}
		if (classification === "unknown" && promptTokens < (options.minimumPromptTokens ?? CACHE_TOKEN_FLOOR)) {
			pushReason(reasons, "prompt-below-cache-floor");
		}
		if (meaningfulMiss) pushReason(reasons, "cache-read-near-zero");
	}

	return {
		at: options.at,
		provider: options.provider,
		model: options.model,
		usage,
		promptTokens,
		hitRate,
		classification,
		meaningfulMiss,
		reasons,
		idleGapMs,
		promptSizeChanged,
	};
}

export function createCacheBaseline(
	observation: Pick<CacheObservation, "at" | "provider" | "model" | "promptTokens">,
): CacheBaseline {
	return {
		at: observation.at,
		provider: observation.provider,
		model: observation.model,
		promptTokens: observation.promptTokens,
	};
}
