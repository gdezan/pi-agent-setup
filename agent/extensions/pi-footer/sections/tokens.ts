/**
 * Token I/O + cost section.
 *
 * Renders: ↑12.4k ↓3.2k $0.042
 *
 * Accumulates from all assistant messages in the current session branch.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { FooterSectionVariant, Section } from "../types.ts";
import { accumulateSessionStats, fmtCost, fmtTokens } from "../renderers.ts";

export function createTokensSection(): Section {
	return {
		id: "pi-footer:tokens",
		align: "right",
		order: 10,
		variants: ["compact", "minimal"],

		render(ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string {
			const entries = ctx.sessionManager.getBranch();
			const stats = accumulateSessionStats(entries);
			const tokenColor = stats.input === 0 && stats.output === 0 ? "muted" : "success";
			const tokenText = theme.fg(tokenColor, `↑${fmtTokens(stats.input)} ↓${fmtTokens(stats.output)}`);

			if (variant === "minimal") return tokenText;
			return `${tokenText} ${theme.fg("muted", fmtCost(stats.cost))}`;
		},
	};
}
