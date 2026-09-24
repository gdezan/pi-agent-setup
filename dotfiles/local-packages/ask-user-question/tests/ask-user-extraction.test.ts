import assert from "node:assert/strict";
import test from "node:test";
import { buildFreeformFallbackQuestionnaire, parseExtractedQuestionnaire } from "../ask-user-extraction.ts";

test("parses fenced structured extraction output", () => {
	const result = parseExtractedQuestionnaire('```json\n{"questions":[{"id":"q1","question":"Which mode?","header":"Mode","options":[{"label":"Safe","description":"Use safe mode."},{"label":"Fast","description":"Use fast mode."}]}]}\n```');
	assert.equal(result.kind, "questions");
	if (result.kind === "questions") assert.equal(result.questionnaire.questions[0].id, "q1");
});

test("distinguishes no questions from invalid extraction", () => {
	assert.equal(parseExtractedQuestionnaire('{"questions":[]}').kind, "none");
	assert.equal(parseExtractedQuestionnaire("not JSON").kind, "invalid");
});

test("parses eight extracted questions", () => {
	const questions = Array.from({ length: 8 }, (_, index) => ({
		id: `q${index}`,
		question: `Which option for item ${index}?`,
		header: `Item ${index}`,
		options: [{ label: "First", description: "Use the first option." }, { label: "Second", description: "Use the second option." }],
	}));
	const result = parseExtractedQuestionnaire(JSON.stringify({ questions }));
	assert.equal(result.kind, "questions");
	if (result.kind === "questions") assert.equal(result.questionnaire.questions.length, 8);
});

test("builds a valid freeform fallback", () => {
	const result = buildFreeformFallbackQuestionnaire("The assistant asks for a nuanced response.");
	assert.equal(result.questions[0].id, "freeform-answer");
	assert.equal(result.questions[0].options.length, 2);
});
