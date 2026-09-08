import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowQuestionnaireReview } from "../ask-user-review.ts";
import type { AskQuestion } from "../ask-user-types.ts";

const question = (id: string): AskQuestion => ({
	id,
	question: "Which option?",
	header: "Choice",
	options: [
		{ label: "A", description: "First." },
		{ label: "B", description: "Second." },
	],
	multiSelect: false,
});

test("single-question questionnaires submit without a review screen", () => {
	assert.equal(shouldShowQuestionnaireReview({ questions: [question("q1")] }), false);
});

test("multi-question questionnaires retain the review screen", () => {
	assert.equal(shouldShowQuestionnaireReview({ questions: [question("q1"), question("q2")] }), true);
});
