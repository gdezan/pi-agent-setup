/**
 * Context usage section.
 *
 * Renders: 68k/200k  with color thresholds
 *
 * Values are token counts (not percentages); ~ marks a local estimate.
 * Color: green < 50%, yellow 50-79%, red >= 80%.
 */

import {
  estimateTokens,
  sessionEntryToContextMessages,
  type ExtensionContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Section } from "../types.ts";
import { colorForUsage, fmtTokens } from "../renderers.ts";

const MOLT_CONTEXT_PROJECTION_TYPE = "molt-context-projection";

/** Context budget resolved from provider usage or an honest post-pruning estimate. */
export interface FooterContextBudget {
  tokens: number | null;
  contextWindow: number;
  estimated: boolean;
}

type MoltProjectionValue =
  | string
  | number
  | boolean
  | null
  | MoltProjectionValue[]
  | { [key: string]: MoltProjectionValue };

type MoltProjectionRecord = Record<string, MoltProjectionValue>;

interface ValidMoltProjectionBudget extends MoltProjectionRecord {
  sequence: number;
  removedEntryIds: string[];
  tokensAfter: number;
}

const STRING_TAG = "[object String]";
const NUMBER_TAG = "[object Number]";

function isProjectionString<T>(value: T): value is T & string {
  return Object.prototype.toString.call(value) === STRING_TAG;
}

function isNonEmptyProjectionString<T>(value: T): value is T & string {
  return isProjectionString(value) && value.length > 0;
}

function isProjectionNumber<T>(value: T): value is T & number {
  return Object.prototype.toString.call(value) === NUMBER_TAG;
}

function isProjectionRecord<T>(value: T): value is T & MoltProjectionRecord {
  return (
    value !== null &&
    Object(value) === value &&
    !(value instanceof Function) &&
    !Array.isArray(value)
  );
}

function isFiniteNonNegative<T>(value: T): value is T & number {
  return isProjectionNumber(value) && Number.isFinite(value) && value >= 0;
}

function isProbability<T>(value: T): value is T & number {
  return isFiniteNonNegative(value) && value <= 1;
}

function hasValidProjectionUsage(value: MoltProjectionValue): boolean {
  if (!isProjectionRecord(value)) return false;
  return (
    (value.inputTokens === null || isFiniteNonNegative(value.inputTokens)) &&
    (value.outputTokens === null || isFiniteNonNegative(value.outputTokens))
  );
}

function isValidProjectionScore(value: MoltProjectionValue): boolean {
  if (!isProjectionRecord(value) || !isNonEmptyProjectionString(value.groupId)) return false;
  if (
    !Array.isArray(value.sourceEntryIds) ||
    !value.sourceEntryIds.every(isNonEmptyProjectionString)
  )
    return false;
  if (value.probability !== null && !isProbability(value.probability)) return false;
  return value.decision === "remove" || value.decision === "keep" || value.decision === "error";
}

function hasValidProjectionIdentity(record: MoltProjectionRecord): boolean {
  return (
    record.version === 1 &&
    isProjectionNumber(record.sequence) &&
    Number.isInteger(record.sequence) &&
    record.sequence >= 1
  );
}

function hasValidProjectionRemovedIds(record: MoltProjectionRecord): boolean {
  const removedEntryIds = record.removedEntryIds;
  return (
    Array.isArray(removedEntryIds) &&
    removedEntryIds.length > 0 &&
    removedEntryIds.every(isNonEmptyProjectionString) &&
    new Set(removedEntryIds).size === removedEntryIds.length
  );
}

function hasValidProjectionMeasurements(record: MoltProjectionRecord): boolean {
  return (
    isFiniteNonNegative(record.tokensBefore) &&
    isFiniteNonNegative(record.tokensAfter) &&
    isFiniteNonNegative(record.reductionTokens) &&
    isFiniteNonNegative(record.elapsedMs) &&
    isProjectionNumber(record.jevRequestCount) &&
    Number.isInteger(record.jevRequestCount) &&
    record.jevRequestCount >= 0 &&
    hasValidProjectionUsage(record.jevUsage) &&
    isFiniteNonNegative(record.jevCostUsd)
  );
}

