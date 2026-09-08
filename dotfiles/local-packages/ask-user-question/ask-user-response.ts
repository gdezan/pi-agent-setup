import type {
	AskQuestionAnswer,
	AskQuestionnaire,
	AskQuestionnaireDetails,
	QuestionnaireRunResult,
} from "./ask-user-types.js";

export const ASK_USER_CANCELLED_MESSAGE =
	"User cancelled the questionnaire. No answers were provided; do not proceed by guessing.";

/** Build the structured tool result and the concise LLM-facing answer summary. */
export function buildAskUserToolResult(
	questionnaire: AskQuestionnaire,
	result: QuestionnaireRunResult,
): {
	content: [{ type: "text"; text: string }];
	details: AskQuestionnaireDetails;
	terminate?: boolean;
} {
	if (result.cancelled) {
		return {
			content: [{ type: "text", text: ASK_USER_CANCELLED_MESSAGE }],
			details: { questions: questionnaire.questions, answers: [], cancelled: true },
			terminate: true,
		};
	}

	return {
		content: [{ type: "text", text: buildAnswerSummary(result.answers) }],
		details: { questions: questionnaire.questions, answers: result.answers, cancelled: false },
	};
}

/** Compile `/answer` responses into a normal user message with stable question IDs. */
export function buildAnswerMessage(questionnaire: AskQuestionnaire, answers: AskQuestionAnswer[]): string {
	const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
	const lines = ["Answers to your previous questions:"];
	for (const question of questionnaire.questions) {
		const answer = byId.get(question.id);
		if (!answer || answer.kind === "skipped") {
			lines.push(`- [${question.id}] ${question.question}\n  Answer: Skipped explicitly.`);
			continue;
		}
		if (answer.kind === "multi") {
			const selected = answer.selected?.length ? answer.selected.join(", ") : "No options selected";
			lines.push(`- [${question.id}] ${question.question}\n  Answers: ${selected}`);
			continue;
		}
		lines.push(`- [${question.id}] ${question.question}\n  Answer: ${answer.answer ?? ""}`);
	}
	return lines.join("\n");
}

function buildAnswerSummary(answers: AskQuestionAnswer[]): string {
	if (answers.length === 0) return ASK_USER_CANCELLED_MESSAGE;
	const lines = answers.map((answer) => {
		if (answer.kind === "skipped") return `[${answer.questionId}] Skipped explicitly.`;
		if (answer.kind === "multi") {
			return `[${answer.questionId}] ${answer.selected?.length ? answer.selected.join(", ") : "No options selected"}`;
		}
		return `[${answer.questionId}] ${answer.answer ?? ""}`;
	});
	return `User answers:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
