import {
	Editor,
	type EditorTheme,
	Key,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type Component,
	type Focusable,
	type OverlayHandle,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type AskUserTheme = {
	fg(color: string, value: string): string;
	bg(color: string, value: string): string;
	bold(value: string): string;
};
import {
	MAX_FIELD_LENGTH,
	SKIP_LABEL,
	TYPE_SOMETHING_LABEL,
	type AskQuestion,
	type AskQuestionAnswer,
	type AskQuestionnaire,
	type QuestionnaireRunResult,
} from "./ask-user-types.js";
import { shouldShowQuestionnaireReview } from "./ask-user-review.js";

/** Render and run the bottom-anchored ask-user questionnaire overlay. */
export async function runTuiQuestionnaire(
	ui: ExtensionUIContext,
	questionnaire: AskQuestionnaire,
	collapseKey: string | "off",
): Promise<QuestionnaireRunResult | undefined> {
	let removeInputListener: (() => void) | undefined;
	let component: AskQuestionnaireOverlay | undefined;
	let overlayHandle: OverlayHandle | undefined;

	try {
		return await ui.custom<QuestionnaireRunResult | undefined>(
			(tui, theme, _keybindings, done) => {
				component = new AskQuestionnaireOverlay(tui, theme, questionnaire, done, ui.notify);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "70%",
					margin: { left: 1, right: 1, bottom: 1 },
				},
				onHandle: (handle) => {
					overlayHandle = handle;
					if (collapseKey === "off" || typeof ui.onTerminalInput !== "function") return;
					removeInputListener = ui.onTerminalInput((data) => {
						if (!overlayHandle || !component) return undefined;
						if (!overlayHandle.isHidden() && !overlayHandle.isFocused()) return undefined;
						if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
						if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
						overlayHandle.setHidden(!overlayHandle.isHidden());
						if (overlayHandle.isHidden()) {
							ui.notify(`Questionnaire hidden — press ${collapseKey} to reopen`, "info");
						}
						return { consume: true };
					});
				},
			},
		);
	} finally {
		removeInputListener?.();
	}
}

