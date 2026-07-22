/**
 * Token I/O + cost section.
 *
 * Renders: ↑12.4k ↓3.2k $0.042
 *
 * Accumulates from all assistant messages in the current session branch.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Section } from "../types.ts";
import { accumulateSessionStats, fmtCost, fmtTokens } from "../renderers.ts";

export function createTokensSection(): Section {
	return {
		id: "pi-footer:tokens",
		align: "right",
		priority: 10,

		render(ctx: ExtensionContext, theme: Theme): string {
			const entries = ctx.sessionManager.getBranch();
			const stats = accumulateSessionStats(entries);

			if (stats.input === 0 && stats.output === 0 && stats.cost === 0) {
				return theme.fg("muted", "↑0 ↓0 $0.000");
			}

			const parts: string[] = [];

			if (stats.input > 0 || stats.output > 0) {
				parts.push(theme.fg("success", "↑" + fmtTokens(stats.input)));
				parts.push(theme.fg("success", "↓" + fmtTokens(stats.output)));
			}

			if (stats.cost > 0) {
				parts.push(theme.fg("muted", fmtCost(stats.cost)));
			}

			return parts.join(" ");
		},
	};
}
