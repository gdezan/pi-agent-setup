/**
 * Context usage section.
 *
 * Renders: 68k/200k  with color thresholds
 *
 * Values are real token counts (not percentage).
 * Color: green < 50%, yellow 50-79%, red >= 80%.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Section } from "../types.ts";
import { colorForUsage, fmtTokens } from "../renderers.ts";

export function createContextSection(): Section {
	return {
		id: "pi-footer:context",
		align: "left",
		order: 20,
		essential: true,
		variants: ["full"],

		render(ctx: ExtensionContext, theme: Theme): string {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const windowStr = fmtTokens(contextWindow);

			// Use tokens directly if available, fall back to computing from percent
			if (usage?.tokens != null && contextWindow > 0) {
				const usedStr = fmtTokens(usage.tokens);
				const percent = (usage.tokens / contextWindow) * 100;
				const display = `${usedStr}/${windowStr}`;
				return theme.fg(colorForUsage(percent), display);
			}

			// After compaction tokens may be unknown — try percent as fallback
			if (usage?.percent != null && contextWindow > 0) {
				const used = Math.round((usage.percent / 100) * contextWindow);
				const usedStr = fmtTokens(used);
				const display = `${usedStr}/${windowStr}`;
				return theme.fg(colorForUsage(usage.percent), display);
			}

			// No data available
			return theme.fg("dim", `?/${windowStr}`);
		},
	};
}
