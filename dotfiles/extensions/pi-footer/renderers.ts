/**
 * Pure rendering helpers — no side effects, no theme imports.
 * All color decisions are driven by theme roles (no hardcoded ANSI).
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

// ── Token formatting ───────────────────────────────────────────────────

/** Format a token count for compact display: 1234 → "1.2k", 1234567 → "1.2M" */
export function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Format cost for compact display */
export function fmtCost(n: number): string {
	return `$${n.toFixed(3)}`;
}

// ── Color thresholds for context usage ─────────────────────────────────

/** Context usage thresholds: green < 50%, yellow 50-79%, red >= 80% */
export function colorForUsage(pct: number): ThemeColor {
	if (pct >= 80) return "error";
	if (pct >= 50) return "warning";
	return "success";
}

// ── Token accumulation ─────────────────────────────────────────────────

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		usage?: {
			input: number;
			output: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost: { total: number };
		};
	};
}

/** Sum cumulative token/cost stats from all assistant messages in session. */
export function accumulateSessionStats(entries: SessionEntry[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			const u = entry.message.usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead ?? 0;
			cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost.total;
		}
	}

	return { input, output, cacheRead, cacheWrite, cost };
}
