/**
 * Model + thinking level section.
 *
 * Renders: ⚡ claude-sonnet-4 • medium
 * When thinking level is "off", hides the thinking suffix entirely.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Section } from "../types.ts";

export function createModelSection(pi: { getThinkingLevel(): string }): Section {
	return {
		id: "pi-footer:model",
		align: "right",
		priority: 20,

		render(ctx: ExtensionContext, theme: Theme): string {
			const modelId = ctx.model?.id;
			if (!modelId) return theme.fg("muted", "no model");

			// Model name
			let text = theme.fg("accent", `⚡ ${modelId}`);

			// Provider in muted parentheses
			const provider = ctx.model?.provider;
			if (provider) {
				text += theme.fg("muted", ` (${provider})`);
			}

			// Thinking level (only when not "off")
			const thinking = pi.getThinkingLevel();
			if (thinking && thinking !== "off") {
				text += theme.fg("dim", " • ") + theme.fg("warning", thinking);
			}

			return text;
		},
	};
}
