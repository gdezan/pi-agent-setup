/**
 * Shared footer section registry and layout engine.
 *
 * Important: pi loads each extension through a separate jiti instance with
 * module caching disabled. The registry therefore lives on globalThis so
 * sections registered by other extensions share the visible footer instance.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Section, SectionHandle } from "./types.ts";

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

		const sep = theme.fg("dim", " │ ");
		const minPad = 2;
		const left: Section[] = [];
		const right: Section[] = [];

		for (const section of state.sections.values()) {
			(section.align === "left" ? left : right).push(section);
		}
		left.sort((a, b) => a.priority - b.priority);
		right.sort((a, b) => a.priority - b.priority);

		const renderSafe = (section: Section): string | null => {
			try {
				return section.render(ctx, theme);
			} catch (err) {
				console.warn(`[pi-footer] Section "${section.id}" threw:`, err);
				return null;
			}
		};

		const leftParts = left.map(renderSafe).filter((s): s is string => Boolean(s));
		if (featuredStatus) leftParts.push(featuredStatus);
		let rightParts = right.map(renderSafe).filter((s): s is string => Boolean(s));
		const buildLeft = () => leftParts.join(sep);
		const buildRight = () => rightParts.join(sep);
		const measureLeft = () => visibleWidth(buildLeft());
		const measureRight = () => visibleWidth(buildRight());

		while (rightParts.length > 1 && measureLeft() + minPad + measureRight() > width) {
			rightParts.pop();
		}

		const finalLeft = buildLeft();
		const finalRight = buildRight();
		const finalLeftW = visibleWidth(finalLeft);
		const finalRightW = visibleWidth(finalRight);

		const statusLine = statusValues
			.map((text) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
			.filter(Boolean)
			.join(" ");
		const withStatuses = (lines: string[]): string[] => {
			if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			return lines;
		};

		if (finalLeftW + minPad + finalRightW > width) {
			const available = Math.max(0, width - finalLeftW - minPad);
			if (available <= 0) return withStatuses([truncateToWidth(finalLeft, width)]);
			const truncated = truncateToWidth(finalRight, available, "");
			const pad = " ".repeat(Math.max(1, width - finalLeftW - visibleWidth(truncated)));
			return withStatuses([finalLeft + pad + truncated]);
		}

		const pad = " ".repeat(Math.max(minPad, width - finalLeftW - finalRightW));
		return withStatuses([finalLeft + pad + finalRight]);
	},

	clear(): void {
		for (const section of state.sections.values()) section.dispose?.();
		state.sections.clear();
		state.events.emit();
	},
};
