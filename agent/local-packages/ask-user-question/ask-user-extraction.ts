import { validateAskQuestionnaire } from "./ask-user-validation.ts";
import { SKIP_LABEL, TYPE_SOMETHING_LABEL, type AskQuestionnaire, type AskQuestionnaireInput } from "./ask-user-types.ts";

export type ExtractionResult =
	| { kind: "questions"; questionnaire: AskQuestionnaire }
	| { kind: "none" }
	| { kind: "invalid" };

/** Parse the nested model's JSON output without accepting prose as a questionnaire. */
export function parseExtractedQuestionnaire(responseText: string): ExtractionResult {
	const trimmed = responseText.trim();
	if (/^no questions found\b/i.test(trimmed)) return { kind: "none" };

	const parsed = parseJsonObject(trimmed);
	if (parsed === undefined) return { kind: "invalid" };
	const rawQuestions = Array.isArray(parsed) ? parsed : (parsed as { questions?: unknown }).questions;
	if (!Array.isArray(rawQuestions)) return { kind: "invalid" };
	if (rawQuestions.length === 0) return { kind: "none" };

	const input: AskQuestionnaireInput = { questions: [] };
	for (let index = 0; index < rawQuestions.length; index++) {
		const raw = rawQuestions[index];
		if (!raw || typeof raw !== "object") return { kind: "invalid" };
		const record = raw as Record<string, unknown>;
		if (typeof record.question !== "string") return { kind: "invalid" };
		const options = normalizeExtractedOptions(record.options);
		if (!options) return { kind: "invalid" };
		input.questions.push({
			id: typeof record.id === "string" && record.id.trim() ? record.id : `question-${index + 1}`,
			question: record.question,
			header: typeof record.header === "string" && record.header.trim() ? record.header : `Question ${index + 1}`,
			options,
			multiSelect: record.multiSelect === true,
		});
	}

	const validation = validateAskQuestionnaire(input);
	return validation.ok ? { kind: "questions", questionnaire: validation.questionnaire } : { kind: "invalid" };
}

/** Create a safe one-question fallback that lets the user type an answer. */
export function buildFreeformFallbackQuestionnaire(sourceText: string): AskQuestionnaire {
	const excerpt = sourceText.length > 3400 ? `${sourceText.slice(0, 3400)}\n[…message truncated for display…]` : sourceText;
	const validation = validateAskQuestionnaire({
		questions: [
			{
				id: "freeform-answer",
				header: "Freeform answer",
				question: `How should I respond to this assistant message?\n\n${excerpt}`,
				options: [
					{
						label: "Write an answer",
						description: "Choose this to type the response you want Pi to send.",
					},
					{
						label: "Do not answer",
						description: "Skip this message instead of sending a response.",
					},
				],
			},
		],
	});
	if (!validation.ok) {
		throw new Error(`Freeform fallback questionnaire failed validation: ${validation.message}`);
	}
	return {
		questions: [{ ...validation.questionnaire.questions[0], freeformOnly: true }],
	};
}

function normalizeExtractedOptions(value: unknown): AskQuestionnaireInput["questions"][number]["options"] | undefined {
	if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;
	const options = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return undefined;
		const record = item as Record<string, unknown>;
		if (typeof record.label !== "string" || typeof record.description !== "string") return undefined;
		if (record.label === TYPE_SOMETHING_LABEL || record.label === SKIP_LABEL || record.label === "Other" || record.label === "Next") {
			return undefined;
		}
		options.push({ label: record.label, description: record.description });
	}
	return options;
}

function parseJsonObject(text: string): unknown[] | Record<string, unknown> | undefined {
	const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	try {
		const direct = JSON.parse(withoutFence) as unknown;
		if (Array.isArray(direct) || (direct && typeof direct === "object")) return direct as unknown[] | Record<string, unknown>;
	} catch {
		// Try the first JSON object/array embedded in a short explanatory response.
	}
	const firstObject = withoutFence.indexOf("{");
	const firstArray = withoutFence.indexOf("[");
	const starts = [firstObject, firstArray].filter((index) => index >= 0).sort((a, b) => a - b);
	for (const start of starts) {
		const end = withoutFence.lastIndexOf(withoutFence[start] === "{" ? "}" : "]");
		if (end <= start) continue;
		try {
			const embedded = JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
			if (Array.isArray(embedded) || (embedded && typeof embedded === "object")) {
				return embedded as unknown[] | Record<string, unknown>;
			}
		} catch {
			// Continue trying another candidate boundary.
		}
	}
	return undefined;
}
