import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnswerMessage,
  buildAskUserToolResult,
  ASK_USER_CANCELLED_MESSAGE,
} from "../ask-user-response.ts";

const questionnaire = {
  questions: [
    {
      id: "database",
      header: "Database",
      question: "Which database should we use?",
      multiSelect: false,
      options: [
        { label: "SQLite", description: "Use a local database." },
        { label: "Postgres", description: "Use a server database." },
      ],
    },
  ],
};

test("formats structured answers with IDs", () => {
  const answers = [
    {
      questionId: "database",
      question: questionnaire.questions[0].question,
      kind: "option" as const,
      answer: "SQLite",
    },
  ];
  const toolResult = buildAskUserToolResult(questionnaire, { answers, cancelled: false });
  assert.match(toolResult.content[0].text, /\[database\] SQLite/);
  assert.equal(toolResult.details.cancelled, false);
  assert.match(buildAnswerMessage(questionnaire, answers), /Answers to your previous questions/);
});

test("cancellation is neutral and terminating", () => {
  const result = buildAskUserToolResult(questionnaire, { answers: [], cancelled: true });
  assert.equal(result.content[0].text, ASK_USER_CANCELLED_MESSAGE);
  assert.equal(result.terminate, true);
  assert.equal(result.details.cancelled, true);
});

test("includes explicit skip in the compiled answer message", () => {
  const answers = [
    {
      questionId: "database",
      question: questionnaire.questions[0].question,
      kind: "skipped" as const,
      answer: null,
    },
  ];
  assert.match(buildAnswerMessage(questionnaire, answers), /Skipped explicitly/);
});
