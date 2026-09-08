/**
 * Model + thinking level section.
 *
 * Renders: ⚡ claude-sonnet-4 • medium
 * When thinking level is "off", hides the thinking suffix entirely.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { FooterSectionVariant, Section } from "../types.ts";

function compactThinkingLevel(thinkingLevel: string): string {
	if (thinkingLevel === "medium") return "med";
	return thinkingLevel;
}

export function createModelSection(pi: { getThinkingLevel(): string }): Section {
	return {
		id: "pi-footer:model",
		align: "right",
		order: 100,
		essential: true,
		variants: ["full", "compact"],

		render(ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string {
			const modelId = ctx.model?.id;
			if (!modelId) return theme.fg("muted", "no model");

			const thinking = pi.getThinkingLevel();
			if (variant === "compact") {
				let compactText = theme.fg("accent", modelId);
				if (thinking && thinking !== "off") {
					compactText += theme.fg("dim", " · ") + theme.fg("warning", compactThinkingLevel(thinking));
				}
				return compactText;
			}

			let text = theme.fg("accent", `⚡ ${modelId}`);
			const provider = ctx.model?.provider;
			if (provider) {
				text += theme.fg("muted", ` (${provider})`);
			}

			if (thinking && thinking !== "off") {
				text += theme.fg("dim", " • ") + theme.fg("warning", thinking);
			}

			return text;
		},
	};
}
