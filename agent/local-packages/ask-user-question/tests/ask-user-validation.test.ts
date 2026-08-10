import assert from "node:assert/strict";
import test from "node:test";
import { validateAskQuestionnaire } from "../ask-user-validation.ts";

const validQuestion = {
	id: "scope",
	question: "Which scope should be changed?",
	header: "Scope",
	options: [
		{ label: "Project", description: "Change only this project." },
		{ label: "Global", description: "Change the shared configuration." },
	],
};

test("validates a questionnaire and preserves long display text", () => {
	const result = validateAskQuestionnaire({
		questions: [{ ...validQuestion, header: "A deliberately long header that is still display metadata" }],
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questionnaire.questions[0].header.length > 16, true);
});

test("rejects duplicate IDs with an exact repair path", () => {
	const result = validateAskQuestionnaire({ questions: [validQuestion, { ...validQuestion, question: "Which mode?" }] });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error, "duplicate_id");
		assert.match(result.message, /duplicate question ID/);
	}
});

test("rejects malformed option counts and reserved labels", () => {
	const tooFew = validateAskQuestionnaire({ questions: [{ ...validQuestion, options: [validQuestion.options[0]] }] });
	assert.equal(tooFew.ok, false);
	if (!tooFew.ok) assert.equal(tooFew.error, "invalid_option_count");

	const reserved = validateAskQuestionnaire({
		questions: [{ ...validQuestion, options: [{ label: "Skip", description: "No" }, validQuestion.options[1]] }],
	});
	assert.equal(reserved.ok, false);
	if (!reserved.ok) assert.equal(reserved.error, "reserved_label");
});

test("rejects an oversized total payload", () => {
	const result = validateAskQuestionnaire({
		questions: Array.from({ length: 4 }, (_, index) => ({
			...validQuestion,
			id: `q${index}`,
			question: `${index} ${"x".repeat(3990)}`,
			options: validQuestion.options.map((option) => ({ ...option, description: "y".repeat(3990) })),
		})),
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "payload_too_large");
});
