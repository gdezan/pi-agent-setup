import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Footer } from "../pi-footer/footer.ts";
import { AggregateStore } from "./aggregates.ts";
import { CacheAlertDeduplicator } from "./alerts.ts";
import { loadProjectConfig } from "./config.ts";
import {
	calculatePromptTokens,
	classifyCacheUsage,
	createCacheBaseline,
	normalizeCacheUsage,
} from "./classifier.ts";
import { applyCacheKeyOptimizer, previewNextOptimizerDecision } from "./optimizer.ts";
import { formatCacheFooterText, formatCacheReport, formatDoctor, formatOptimizerPreview, renderCacheFooter } from "./render.ts";
import type {
	CacheBoundaryReason,
	CacheSessionTotals,
	LoadedProjectConfig,
	ObserverSnapshot,
	OptimizerDecision,
} from "./types.ts";

const FOOTER_ID = "pi-cache-observer";
const STATUS_ID = "pi-cache-observer";
const AGGREGATE_FILE = "prompt-cache-stats.json";

function createSessionTotals(): CacheSessionTotals {
	return {
		requests: 0,
		promptTokens: 0,
		cacheReportedPromptTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		unknown: 0,
		unsupported: 0,
		cacheWrites: 0,
		cacheHits: 0,
		partialHits: 0,
		misses: 0,
		meaningfulMisses: 0,
	};
}

function trustedProject(ctx: ExtensionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}

function messageUsage(message: unknown) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	return normalizeCacheUsage(record.usage);
}

function configSummary(config: LoadedProjectConfig, provider: string | undefined, model: string | undefined): string {
	const exact = config.optimizer.entries.some((entry) => entry.provider === provider && entry.model === model);
	return `${config.trusted ? "trusted" : "untrusted"}; optimizer ${config.optimizer.mode}; exact allowlist ${exact ? "yes" : "no"}`;
}

