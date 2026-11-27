import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionNamingExcerpt,
  extractActiveBranchUserText,
  normalizeSessionNamingTitle,
  shouldAutoNameSession,
  type SessionAutoNameInput,
} from "../pi-session-autoname/session-autoname.ts";

const autoNameInput: SessionAutoNameInput = {
  enabled: true,
  attempted: false,
  sessionName: undefined,
  hasUserText: true,
};

test("extracts raw user text and ignores assistant and image content", () => {
  assert.equal(
    extractActiveBranchUserText([
      { type: "message", message: { role: "user", content: "First" } },
      { type: "message", message: { role: "assistant", content: "Ignore" } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Second" },
            { type: "image", data: "ignore" },
          ],
        },
      },
    ]),
    "First\n\nSecond",
  );
});

test("auto names only the first user text of an unnamed, enabled session", () => {
  assert.equal(shouldAutoNameSession(autoNameInput), true);
  assert.equal(shouldAutoNameSession({ ...autoNameInput, enabled: false }), false);
  assert.equal(shouldAutoNameSession({ ...autoNameInput, attempted: true }), false);
  assert.equal(shouldAutoNameSession({ ...autoNameInput, sessionName: "Manual" }), false);
  assert.equal(shouldAutoNameSession({ ...autoNameInput, hasUserText: false }), false);
});

test("keeps the beginning and end within the naming context limit", () => {
  const excerpt = createSessionNamingExcerpt(`${"a".repeat(2_500)}\n${"b".repeat(7_000)}`);

  assert.equal(Array.from(excerpt).length, 8_000);
  assert.match(excerpt, /earlier user context omitted/);
  assert.ok(excerpt.startsWith("a"));
  assert.ok(excerpt.endsWith("b"));
});

test("normalizes a title to the display-name constraints", () => {
  assert.equal(
    normalizeSessionNamingTitle("**Fix auth flow**\nExtra explanation"),
    "Fix auth flow",
  );
  assert.equal(
    normalizeSessionNamingTitle(
      "1. Add support for a very long session naming title that should be shortened",
    ),
    "Add support for a very",
  );
  assert.equal(normalizeSessionNamingTitle("\n```\nRename sessions\n```"), "Rename sessions");
  assert.equal(normalizeSessionNamingTitle("!!!"), undefined);
  assert.ok(Array.from(normalizeSessionNamingTitle("é".repeat(80)) ?? "").length <= 60);
});
