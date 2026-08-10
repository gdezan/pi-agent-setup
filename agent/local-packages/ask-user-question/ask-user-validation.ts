import {
	MAX_FIELD_LENGTH,
	MAX_OPTIONS,
	MAX_PAYLOAD_BYTES,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	SKIP_LABEL,
	TYPE_SOMETHING_LABEL,
	type AskQuestion,
	type AskQuestionnaireInput,
	type AskOptionInput,
	type ValidationResult,
} from "./ask-user-types.ts";

const RESERVED_OPTION_LABELS = new Set(["Other", "Next", TYPE_SOMETHING_LABEL, SKIP_LABEL]);

/** Validate the questionnaire at runtime and return stable generated question IDs. */
export function validateAskQuestionnaire(input: AskQuestionnaireInput): ValidationResult {
	if (!input || !Array.isArray(input.questions)) {
		return validationError("invalid_questions", "Ask user validation failed: questions must be an array.");
	}
	if (input.questions.length < 1) {
		return validationError("no_questions", "Ask user validation failed: at least one question is required.");
	}
	if (input.questions.length > MAX_QUESTIONS) {
		return validationError(
			"too_many_questions",
			`Ask user validation failed: questions must contain at most ${MAX_QUESTIONS} entries.`,
		);
	}

	const payloadBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
	if (payloadBytes > MAX_PAYLOAD_BYTES) {
		return validationError(
			"payload_too_large",
			`Ask user validation failed: total questionnaire payload must be at most ${MAX_PAYLOAD_BYTES} bytes.`,
		);
	}

	const questionIds = new Set<string>();
	const questionTexts = new Set<string>();
	const questions: AskQuestion[] = [];

	for (let questionIndex = 0; questionIndex < input.questions.length; questionIndex++) {
		const rawQuestion = input.questions[questionIndex];
		const path = `questions[${questionIndex}]`;
		if (!rawQuestion || typeof rawQuestion !== "object") {
			return validationError("invalid_question", `Ask user validation failed: ${path} must be an object.`);
		}

		const question = requireText(rawQuestion.question, `${path}.question`);
		if (!question.ok) return question;
		const header = requireText(rawQuestion.header, `${path}.header`);
		if (!header.ok) return header;
		if (!Array.isArray(rawQuestion.options)) {
			return validationError("invalid_options", `Ask user validation failed: ${path}.options must be an array.`);
		}
		if (rawQuestion.options.length < MIN_OPTIONS || rawQuestion.options.length > MAX_OPTIONS) {
			return validationError(
				"invalid_option_count",
				`Ask user validation failed: ${path}.options must contain ${MIN_OPTIONS}-${MAX_OPTIONS} entries (received ${rawQuestion.options.length}).`,
			);
		}
		if (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== "boolean") {
			return validationError(
				"invalid_multi_select",
				`Ask user validation failed: ${path}.multiSelect must be a boolean when provided.`,
			);
		}

		const idValue = rawQuestion.id === undefined ? `question-${questionIndex + 1}` : rawQuestion.id;
		const id = requireText(idValue, `${path}.id`);
		if (!id.ok) return id;
		if (questionIds.has(id.value)) {
			return validationError("duplicate_id", `Ask user validation failed: duplicate question ID "${id.value}".`);
		}
		if (questionTexts.has(question.value)) {
			return validationError(
				"duplicate_question",
				`Ask user validation failed: duplicate question text at ${path}.question.`,
			);
		}
		questionIds.add(id.value);
		questionTexts.add(question.value);

		const options: AskOptionInput[] = [];
		const optionLabels = new Set<string>();
		for (let optionIndex = 0; optionIndex < rawQuestion.options.length; optionIndex++) {
			const rawOption = rawQuestion.options[optionIndex];
			const optionPath = `${path}.options[${optionIndex}]`;
			if (!rawOption || typeof rawOption !== "object") {
				return validationError("invalid_option", `Ask user validation failed: ${optionPath} must be an object.`);
			}
			const label = requireText(rawOption.label, `${optionPath}.label`);
			if (!label.ok) return label;
			const description = requireText(rawOption.description, `${optionPath}.description`);
			if (!description.ok) return description;
			if (RESERVED_OPTION_LABELS.has(label.value)) {
				return validationError(
					"reserved_label",
					`Ask user validation failed: ${optionPath}.label uses reserved label "${label.value}".`,
				);
			}
			if (optionLabels.has(label.value)) {
				return validationError(
					"duplicate_option_label",
					`Ask user validation failed: duplicate option label "${label.value}" in ${path}.options.`,
				);
			}
			optionLabels.add(label.value);
			options.push({ label: label.value, description: description.value });
		}

		questions.push({
			id: id.value,
			question: question.value,
			header: header.value,
			options,
			multiSelect: rawQuestion.multiSelect ?? false,
		});
	}

	return { ok: true, questionnaire: { questions } };
}

function requireText(value: unknown, path: string): { ok: true; value: string } | { ok: false; error: string; message: string } {
	if (typeof value !== "string") {
		return validationError("invalid_text", `Ask user validation failed: ${path} must be a string.`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return validationError("empty_text", `Ask user validation failed: ${path} must not be empty.`);
	}
	if (trimmed.length > MAX_FIELD_LENGTH) {
		return validationError(
			"field_too_large",
			`Ask user validation failed: ${path} must be at most ${MAX_FIELD_LENGTH} characters.`,
		);
	}
	return { ok: true, value: trimmed };
}

function validationError(error: string, message: string): { ok: false; error: string; message: string } {
	return { ok: false, error, message };
}
