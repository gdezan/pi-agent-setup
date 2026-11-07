import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNextPromptContext,
  normalizeNextPromptSuggestion,
} from "../gd-next-prompt/next-prompt-context.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string) => ({
  type: "message",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

test("suggestion context retains the recent request and final reply, not tools, reasoning, or abandoned context", () => {
  const context = buildNextPromptContext([
    user("Old topic"),
    assistant("Old answer"),
    user("First recent request"),
    assistant("First recent answer"),
    user("Second recent request"),
    assistant("Second recent answer"),
    user("Latest request"),
    { type: "message", message: { role: "toolResult", content: "SECRET TOOL OUTPUT" } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "INTERMEDIATE TOOL PLAN" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "PRIVATE REASONING" },
          { type: "text", text: "Should I implement this?" },
        ],
      },
    },
  ]);
  const serialized = JSON.stringify(context);
  for (const included of [
    "First recent request",
    "Second recent request",
    "Latest request",
    "Should I implement this?",
  ])
    assert.ok(serialized.includes(included));
  for (const excluded of [
    "Old topic",
    "Old answer",
    "SECRET TOOL OUTPUT",
    "INTERMEDIATE TOOL PLAN",
    "PRIVATE REASONING",
  ])
    assert.ok(!serialized.includes(excluded));
});

test("oversized context stays bounded and preserves both sides of the latest exchange", () => {
  const context = buildNextPromptContext([
    user("old".repeat(5_000)),
    assistant("old answer"),
    user(`LATEST USER ${"😀".repeat(9_000)} USER END`),
    assistant(`LATEST ASSISTANT ${"b".repeat(15_000)} ASSISTANT END`),
  ]);
  assert.ok(context);
  const text = context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
    )
    .join("");
  assert.ok(Array.from(text).length <= 12_000);
  for (const marker of ["LATEST USER", "USER END", "LATEST ASSISTANT", "ASSISTANT END"])
    assert.ok(text.includes(marker), marker);
  assert.ok(!text.includes("old answer"));
});

test("suggestions require a successful completed exchange and reject unsafe terminal output", () => {
  assert.equal(buildNextPromptContext([user("Unanswered")]), undefined);
  assert.equal(
    buildNextPromptContext([
      user("Request"),
      {
        type: "message",
        message: { role: "assistant", stopReason: "aborted", content: "Partial" },
      },
    ]),
    undefined,
  );
  assert.equal(
    buildNextPromptContext([user("Earlier"), assistant("Earlier answer"), user("New unanswered")]),
    undefined,
  );
  assert.equal(normalizeNextPromptSuggestion('"Yes, implement it"'), "Yes, implement it");
  for (const text of [
    "",
    "Two\nlines",
    "a".repeat(101),
    "\x1b[31mRun it",
    "hello\tworld",
    "hello\u2028world",
    "```bash",
    "- Do it",
  ])
    assert.equal(normalizeNextPromptSuggestion(text), undefined, text);
});
