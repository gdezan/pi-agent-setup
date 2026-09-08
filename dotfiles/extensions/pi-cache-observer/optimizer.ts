import type { OptimizerConfig, OptimizerDecision, OptimizerEntry } from "./types.ts";

export interface OptimizerModelContext {
	provider: string | undefined;
	model: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findOptimizerEntry(
	config: OptimizerConfig,
	provider: string | undefined,
	model: string | undefined,
): OptimizerEntry | undefined {
	if (!provider || !model) return undefined;
	return config.entries.find((entry) => entry.provider === provider && entry.model === model);
}

function baseDecision(config: OptimizerConfig, providerMatched: boolean, modelMatched: boolean): OptimizerDecision {
	return {
		mode: config.mode,
		adapter: "openai-compatible",
		eligible: false,
		mutated: false,
		providerMatched,
		modelMatched,
		fields: ["prompt_cache_key"],
		keySource: providerMatched && modelMatched ? "project-config" : "none",
		reason: "not-allowlisted",
	};
}

/**
 * Check a payload without reading, logging, or serializing its contents.
 * The accepted shape is intentionally limited to the verified OpenAI chat
 * payload shape: an object with a string model and messages array.
 */
export function decideCacheKeyMutation(
	payload: unknown,
	modelContext: OptimizerModelContext,
	config: OptimizerConfig,
): OptimizerDecision {
	const entry = findOptimizerEntry(config, modelContext.provider, modelContext.model);
	const providerMatched = Boolean(modelContext.provider && config.entries.some((candidate) => candidate.provider === modelContext.provider));
	const modelMatched = Boolean(entry);
	const decision = baseDecision(config, providerMatched, modelMatched);
	if (!entry) return decision;
	if (config.mode === "off") {
		decision.reason = "optimizer-disabled";
		return decision;
	}
	if (!isRecord(payload)) {
		decision.reason = "payload-not-object";
		return decision;
	}
	if (typeof payload.model !== "string") {
		decision.reason = "payload-model-missing";
		return decision;
	}
	if (payload.model !== entry.model) {
		decision.reason = "payload-model-mismatch";
		return decision;
	}
	if (!Array.isArray(payload.messages)) {
		decision.reason = "messages-missing";
		return decision;
	}
	if (payload.messages.some((message) => !isRecord(message))) {
		decision.reason = "messages-unsupported";
		return decision;
	}
	if (Object.prototype.hasOwnProperty.call(payload, "prompt_cache_key")) {
		decision.reason = "already-present";
		decision.eligible = true;
		return decision;
	}
	decision.eligible = true;
	decision.reason = config.mode === "preview" ? "preview-only" : "eligible";
	return decision;
}

export interface OptimizerResult {
	payload: unknown;
	decision: OptimizerDecision;
}

/** Apply only the configured field, returning the original payload on every failure. */
export function applyCacheKeyOptimizer(
	payload: unknown,
	modelContext: OptimizerModelContext,
	config: OptimizerConfig,
): OptimizerResult {
	let decision: OptimizerDecision;
	try {
		decision = decideCacheKeyMutation(payload, modelContext, config);
	} catch {
		return { payload, decision: { ...baseDecision(config, false, false), reason: "mutation-error" } };
	}
	if (config.mode !== "live" || !decision.eligible || decision.reason === "already-present") return { payload, decision };
	try {
		const entry = findOptimizerEntry(config, modelContext.provider, modelContext.model);
		if (!entry || !isRecord(payload)) {
			return { payload, decision: { ...decision, eligible: false, reason: "mutation-error" } };
		}
		const nextPayload = { ...payload, prompt_cache_key: entry.promptCacheKey };
		return { payload: nextPayload, decision: { ...decision, mutated: true, reason: "eligible" } };
	} catch {
		return { payload, decision: { ...decision, eligible: false, reason: "mutation-error" } };
	}
}

/** Build a structural preview when no provider payload has been observed yet. */
export function previewNextOptimizerDecision(
	modelContext: OptimizerModelContext,
	config: OptimizerConfig,
): OptimizerDecision {
	const entry = findOptimizerEntry(config, modelContext.provider, modelContext.model);
	const providerMatched = Boolean(modelContext.provider && config.entries.some((candidate) => candidate.provider === modelContext.provider));
	const modelMatched = Boolean(entry);
	const decision = baseDecision(config, providerMatched, modelMatched);
	if (!entry) return decision;
	if (config.mode === "off") {
		decision.reason = "optimizer-disabled";
		return decision;
	}
	decision.eligible = true;
	decision.reason = "payload-model-missing";
	return decision;
}