class AskQuestionnaireOverlay implements Component, Focusable {
	private currentTab = 0;
	private selectedIndex = 0;
	private editing = false;
	private readonly answers = new Map<string, AskQuestionAnswer>();
	private multiSelection = new Set<string>();
	private cachedLines: string[] | undefined;
	private readonly editor: Editor;
	private focusedValue = false;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: AskUserTheme,
		private readonly questionnaire: AskQuestionnaire,
		private readonly done: (result: QuestionnaireRunResult) => void,
		private readonly notify: (message: string, type?: "info" | "warning" | "error") => void,
	) {
		const editorTheme: EditorTheme = {
			borderColor: (value) => theme.fg("accent", value),
			selectList: {
				selectedPrefix: (value) => theme.fg("accent", value),
				selectedText: (value) => theme.fg("accent", value),
				description: (value) => theme.fg("muted", value),
				scrollInfo: (value) => theme.fg("dim", value),
				noMatch: (value) => theme.fg("warning", value),
			},
		};
		this.editor = new Editor(tui as never, editorTheme);
		this.editor.onSubmit = (value) => this.submitCustomAnswer(value);
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.editor.focused = value && this.editing;
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const currentQuestion = this.currentQuestion();
		const options = currentQuestion ? this.displayOptions(currentQuestion) : [];

		const addWrapped = (text: string) => {
			lines.push(...wrapTextWithAnsi(text, renderWidth));
		};
		const addPrefixed = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				addWrapped(`${prefix}${text}`);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
			}
		};

		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		this.renderTabs(lines, renderWidth, addPrefixed);

		if (this.isReviewTab()) {
			this.renderReview(lines, addPrefixed);
		} else if (currentQuestion) {
			addPrefixed(" ", this.theme.fg("accent", this.theme.bold(`[${currentQuestion.header}]`)));
			addPrefixed(" ", this.theme.fg("text", currentQuestion.question));
			lines.push("");
			if (this.editing) {
				addPrefixed(" ", this.theme.fg("muted", "Your answer:"));
				for (const line of this.editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
				lines.push("");
				addPrefixed(" ", this.theme.fg("dim", "Enter to save • Esc cancels the questionnaire"));
			} else {
				this.renderOptions(lines, options, addPrefixed);
			}
		}

		lines.push("");
		if (!this.editing) {
			const help = this.isReviewTab()
				? "Tab/←→ navigate • Enter submit when complete • Esc cancel"
				: currentQuestion?.multiSelect
					? "↑↓ move • Space toggle • Enter continue • Tab/←→ navigate • Esc cancel"
					: "↑↓ move • Enter choose • Tab/←→ navigate • Esc cancel";
			addPrefixed(" ", this.theme.fg("dim", help));
		}
		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.editing) {
			if (matchesKey(data, Key.escape)) {
				this.done({ answers: [], cancelled: true });
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (this.isReviewTab()) {
			if (matchesKey(data, Key.enter) && this.allAnswered()) {
				this.done({ answers: [...this.answers.values()], cancelled: false });
				return;
			}
			if (this.navigationInput(data)) return;
			if (matchesKey(data, Key.escape)) this.done({ answers: [], cancelled: true });
			return;
		}

		const question = this.currentQuestion();
		if (!question) return;
		if (this.navigationInput(data)) return;
		const options = this.displayOptions(question);
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
			this.refresh();
			return;
		}
		if (question.multiSelect && matchesKey(data, Key.space)) {
			const selected = options[this.selectedIndex];
			if (selected?.kind === "option") {
				if (this.multiSelection.has(selected.label)) this.multiSelection.delete(selected.label);
				else this.multiSelection.add(selected.label);
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseOption(question, options[this.selectedIndex]);
			return;
		}
		if (matchesKey(data, Key.escape)) this.done({ answers: [], cancelled: true });
	}

	private chooseOption(question: AskQuestion, option: DisplayOption | undefined): void {
		if (!option) return;
		if (question.freeformOnly && option.kind === "option") {
			if (this.selectedIndex === 0) {
				this.editing = true;
				this.editor.setText("");
				this.editor.focused = this.focusedValue;
				this.refresh();
			} else {
				this.saveAnswer({
					questionId: question.id,
					question: question.question,
					kind: "skipped",
					answer: null,
				});
			}
			return;
		}
		if (option.kind === "custom") {
			this.editing = true;
			this.editor.setText("");
			this.editor.focused = this.focusedValue;
			this.refresh();
			return;
		}
		if (option.kind === "skipped") {
			this.saveAnswer({
				questionId: question.id,
				question: question.question,
				kind: "skipped",
				answer: null,
			});
			return;
		}
		if (question.multiSelect) {
			this.saveAnswer({
				questionId: question.id,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: [...this.multiSelection],
			});
			return;
		}
		this.saveAnswer({
			questionId: question.id,
			question: question.question,
			kind: "option",
			answer: option.label,
		});
	}

	private submitCustomAnswer(value: string): void {
		const question = this.currentQuestion();
		const answer = value.trim();
		if (!question || !this.editing || answer.length === 0) return;
		if (answer.length > MAX_FIELD_LENGTH) {
			this.notify(`Freeform answers must be at most ${MAX_FIELD_LENGTH} characters.`, "warning");
			return;
		}
		this.editing = false;
		this.editor.focused = false;
		this.saveAnswer({
			questionId: question.id,
			question: question.question,
			kind: "custom",
			answer,
		});
	}

	private saveAnswer(answer: AskQuestionAnswer): void {
		this.answers.set(answer.questionId, answer);
		this.multiSelection.clear();
		this.editing = false;
		this.editor.focused = false;
		if (!shouldShowQuestionnaireReview(this.questionnaire)) {
			this.done({ answers: [...this.answers.values()], cancelled: false });
			return;
		}
		if (this.currentTab < this.questionnaire.questions.length - 1) {
			this.currentTab++;
			this.selectedIndex = 0;
			this.loadQuestionSelection();
		} else {
			this.currentTab = this.questionnaire.questions.length;
		}
		this.refresh();
	}

	private navigationInput(data: string): boolean {
		if (!shouldShowQuestionnaireReview(this.questionnaire)) return false;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.moveTab(1);
			return true;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.moveTab(-1);
			return true;
		}
		return false;
	}

	private moveTab(delta: number): void {
		const tabCount = this.questionnaire.questions.length + 1;
		this.currentTab = (this.currentTab + delta + tabCount) % tabCount;
		this.editing = false;
		this.editor.focused = false;
		this.selectedIndex = 0;
		this.loadQuestionSelection();
		this.refresh();
	}

	private loadQuestionSelection(): void {
		const question = this.currentQuestion();
		this.multiSelection = new Set(this.answers.get(question?.id ?? "")?.selected ?? []);
		const existing = question ? this.answers.get(question.id) : undefined;
		if (!question || !existing) {
			this.selectedIndex = 0;
			return;
		}
		if (existing.kind === "skipped") this.selectedIndex = question.options.length + 1;
		else if (existing.kind === "custom") this.selectedIndex = question.options.length;
		else this.selectedIndex = Math.max(0, question.options.findIndex((option) => option.label === existing.answer));
	}

	private currentQuestion(): AskQuestion | undefined {
		return this.questionnaire.questions[this.currentTab];
	}

	private isReviewTab(): boolean {
		return shouldShowQuestionnaireReview(this.questionnaire) && this.currentTab === this.questionnaire.questions.length;
	}

	private allAnswered(): boolean {
		return this.questionnaire.questions.every((question) => this.answers.has(question.id));
	}

	private displayOptions(question: AskQuestion): DisplayOption[] {
		return [
			...question.options.map((option) => ({ kind: "option" as const, label: option.label, description: option.description })),
			{ kind: "custom" as const, label: TYPE_SOMETHING_LABEL, description: "Type a freeform answer instead of choosing an option." },
			{ kind: "skipped" as const, label: SKIP_LABEL, description: "Explicitly leave this question unanswered." },
		];
	}

	private renderTabs(lines: string[], renderWidth: number, addPrefixed: (prefix: string, text: string) => void): void {
		if (!shouldShowQuestionnaireReview(this.questionnaire)) return;
		const tabs = this.questionnaire.questions.map((question, index) => {
			const marker = this.answers.has(question.id) ? "■" : "□";
			const label = ` ${marker} ${question.header} `;
			return index === this.currentTab
				? this.theme.bg("selectedBg", this.theme.fg("text", label))
				: this.theme.fg(this.answers.has(question.id) ? "success" : "muted", label);
		});
		const submitLabel = this.isReviewTab() ? " ✓ Submit " : " ✓ Review ";
		const submit = this.isReviewTab()
			? this.theme.bg("selectedBg", this.theme.fg("text", submitLabel))
			: this.theme.fg(this.allAnswered() ? "success" : "dim", submitLabel);
		addPrefixed(" ", `${tabs.join(" ")} ${submit}`);
		lines.push("");
	}

	private renderOptions(lines: string[], options: DisplayOption[], addPrefixed: (prefix: string, text: string) => void): void {
		const question = this.currentQuestion();
		for (let index = 0; index < options.length; index++) {
			const option = options[index];
			const active = index === this.selectedIndex;
			const checked = question?.multiSelect && option.kind === "option" && this.multiSelection.has(option.label);
			const marker = question?.multiSelect && option.kind === "option" ? (checked ? "[x]" : "[ ]") : "   ";
			const prefix = active ? this.theme.fg("accent", "> ") : "  ";
			const color = active ? "accent" : option.kind === "skipped" ? "warning" : "text";
			addPrefixed(prefix, `${marker} ${index + 1}. ${this.theme.fg(color, option.label)}`);
			addPrefixed("       ", this.theme.fg("muted", option.description));
		}
	}

	private renderReview(lines: string[], addPrefixed: (prefix: string, text: string) => void): void {
		addPrefixed(" ", this.theme.fg("accent", this.theme.bold("Review your answers")));
		lines.push("");
		for (const question of this.questionnaire.questions) {
			const answer = this.answers.get(question.id);
			const summary = answer ? formatAnswer(answer) : "Not answered";
			const color = answer ? (answer.kind === "skipped" ? "warning" : "success") : "warning";
			addPrefixed(" ", `${this.theme.fg("muted", `[${question.id}] ${question.header}:`)} ${this.theme.fg(color, summary)}`);
		}
		lines.push("");
		addPrefixed(
			" ",
			this.theme.fg(this.allAnswered() ? "success" : "warning", this.allAnswered() ? "Press Enter to submit" : "Answer or skip every question before submitting"),
		);
	}

	private refresh(): void {
		this.cachedLines = undefined;
		this.tui.requestRender();
	}
}

type DisplayOption = {
	kind: "option" | "custom" | "skipped";
	label: string;
	description: string;
};

function formatAnswer(answer: AskQuestionAnswer): string {
	if (answer.kind === "skipped") return "Skipped explicitly";
	if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "No options selected";
	return answer.answer ?? "";
}
