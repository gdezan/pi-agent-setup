import assert from "node:assert/strict";
import test from "node:test";
import { runRpcQuestionnaire } from "../ask-user-dialog.ts";

const question = {
	id: "choice",
	header: "Choice",
	question: "Which choice?",
	multiSelect: false,
	options: [
		{ label: "A", description: "First." },
		{ label: "B", description: "Second." },
	],
};

test("RPC dialogs support authored options, Type something, and Skip", async () => {
	const selections = ["1. A — First."];
	const result = await runRpcQuestionnaire(
		{
			select: async () => selections.shift(),
			input: async () => undefined,
		},
		{ questions: [question] },
	);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0].answer, "A");
});

test("RPC freeform fallback opens the editor instead of returning its display label", async () => {
	const result = await runRpcQuestionnaire(
		{
			select: async () => "1. Write an answer — Choose this to type the response you want Pi to send.",
			input: async () => "The answer I want to send",
		},
		{
			questions: [{ ...question, freeformOnly: true, options: [{ label: "Write an answer", description: "Choose this to type the response you want Pi to send." }, { label: "Do not answer", description: "Skip this message." }] }],
		},
	);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0].kind, "custom");
	assert.equal(result.answers[0].answer, "The answer I want to send");
});

test("RPC multi-select accepts numbers and custom text", async () => {
	const multi = { ...question, multiSelect: true };
	const selected = await runRpcQuestionnaire(
		{ select: async () => undefined, input: async () => "1, 2" },
		{ questions: [multi] },
	);
	assert.deepEqual(selected.answers[0].selected, ["A", "B"]);

	const custom = await runRpcQuestionnaire(
		{ select: async () => undefined, input: async () => "freeform response" },
		{ questions: [multi] },
	);
	assert.equal(custom.answers[0].kind, "custom");
	assert.equal(custom.answers[0].answer, "freeform response");
});