function hasValidProjectionRunContext(record: MoltProjectionRecord): boolean {
  return (
    isNonEmptyProjectionString(record.jevModel) &&
    isProbability(record.removalCutoff) &&
    isFiniteNonNegative(record.triggerTokens) &&
    isFiniteNonNegative(record.fallbackBoundaryTokens) &&
    record.outcome === "committed" &&
    isFiniteNonNegative(record.timestamp) &&
    Array.isArray(record.scores) &&
    record.scores.every(isValidProjectionScore)
  );
}

function extendsPreviousProjection(
  record: MoltProjectionRecord,
  previous: ValidMoltProjectionBudget,
): boolean {
  if (!isProjectionNumber(record.sequence) || record.sequence <= previous.sequence) return false;
  if (!Array.isArray(record.removedEntryIds)) return false;
  const currentIds = new Set(record.removedEntryIds);
  return previous.removedEntryIds.every((id) => currentIds.has(id));
}

function isValidMoltProjectionBudget<T>(
  value: T,
  previous: ValidMoltProjectionBudget | undefined,
): value is T & ValidMoltProjectionBudget {
  if (!isProjectionRecord(value)) return false;
  if (
    !hasValidProjectionIdentity(value) ||
    !hasValidProjectionRemovedIds(value) ||
    !hasValidProjectionMeasurements(value) ||
    !hasValidProjectionRunContext(value) ||
    (previous !== undefined && !extendsPreviousProjection(value, previous))
  ) {
    return false;
  }
  return true;
}

function validAssistantUsageAfter(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") return false;
  const usage = entry.message.usage;
  return (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0;
}

function readPendingMoltProjectionTokens(branch: SessionEntry[]): number | undefined {
  let projectedTokens: number | undefined;
  let previousProjection: ValidMoltProjectionBudget | undefined;
  for (const entry of branch) {
    if (entry.type === "compaction") {
      projectedTokens = undefined;
      continue;
    }
    if (validAssistantUsageAfter(entry)) {
      projectedTokens = undefined;
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== MOLT_CONTEXT_PROJECTION_TYPE) continue;
    if (!isValidMoltProjectionBudget(entry.data, previousProjection)) return undefined;
    previousProjection = entry.data;
    projectedTokens = entry.data.tokensAfter;
  }
  return projectedTokens;
}

function estimateCompactedContextTokens(ctx: ExtensionContext): number | null {
  try {
    const messages = ctx.sessionManager
      .buildContextEntries()
      .flatMap(sessionEntryToContextMessages);
    return messages.reduce((total, message) => total + estimateTokens(message), 0);
  } catch {
    return null;
  }
}

/** Resolve the provider-visible context budget, including the gap before post-pruning provider usage exists. */
export function resolveFooterContextBudget(ctx: ExtensionContext): FooterContextBudget | undefined {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (contextWindow <= 0) return undefined;

  const projectedTokens = readPendingMoltProjectionTokens(ctx.sessionManager.getBranch());
  if (projectedTokens !== undefined) {
    return {
      tokens: projectedTokens,
      contextWindow,
      estimated: true,
    };
  }

  if (usage?.tokens != null) {
    return { tokens: usage.tokens, contextWindow, estimated: false };
  }

  if (usage?.percent != null) {
    const tokens = Math.round((usage.percent / 100) * contextWindow);
    return { tokens, contextWindow, estimated: true };
  }

  const compactedEstimate = estimateCompactedContextTokens(ctx);
  if (compactedEstimate !== null) {
    return {
      tokens: compactedEstimate,
      contextWindow,
      estimated: true,
    };
  }

  return { tokens: null, contextWindow, estimated: false };
}

export function createContextSection(): Section {
  return {
    id: "pi-footer:context",
    align: "left",
    order: 20,
    essential: true,
    variants: ["full"],

    render(ctx: ExtensionContext, theme: Theme): string {
      const usage = resolveFooterContextBudget(ctx);
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const windowStr = fmtTokens(contextWindow);

      // Use tokens directly when available, marking post-pruning estimates.
      if (usage?.tokens != null && contextWindow > 0) {
        const usedStr = fmtTokens(usage.tokens);
        const percent = (usage.tokens / contextWindow) * 100;
        const display = `${usage.estimated ? "~" : ""}${usedStr}/${windowStr}`;
        return theme.fg(colorForUsage(percent), display);
      }

      // No data available
      return theme.fg("dim", `?/${windowStr}`);
    },
  };
}
