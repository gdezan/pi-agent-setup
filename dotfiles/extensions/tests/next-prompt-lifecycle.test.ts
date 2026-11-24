import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CustomEditor,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import nextPrompt from "../gd-next-prompt/next-prompt-extension.ts";

const response = (text = "Yes, implement it") => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text }],
  usage: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, cost: { total: 0.00002 } },
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function nextPromptHarness() {
  const dir = mkdtempSync(join(tmpdir(), "pi-next-prompt-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ utilityModel: { model: "test/utility", thinkingLevel: "low" } }),
  );
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const requests: Array<{
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    options: Record<string, unknown>;
    context: unknown;
  }> = [];
  let renders = 0;
  let cycles = 0;
  let submissions = 0;
  const tui = { terminal: { rows: 30 }, requestRender: () => renders++ };
  const theme = { borderColor: (text: string) => text };
  const keybindings = {
    matches: (data: string, action: string) =>
      data === "\x10" && action === "app.model.cycleForward",
  };
  class ExistingEditor extends CustomEditor {
    handleInput(data: string): void {
      if (data === "\x10") {
        cycles++;
        return;
      }
      super.handleInput(data);
    }
  }
  let factory = (t: never, th: never, kb: never) => new ExistingEditor(t, th, kb);
  const previousFactory = factory;
  let editor = factory(tui as never, theme as never, keybindings as never);
  const sessionManager = SessionManager.inMemory(dir);
  sessionManager.appendMessage({
    role: "user",
    content: "Can you fix this?",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage(response("Shall I implement the fix?") as never);
  let queued = false;
  const ctx = {
    mode: "tui",
    cwd: dir,
    isProjectTrusted: () => false,
    isIdle: () => true,
    hasPendingMessages: () => queued,
    sessionManager,
    ui: {
      theme: { fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m` },
      getEditorText: () => editor.getText(),
      getEditorComponent: () => factory,
      setEditorComponent: (value: typeof factory) => {
        factory = value;
        editor = factory(tui as never, theme as never, keybindings as never);
        editor.focused = true;
        editor.onSubmit = () => submissions++;
      },
      notify: (text: string) => notices.push(text),
    },
    modelRegistry: {
      find: () => ({ provider: "test", id: "utility", reasoning: true }),
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, context: unknown, options: Record<string, unknown>) => ({
        result: () =>
          new Promise((resolve) =>
            requests.push({ signal: options.signal as AbortSignal, options, context, resolve }),
          ),
      }),
    },
  } as unknown as ExtensionContext;
  nextPrompt({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, handler),
    registerCommand: (name: string, command: never) => commands.set(name, command),
  } as never);
  const emit = (event: string, fields = {}) =>
    handlers.get(event)?.({ type: event, ...fields }, ctx);
  emit("session_start");
  return {
    ctx,
    requests,
    notices,
    sessionManager,
    emit,
    command: (args: string) => commands.get("next-prompt")!.handler(args, ctx),
    get editor() {
      return editor;
    },
    get cycles() {
      return cycles;
    },
    get submissions() {
      return submissions;
    },
    get renders() {
      return renders;
    },
    setQueued: (value: boolean) => {
      queued = value;
    },
    cleanup: () => {
      emit("session_shutdown");
      assert.equal(factory, previousFactory);
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("settled reply shows a bounded ghost, preserves model-cycle shortcuts, and accepts without sending", async () => {
  const h = nextPromptHarness();
  const suggestion =
    "File a ticket for the Windows ARM64 installer failing on an apostrophe in the custom install path; leave the historical warnings out.";
  try {
    h.emit("agent_end");
    assert.equal(h.requests.length, 0);
    h.emit("agent_settled");
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.reasoning, "low");
    assert.equal(h.requests[0].options.maxTokens, 512);
    assert.equal(h.requests[0].options.maxRetries, 0);
    h.requests[0].resolve(response(suggestion));
    await flush();
    for (const width of [10, 24, 80]) {
      const lines = h.editor.render(width);
      assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    const ghostRow = h.editor.render(80).find((line) => line.includes(CURSOR_MARKER))!;
    assert.ok(
      stripTerminalSequences(ghostRow).startsWith("File a ticket for the Windows"),
      "ghost and accepted text must share the same starting column",
    );
    assert.match(stripTerminalSequences(ghostRow), /…/u);
    assert.equal(h.editor.getText(), "");
    h.editor.handleInput("\x10");
    assert.equal(h.cycles, 1);
    assert.ok(stripTerminalSequences(h.editor.render(80).join("\n")).includes("File a ticket"));
    h.editor.handleInput("\t");
    assert.equal(h.editor.getText(), suggestion);
    assert.equal(h.submissions, 0);
    h.editor.handleInput("\r");
    assert.equal(h.submissions, 1);
    await h.command("");
    assert.match(h.notices.at(-1)!, /output incl\. reasoning 25.*cost \$0\.000020/);
    assert.ok(h.renders > 0);
  } finally {
    h.cleanup();
  }
});

test("wide Unicode suggestions fit padded editors, Right Arrow accepts, and Escape dismisses visible text", async () => {
  const h = nextPromptHarness();
  try {
    const text = "確認してから進めて 👩‍💻";
    h.editor.setPaddingX(2);
    h.emit("agent_settled");
    h.requests[0].resolve(response(text));
    await flush();
    for (const width of [1, 2, 3, 4, 8, 24, 80]) {
      const lines = h.editor.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        JSON.stringify({ width, lines, widths: lines.map(visibleWidth) }),
      );
      assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
    }
    h.editor.handleInput("\x1b[C");
    assert.equal(h.editor.getText(), text);
    assert.equal(h.submissions, 0);
    h.editor.setText("");
    h.sessionManager.appendMessage({
      role: "user",
      content: "Next question",
      timestamp: Date.now(),
    });
    h.sessionManager.appendMessage(response("Proceed?") as never);
    h.emit("agent_settled");
    h.requests[1].resolve(response("Yes, implement it"));
    await flush();
    assert.ok(stripTerminalSequences(h.editor.render(80).join("\n")).includes("Yes, implement it"));
    h.editor.handleInput("\x1b");
    assert.equal(h.editor.getText(), "");
    assert.ok(
      !stripTerminalSequences(h.editor.render(80).join("\n")).includes("Yes, implement it"),
    );
  } finally {
    h.cleanup();
  }
});

test("typing then clearing the editor cancels a pending response and cannot resurrect the same suggestion", async () => {
  const h = nextPromptHarness();
  try {
    h.emit("agent_settled");
    h.editor.handleInput("x");
    assert.equal(h.requests[0].signal.aborted, true);
    h.editor.setText("");
    h.requests[0].resolve(response());
    await flush();
    assert.ok(
      !stripTerminalSequences(h.editor.render(80).join("\n")).includes("Yes, implement it"),
    );
    h.emit("agent_settled");
    assert.equal(h.requests.length, 1);
  } finally {
    h.cleanup();
  }
});

test("suggestion requests use context edits rather than the original transcript", () => {
  const h = nextPromptHarness();
  try {
    const [omittedRequest] = h.sessionManager.getBranch();
    const replacedRequest = h.sessionManager.appendMessage({
      role: "user",
      content: "Review the original private draft",
      timestamp: Date.now(),
    });
    h.sessionManager.appendMessage(response("Review complete") as never);
    h.sessionManager.appendContextEdit(omittedRequest.id, null);
    h.sessionManager.appendContextEdit(replacedRequest, { content: "Review the public draft" });
    h.emit("agent_settled");
    assert.equal(h.requests.length, 1);
    const context = JSON.stringify(h.requests[0].context);
    assert.match(context, /Review the public draft/);
    assert.doesNotMatch(context, /original private draft|Can you fix this\?/);
  } finally {
    h.cleanup();
  }
});

test("suggestions include relevant projected tool excerpts from the latest exchange only", () => {
  const h = nextPromptHarness();
  const addUser = (content: string) =>
    h.sessionManager.appendMessage({ role: "user", content, timestamp: 0 });
  const addResult = (toolName: string, text: string) =>
    h.sessionManager.appendMessage({
      role: "toolResult",
      toolName,
      toolCallId: text.slice(0, 20),
      content: [{ type: "text", text }],
      details: { internal: "PRIVATE_TOOL_METADATA" },
      isError: false,
      timestamp: 0,
    });
  try {
    addUser("Check the checkout logs");
    addResult("bash", "FAIL tests/old-checkout.test.ts > uses regional currency");
    h.sessionManager.appendMessage(response("That earlier check is done.") as never);

    addUser("Find which checkout setting forces USD instead of the customer's currency.");
    const replaced = addResult("read", 'checkoutCurrencyOverride = "OLD_PRIVATE_VALUE"');
    h.sessionManager.appendContextEdit(replaced, {
      content: [
        {
          type: "text",
          text: 'otherPackage = "UNRELATED_OUTPUT"\n\x1b[31mcheckoutCurrencyOverride = "USD"\x1b[0m\ncheckoutApiKey = "PRIVATE_CREDENTIAL"',
        },
      ],
    });
    const omitted = addResult("bash", "FAIL tests/omitted-checkout.test.ts > displays USD");
    h.sessionManager.appendContextEdit(omitted, null);
    addResult(
      "bash",
      `Startup trace unrelated to the request\nFAIL tests/country-checkout.test.ts > keeps checkout currency in CAD\n${"long currency dump ".repeat(90)}`,
    );
    h.sessionManager.appendMessage(
      response("The checkout currency setting overrides the locale.") as never,
    );
    h.emit("agent_settled");

    assert.equal(h.requests.length, 1);
    const context = JSON.stringify(h.requests[0].context);
    assert.match(context, /checkoutCurrencyOverride.*USD/u);
    assert.match(context, /tests\/country-checkout\.test\.ts/u);
    assert.doesNotMatch(
      context,
      /old-checkout|omitted-checkout|OLD_PRIVATE_VALUE|UNRELATED_OUTPUT|PRIVATE_CREDENTIAL|PRIVATE_TOOL_METADATA|Startup trace|long currency dump|001b/u,
    );
  } finally {
    h.cleanup();
  }
});

test("queued work, failed replies, and disabled suggestions do not launch requests", async () => {
  const h = nextPromptHarness();
  try {
    h.setQueued(true);
    h.emit("agent_settled");
    h.setQueued(false);
    h.emit("agent_settled", { aborted: true });
    assert.equal(h.requests.length, 0);
    await h.command("off");
    h.emit("agent_settled");
    assert.equal(h.requests.length, 0);
    await h.command("on");
    h.sessionManager.appendMessage({ ...response(), stopReason: "error" } as never);
    h.emit("agent_settled");
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

test("Escape, branch navigation, and new runs discard late suggestions", async () => {
  for (const action of [
    "escape",
    "session_before_tree",
    "agent_start",
    "session_before_switch",
    "ui_prompt_start",
  ]) {
    const h = nextPromptHarness();
    try {
      h.emit("agent_settled");
      if (action === "escape") h.editor.handleInput("\x1b");
      else h.emit(action);
      assert.equal(h.requests[0].signal.aborted, true, action);
      h.requests[0].resolve(response());
      await flush();
      assert.equal(h.editor.getText(), "");
      assert.ok(
        !stripTerminalSequences(h.editor.render(80).join("\n")).includes("Yes, implement it"),
        action,
      );
    } finally {
      h.cleanup();
    }
  }
});
