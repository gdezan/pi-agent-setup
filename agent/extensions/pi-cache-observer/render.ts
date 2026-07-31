import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { fmtTokens } from "../pi-footer/renderers.ts";
import type { CacheObservation, CacheSessionTotals, ObserverSnapshot, OptimizerDecision } from "./types.ts";

function hitRateForTotals(totals: CacheSessionTotals): number | undefined {
	const promptTokens = totals.cacheReportedPromptTokens;
	return promptTokens > 0 ? totals.cacheRead / promptTokens : undefined;
}

function rateColor(rate: number | undefined): ThemeColor {
	if (rate === undefined) return "dim";
	if (rate >= 0.75) return "success";
	if (rate >= 0.4) return "warning";
	return "error";
}

export function formatCacheFooterText(totals: CacheSessionTotals): string {
	const rate = hitRateForTotals(totals);
	const rateText = rate === undefined ? "--" : `${Math.round(rate * 100)}%`;
	return `cache R/W ${fmtTokens(totals.cacheRead)}/${fmtTokens(totals.cacheWrite)} ${rateText} hit`;
}

export function renderCacheFooter(
	_ctx: ExtensionContext,
	theme: Theme,
	totals: CacheSessionTotals,
): string {
	const rate = hitRateForTotals(totals);
	const text = formatCacheFooterText(totals);
	return theme.fg(rateColor(rate), text);
}

function providerModel(observation: CacheObservation | undefined, ctx: ExtensionContext): string {
	return observation
		? `${observation.provider}/${observation.model}`
		: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "none";
}

export function formatCacheReport(snapshot: ObserverSnapshot, ctx: ExtensionContext): string {
	const last = snapshot.lastObservation;
	const rate = hitRateForTotals(snapshot.totals);
	const lines = [
		`current: ${last ? `${last.classification} ${fmtTokens(last.promptTokens)} tokens` : "no completed assistant turn"}`,
		`session: ${snapshot.totals.requests} requests, R/W ${fmtTokens(snapshot.totals.cacheRead)}/${fmtTokens(snapshot.totals.cacheWrite)}, hit ${rate === undefined ? "--" : `${Math.round(rate * 100)}%`}`,
		`baseline: ${snapshot.baseline ? `${snapshot.baseline.provider}/${snapshot.baseline.model} at ${fmtTokens(snapshot.baseline.promptTokens)} tokens` : snapshot.baselineReason ?? "none"}`,
		`last reason: ${last?.reasons.join(", ") || "none"}`,
		`provider/model: ${providerModel(last, ctx)}`,
	];
	return lines.join("\n");
}

function optimizerReasonText(decision: OptimizerDecision): string {
	return decision.reason.replaceAll("-", " ");
}

export function formatOptimizerPreview(decision: OptimizerDecision): string {
	return [
		`adapter: ${decision.adapter}`,
		`fields: ${decision.fields.join(", ")}`,
		`key source: ${decision.keySource === "project-config" ? "trusted project config" : "none"}`,
		`provider/model allowlist: ${decision.providerMatched && decision.modelMatched ? "exact match" : "no exact match"}`,
		`mode: ${decision.mode}`,
		`decision: ${decision.eligible ? "eligible" : "not eligible"} (${optimizerReasonText(decision)})`,
	].join("\n");
}

export function formatDoctor(snapshot: ObserverSnapshot, configSummary: string, ctx: ExtensionContext): string {
	const last = snapshot.lastObservation;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const cacheReporting = last
		? last.usage.cacheFieldsComplete
			? `yes; activity ${snapshot.cacheActivityObserved ? "observed" : "not observed"}`
			: "incomplete fields"
		: "no usage received";
	return [
		`provider/model: ${model}`,
		`cache reporting: ${cacheReporting}`,
		`config: ${configSummary}`,
		`optimizer: ${last && snapshot.lastOptimizerDecision ? formatOptimizerPreview(snapshot.lastOptimizerDecision).replaceAll("\n", "; ") : "no request inspected"}`,
		`storage: ${snapshot.storageHealth}`,
		...(snapshot.optimizerDiagnostics.length ? [`diagnostics: ${snapshot.optimizerDiagnostics.join(", ")}`] : []),
	].join("\n");
}