export default function piCacheObserver(pi: ExtensionAPI): void {
	let config: LoadedProjectConfig = {
		trusted: false,
		path: "",
		optimizer: { mode: "off", entries: [] },
		diagnostics: [],
	};
	let store = new AggregateStore({ path: join(getAgentDir(), AGGREGATE_FILE) });
	let totals = createSessionTotals();
	let baseline: ObserverSnapshot["baseline"];
	let baselineReason: CacheBoundaryReason | undefined = "session-start";
	let cacheActivityObserved = false;
	let lastObservation: ObserverSnapshot["lastObservation"];
	let lastOptimizerDecision: OptimizerDecision | undefined;
	let optimizerDiagnostics: string[] = [];
	const alertDeduplicator = new CacheAlertDeduplicator();
	let storageHealth: ObserverSnapshot["storageHealth"] = "not-loaded";

	const snapshot = (): ObserverSnapshot => ({
		totals,
		lastObservation,
		baseline,
		baselineReason,
		cacheActivityObserved,
		lastOptimizerDecision,
		optimizerDiagnostics,
		storageHealth,
	});

	const invalidate = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_ID, formatCacheFooterText(totals));
		Footer.invalidate();
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const resetBaseline = (reason: CacheBoundaryReason, clearActivity: boolean): void => {
		baseline = undefined;
		baselineReason = reason;
		if (clearActivity) cacheActivityObserved = false;
	};

	const reloadConfig = async (ctx: ExtensionContext): Promise<void> => {
		config = await loadProjectConfig(ctx.cwd, trustedProject(ctx));
		optimizerDiagnostics = config.diagnostics.slice();
	};

	Footer.registerSection({
		id: FOOTER_ID,
		align: "right",
		priority: 15,
		render: (ctx, theme) => renderCacheFooter(ctx, theme, totals),
	});

	pi.on("session_start", async (_event, ctx) => {
		totals = createSessionTotals();
		lastObservation = undefined;
		lastOptimizerDecision = undefined;
		alertDeduplicator.reset();
		resetBaseline("session-start", true);
		store = new AggregateStore({ path: join(getAgentDir(), AGGREGATE_FILE) });
		await reloadConfig(ctx);
		await store.load();
		storageHealth = store.getHealth();
		invalidate(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		resetBaseline("model-changed", true);
		await reloadConfig(ctx);
		invalidate(ctx);
		if (event.previousModel) notify(ctx, `Cache baseline reset: ${event.model.provider}/${event.model.id}`, "info");
	});

	pi.on("session_compact", async (_event, ctx) => {
		resetBaseline("session-compacted", false);
		invalidate(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetBaseline("session-tree-changed", false);
		invalidate(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const usage = messageUsage(event.message);
		if (!usage) return;

		const at = Date.now();
		const provider = ctx.model?.provider ?? "unknown";
		const model = ctx.model?.id ?? "unknown";
		if (baseline && (baseline.provider !== provider || baseline.model !== model)) {
			resetBaseline("model-changed", true);
		}
		const observation = classifyCacheUsage(usage, {
			at,
			provider,
			model,
			baseline,
			cacheActivityObserved,
			boundaryReason: baselineReason,
		});

		lastObservation = observation;
		baseline = createCacheBaseline(observation);
		baselineReason = undefined;
		if (usage.cacheFieldsComplete && ((usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0)) {
			cacheActivityObserved = true;
		}

		totals.requests += 1;
		totals.promptTokens += calculatePromptTokens(usage);
		if (usage.cacheFieldsComplete) totals.cacheReportedPromptTokens += calculatePromptTokens(usage);
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		if (observation.classification === "unknown") totals.unknown += 1;
		if (observation.classification === "unsupported") totals.unsupported += 1;
		if (observation.classification === "cache-write") totals.cacheWrites += 1;
		if (observation.classification === "cache-hit") totals.cacheHits += 1;
		if (observation.classification === "partial-hit") totals.partialHits += 1;
		if (observation.classification === "miss") totals.misses += 1;
		if (observation.meaningfulMiss) totals.meaningfulMisses += 1;

		store.record(observation);
		storageHealth = store.getHealth();

		if (observation.meaningfulMiss) {
			if (alertDeduplicator.shouldAlert(observation)) {
				notify(
					ctx,
					`Prompt cache miss: ${model} · ${Math.round(observation.promptTokens)} tokens · ${observation.reasons.join(", ")}`,
					"warning",
				);
			}
		}
		invalidate(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const result = applyCacheKeyOptimizer(
				event.payload,
				{ provider: ctx.model?.provider, model: ctx.model?.id },
				config.optimizer,
			);
			lastOptimizerDecision = result.decision;
			if (result.decision.reason === "mutation-error") {
				optimizerDiagnostics = [...new Set([...optimizerDiagnostics, "optimizer-mutation-error"])];
			}
			invalidate(ctx);
			return result.payload;
		} catch {
			optimizerDiagnostics = [...new Set([...optimizerDiagnostics, "optimizer-failure-original-payload-preserved"])];
			lastOptimizerDecision = {
				mode: config.optimizer.mode,
				adapter: "openai-compatible",
				eligible: false,
				mutated: false,
				providerMatched: false,
				modelMatched: false,
				fields: ["prompt_cache_key"],
				keySource: "none",
				reason: "mutation-error",
			};
			return event.payload;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await store.flush();
		storageHealth = store.getHealth();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
		Footer.unregisterSection(FOOTER_ID);
	});

	const subcommands = ["doctor", "optimize preview", "reset", "clear"];
	pi.registerCommand("cache", {
		description: "Inspect prompt-cache usage and optimizer state",
		getArgumentCompletions: (prefix) => subcommands.filter((item) => item.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command) {
				notify(ctx, formatCacheReport(snapshot(), ctx));
				return;
			}
			if (command === "reset") {
				resetBaseline("manual-reset", true);
				alertDeduplicator.reset();
				invalidate(ctx);
				notify(ctx, "Prompt-cache baseline and alert deduplication reset.");
				return;
			}
			if (command === "clear") {
				if (!ctx.hasUI) {
					notify(ctx, "Persisted prompt-cache aggregates require interactive confirmation to delete.", "warning");
					return;
				}
				const confirmed = await ctx.ui.confirm("Clear prompt-cache aggregates?", "This deletes the global 30-day aggregate file.");
				if (!confirmed) return;
				const cleared = await store.clear();
				storageHealth = store.getHealth();
				notify(ctx, cleared ? "Persisted prompt-cache aggregates deleted." : "Could not delete prompt-cache aggregates.", cleared ? "info" : "error");
				return;
			}
			if (command === "doctor") {
				await reloadConfig(ctx);
				const model = ctx.model;
				const exact = config.optimizer.entries.some((entry) => entry.provider === model?.provider && entry.model === model?.id);
				const summary = configSummary(config, model?.provider, model?.id) + (exact ? "" : " (no mutation eligible)");
				notify(ctx, formatDoctor(snapshot(), summary, ctx));
				return;
			}
			if (command === "optimize preview") {
				await reloadConfig(ctx);
				const decision = lastOptimizerDecision ?? previewNextOptimizerDecision(
					{ provider: ctx.model?.provider, model: ctx.model?.id },
					config.optimizer,
				);
				notify(ctx, formatOptimizerPreview(decision));
				return;
			}
			notify(ctx, "Usage: /cache, /cache doctor, /cache optimize preview, /cache reset, or /cache clear", "warning");
		},
	});
}
