import type { AskQuestionnaire } from "./ask-user-types.ts";

/** Single-question prompts submit immediately; multi-question prompts offer review. */
export function shouldShowQuestionnaireReview(questionnaire: AskQuestionnaire): boolean {
	return questionnaire.questions.length > 1;
}
