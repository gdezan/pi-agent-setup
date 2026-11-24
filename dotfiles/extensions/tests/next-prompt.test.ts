import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildNextPromptContext,
  normalizeNextPromptSuggestion,
} from "../gd-next-prompt/next-prompt-context.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string) => ({
  type: "message",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

function contextFrom(entries: { type: string; message: unknown }[]) {
  const session = SessionManager.inMemory();
  for (const { message } of entries) session.appendMessage(message as never);
  return buildNextPromptContext(session.buildSessionProjection().entries);
}

test("suggestion context keeps earlier requests before earlier replies and excludes irrelevant output", () => {
  const context = contextFrom([
    user("Old topic"),
    assistant("Old answer"),
    user("First recent request"),
    assistant("First recent answer"),
    user("Second recent request"),
    assistant("Second recent answer"),
    user("Latest request"),
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "UNRELATED TOOL OUTPUT" }],
      },
    },
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
    "Old topic",
    "First recent request",
    "Second recent request",
    "Latest request",
    "Should I implement this?",
  ])
    assert.ok(serialized.includes(included));
  for (const excluded of [
    "Old answer",
    "UNRELATED TOOL OUTPUT",
    "INTERMEDIATE TOOL PLAN",
    "PRIVATE REASONING",
  ])
    assert.ok(!serialized.includes(excluded));
});

test("oversized context stays bounded and preserves both sides of the latest exchange", () => {
  const context = contextFrom([
    user("old".repeat(5_000)),
    assistant("old answer"),
    user(`LATEST USER ${"😀".repeat(9_000)} USER END`),
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "FAIL tests/packaging.test.ts > signing is present" }],
      },
    },
    assistant(
      `LATEST ASSISTANT ${"b".repeat(7_000)}\n33. FAIL | PACKAGING FINDING\n${"b".repeat(8_000)} ASSISTANT END`,
    ),
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
  for (const marker of [
    "LATEST USER",
    "USER END",
    "LATEST ASSISTANT",
    "ASSISTANT END",
    "PACKAGING FINDING",
  ])
    assert.ok(text.includes(marker), marker);
  assert.doesNotMatch(text, /old answer|tests\/packaging\.test\.ts/u);
});

test("suggestions require a successful completed exchange and reject unsafe terminal output", () => {
  assert.equal(contextFrom([user("Unanswered")]), undefined);
  assert.equal(
    contextFrom([
      user("Request"),
      {
        type: "message",
        message: { role: "assistant", stopReason: "aborted", content: "Partial" },
      },
    ]),
    undefined,
  );
  assert.equal(
    contextFrom([user("Earlier"), assistant("Earlier answer"), user("New unanswered")]),
    undefined,
  );
  assert.equal(normalizeNextPromptSuggestion('"Yes, implement it"'), "Yes, implement it");
  const longSuggestion = "a".repeat(160);
  assert.equal(normalizeNextPromptSuggestion(longSuggestion), longSuggestion);
  for (const text of [
    "",
    "Two\nlines",
    "a".repeat(161),
    "\x1b[31mRun it",
    "hello\tworld",
    "hello\u2028world",
    "```bash",
    "- Do it",
  ])
    assert.equal(normalizeNextPromptSuggestion(text), undefined, text);
});
