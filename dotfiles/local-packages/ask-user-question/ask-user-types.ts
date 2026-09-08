/** Structured input and output types for the private ask-user questionnaire. */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_FIELD_LENGTH = 4000;
export const MAX_PAYLOAD_BYTES = 32 * 1024;

export const TYPE_SOMETHING_LABEL = "Type something";
export const SKIP_LABEL = "Skip";

export type AskQuestionInput = {
	id?: string;
	question: string;
	header: string;
	options: AskOptionInput[];
	multiSelect?: boolean;
};

export type AskOptionInput = {
	label: string;
	description: string;
};

export type AskQuestionnaireInput = {
	questions: AskQuestionInput[];
};

export type AskQuestion = {
	id: string;
	question: string;
	header: string;
	options: AskOptionInput[];
	multiSelect: boolean;
	/** Internal `/answer` fallback marker: selecting the first authored row opens freeform input. */
	freeformOnly?: boolean;
};

export type AskQuestionnaire = {
	questions: AskQuestion[];
};

export type AskQuestionAnswer = {
	questionId: string;
	question: string;
	kind: "option" | "custom" | "multi" | "skipped";
	answer: string | null;
	selected?: string[];
};

export type AskQuestionnaireDetails = {
	questions: AskQuestion[];
	answers: AskQuestionAnswer[];
	cancelled: boolean;
	error?: string;
};

export type QuestionnaireRunResult = {
	answers: AskQuestionAnswer[];
	cancelled: boolean;
};

export type ValidationResult =
	| { ok: true; questionnaire: AskQuestionnaire }
	| { ok: false; error: string; message: string };
