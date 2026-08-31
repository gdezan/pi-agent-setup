/**
 * Shared footer section registry and layout engine.
 *
 * Important: pi loads each extension through a separate jiti instance with
 * module caching disabled. The registry therefore lives on globalThis so
 * sections registered by other extensions share the visible footer instance.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterSectionVariant, Section, SectionHandle } from "./types.ts";

type Listener = () => void;
type EventBus = {
	on(fn: Listener): () => void;
	emit(): void;
};
type FooterState = {
	sections: Map<string, Section>;
	events: EventBus;
};

const GLOBAL_KEY = Symbol.for("pi.footer.shared-registry");
const globalState = globalThis as typeof globalThis & Record<symbol, FooterState | undefined>;

function createEventBus(): EventBus {
	const listeners = new Set<Listener>();
	return {
		on(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		emit() {
			for (const fn of listeners) fn();
		},
	};
}

const state = (globalState[GLOBAL_KEY] ??= {
	sections: new Map<string, Section>(),
	events: createEventBus(),
});

export const Footer = {
	registerSection(section: Section): SectionHandle {
		const previous = state.sections.get(section.id);
		if (previous && previous !== section) {
			console.warn(`[pi-footer] Section "${section.id}" already registered — overwriting`);
			previous.dispose?.();
		}
		state.sections.set(section.id, section);
		state.events.emit();
		return {
			invalidate: () => state.events.emit(),
			unregister: () => {
				if (state.sections.get(section.id) !== section) return;
				section.dispose?.();
				state.sections.delete(section.id);
				state.events.emit();
			},
		};
	},

	unregisterSection(id: string): void {
		const section = state.sections.get(id);
		if (!section) return;
		section.dispose?.();
		state.sections.delete(id);
		state.events.emit();
	},

	getSections(): Section[] {
		return Array.from(state.sections.values());
	},

	onInvalidate(fn: () => void): () => void {
		return state.events.on(fn);
	},

	invalidate(): void {
		state.events.emit();
	},

	render(
		ctx: ExtensionContext,
		theme: Theme,
		width: number,
		statuses: Iterable<string> = [],
		featuredStatus?: string,
	): string[] {
		const statusValues = Array.from(statuses);
		if (state.sections.size === 0 && statusValues.length === 0 && !featuredStatus) return [];

		const separator = theme.fg("dim", " │ ");
		const minimumPadding = 2;
		type RenderedSection = {
			section: Section;
			variants: readonly FooterSectionVariant[];
			variantIndex: number;
			text: string;
			hidden: boolean;
		};

		const renderSection = (item: RenderedSection): void => {
			try {
				item.text = item.section.render(ctx, theme, item.variants[item.variantIndex] ?? "full");
			} catch (error) {
				console.warn(`[pi-footer] Section "${item.section.id}" threw:`, error);
				item.text = "";
				item.hidden = true;
			}
		};
		const createRenderedSection = (section: Section): RenderedSection => {
			const item: RenderedSection = {
				section,
				variants: section.variants ?? ["full"],
				variantIndex: 0,
				text: "",
				hidden: false,
			};
			renderSection(item);
			return item;
		};

		const left = Array.from(state.sections.values())
			.filter((section) => section.align === "left")
			.sort((a, b) => a.order - b.order)
			.map(createRenderedSection);
		const right = Array.from(state.sections.values())
			.filter((section) => section.align === "right")
			.sort((a, b) => a.order - b.order)
			.map(createRenderedSection);

		if (featuredStatus) {
			left.push({
				section: { id: "pi-footer:featured-status", align: "left", order: Number.MAX_SAFE_INTEGER, essential: true, render: () => featuredStatus },
				variants: ["full"],
				variantIndex: 0,
				text: featuredStatus,
				hidden: false,
			});
		}

		const visibleText = (items: RenderedSection[]): string =>
			items.filter((item) => !item.hidden && item.text).map((item) => item.text).join(separator);
		const totalWidth = (): number => {
			const leftWidth = visibleWidth(visibleText(left));
			const rightWidth = visibleWidth(visibleText(right));
			return leftWidth + (leftWidth > 0 && rightWidth > 0 ? minimumPadding : 0) + rightWidth;
		};
		const allItems = [...left, ...right];

		while (totalWidth() > width) {
			const reducibleAuxiliary = allItems
				.filter((item) => !item.hidden && !item.section.essential && item.variantIndex < item.variants.length - 1)
				.sort((a, b) => visibleWidth(b.text) - visibleWidth(a.text))[0];
			if (reducibleAuxiliary) {
				reducibleAuxiliary.variantIndex += 1;
				renderSection(reducibleAuxiliary);
				continue;
			}

			const removableAuxiliary = allItems
				.filter((item) => !item.hidden && !item.section.essential)
				.sort((a, b) => visibleWidth(b.text) - visibleWidth(a.text))[0];
			if (removableAuxiliary) {
				removableAuxiliary.hidden = true;
				continue;
			}

			const reducibleEssential = allItems
				.filter((item) => !item.hidden && item.section.essential && item.variantIndex < item.variants.length - 1)
				.sort((a, b) => visibleWidth(b.text) - visibleWidth(a.text))[0];
			if (!reducibleEssential) break;
			reducibleEssential.variantIndex += 1;
			renderSection(reducibleEssential);
		}

		const statusLine = statusValues
			.map((text) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
			.filter(Boolean)
			.join(" ");
		const withStatuses = (lines: string[]): string[] => {
			if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			return lines;
		};

		const leftText = visibleText(left);
		const rightText = visibleText(right);
		const leftWidth = visibleWidth(leftText);
		const rightWidth = visibleWidth(rightText);
		const paddingWidth = leftWidth > 0 && rightWidth > 0 ? minimumPadding : 0;
		if (leftWidth + paddingWidth + rightWidth <= width) {
			const padding = " ".repeat(Math.max(paddingWidth, width - leftWidth - rightWidth));
			return withStatuses([leftText + padding + rightText]);
		}

		if (!leftText || !rightText) {
			return withStatuses([truncateToWidth(leftText || rightText, width, "")]);
		}

		const contentWidth = Math.max(0, width - minimumPadding);
		let leftBudget = Math.floor(contentWidth / 2);
		let rightBudget = contentWidth - leftBudget;
		if (leftWidth < leftBudget) {
			rightBudget += leftBudget - leftWidth;
			leftBudget = leftWidth;
		} else if (rightWidth < rightBudget) {
			leftBudget += rightBudget - rightWidth;
			rightBudget = rightWidth;
		}
		const fittedLeft = truncateToWidth(leftText, leftBudget, "");
		const fittedRight = truncateToWidth(rightText, rightBudget, "");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)));
		return withStatuses([fittedLeft + padding + fittedRight]);
	},

	clear(): void {
		for (const section of state.sections.values()) section.dispose?.();
		state.sections.clear();
		state.events.emit();
	},
};
