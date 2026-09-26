/**
 * pi-footer — composable footer status bar.
 *
 * Replaces pi's default footer with a powerline-style status bar while
 * preserving statuses published by ordinary extensions when enabled. General
 * statuses are hidden by default and can be toggled with /footer-statuses.
 *
 * Other extensions can register custom sections via:
 *   import { Footer } from "../pi-footer/footer.ts";
 *   Footer.registerSection({ id, align, order, render, dispose? });
 *
 * Note: pi's setFooter() API is singleton-style. Two unrelated custom-footer
 * extensions cannot be transparently composed; the last one installed wins.
 *
 * Commands:
 *   /footer — toggle custom footer on/off
 *   /footer-statuses — toggle ordinary extension statuses
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Footer } from "./footer.ts";
import { createPathSection } from "./sections/path.ts";
import { createContextSection } from "./sections/context.ts";
import { createTokensSection } from "./sections/tokens.ts";
import { createModelSection } from "./sections/model.ts";

export { Footer } from "./footer.ts";


export default function (pi: ExtensionAPI) {
	let enabled = true;
	let showStatuses = false;
	let activeHandles: Array<{ unregister(): void }> = [];

	const pathSection = createPathSection();
	const contextSection = createContextSection();
	const tokensSection = createTokensSection();
	const modelSection = createModelSection(pi);

	function unregisterBuiltins(): void {
		for (const handle of activeHandles) handle.unregister();
		activeHandles = [];
	}

	function teardownWidget(ctx: ExtensionContext): void {
		ctx.ui.setFooter(undefined);
		unregisterBuiltins();
	}

	function setupWidget(ctx: ExtensionContext): void {
		unregisterBuiltins();

		// Keep ownership handles so teardown cannot remove a section that another
		// extension registered later with the same id.
		activeHandles = [
			Footer.registerSection(pathSection),
			Footer.registerSection(contextSection),
			Footer.registerSection(tokensSection),
			Footer.registerSection(modelSection),
		];

		pathSection.setCwd(ctx.cwd);
		pathSection.setInvalidate(() => Footer.invalidate());

		ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			const unsubscribe = Footer.onInvalidate(() => tui.requestRender());
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				render(width: number): string[] {
					if (!enabled) return [];
					try {
						const statuses = showStatuses
							? Array.from(footerData.getExtensionStatuses().values()).sort()
							: [];
						return Footer.render(ctx, theme, width, statuses);
					} catch (err) {
						// Never console.warn from the render path: pi does not intercept
						// console, so the write corrupts the live TUI frame. The layout
						// engine records it and /footer-health reports it instead.
						Footer.recordDiagnostic("Layout error", err);
						return [theme.fg("error", "pi-footer: render error")];
					}
				},
				invalidate(): void {},
				dispose(): void {
					unsubscribe();
					unsubscribeBranch();
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) setupWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		teardownWidget(ctx);
	});

	pi.on("turn_start", () => Footer.invalidate());
	pi.on("turn_end", () => Footer.invalidate());
	pi.on("model_select", () => Footer.invalidate());
	pi.on("thinking_level_select", () => Footer.invalidate());

	pi.registerCommand("footer-statuses", {
		description: "Toggle extension statuses in the custom footer",
		handler: async (_args, ctx) => {
			showStatuses = !showStatuses;
			Footer.invalidate();
			ctx.ui.notify(`Footer extension statuses ${showStatuses ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("footer-health", {
		description: "List recent pi-footer section failures",
		handler: async (_args, ctx) => {
			const problems = Footer.getDiagnostics();
			if (problems.length === 0) {
				ctx.ui.notify("Footer: no section failures recorded", "info");
				return;
			}
			ctx.ui.notify(`Footer: ${problems.length} recorded failure(s)`, "warning");
			for (const problem of problems) {
				const seen = problem.count > 1 ? ` (x${problem.count})` : "";
				ctx.ui.notify(`  ${problem.summary}${seen}`, "warning");
			}
		},
	});

	pi.registerCommand("footer", {
		description: "Toggle custom footer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				setupWidget(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				teardownWidget(ctx);
				ctx.ui.notify("Custom footer disabled (default restored)", "info");
			}
		},
	});
}
