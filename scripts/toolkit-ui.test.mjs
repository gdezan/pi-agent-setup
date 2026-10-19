import assert from "node:assert/strict";
import test from "node:test";
import { renderToolkitDiff, supportsToolkitColor } from "./toolkit-ui.mjs";

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("diff output sanitizes terminal controls before applying diff colors", () => {
  const current = "safe current\n";
  const proposed = "safe \x1b[2J proposed\n";
  const rendered = renderToolkitDiff("current file", "proposed file", current, proposed, { color: true });

  assert.match(rendered, /\x1b\[36m@@ .* @@\x1b\[0m/);
  assert.match(rendered, /\x1b\[31m-safe current\x1b\[0m/);
  assert.match(rendered, /\x1b\[32m\+safe  proposed\x1b\[0m/);
  assert.doesNotMatch(stripAnsi(rendered), /\x1b/);
});

test("diff output labels both versions and reports when the diff is truncated", () => {
  const rendered = renderToolkitDiff("current APPEND_SYSTEM.md", "proposed APPEND_SYSTEM.md", "old\n", `${"new\n".repeat(100)}`, { maxLength: 200 });

  assert.match(rendered, /--- current APPEND_SYSTEM\.md/);
  assert.match(rendered, /\+\+\+ proposed APPEND_SYSTEM\.md/);
  assert.match(rendered, /Diff truncated/);
});

test("color is disabled for NO_COLOR, explicit no-color, non-TTY, and dumb terminals", () => {
  const input = { isTTY: true };
  const output = { isTTY: true };
  const base = { input, output, options: {}, env: { TERM: "xterm-256color" } };

  assert.equal(supportsToolkitColor(base), true);
  assert.equal(supportsToolkitColor({ ...base, env: { ...base.env, NO_COLOR: "1" } }), false);
  assert.equal(supportsToolkitColor({ ...base, options: { "no-color": true } }), false);
  assert.equal(supportsToolkitColor({ ...base, output: { isTTY: false } }), false);
  assert.equal(supportsToolkitColor({ ...base, env: { TERM: "dumb" } }), false);

  const plain = renderToolkitDiff("current", "proposed", "old\n", "new\n", { color: false });
  assert.doesNotMatch(plain, /\x1b\[/);
});
