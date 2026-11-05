import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sessionAutoname from "../session-autoname.ts";

const response = (text = "faster session naming", stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function sessionAutonameHarness({ enabled = true, available = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-autoname-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldHerdr = process.env.HERDR_ENV;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.HERDR_ENV;
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      utilityModel: { model: "test/utility", thinkingLevel: "low" },
      sessionAutoname: { enabled },
    }),
  );
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const requests: Array<{
    signal: AbortSignal;
    context: unknown;
    resolve: (value: unknown) => void;
  }> = [];
  let sessionManager = SessionManager.inMemory(dir);
  const ctx = {
    cwd: dir,
    isProjectTrusted: () => false,
    get sessionManager() {
      return sessionManager;
    },
    modelRegistry: {
      find: () => (available ? { provider: "test", id: "utility", reasoning: true } : undefined),
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, context: unknown, options: { signal: AbortSignal }) => ({
        result: () =>
          new Promise((resolve) => requests.push({ signal: options.signal, context, resolve })),
      }),
    },
  };
  sessionAutoname({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, handler),
    registerCommand: () => {},
    getSessionName: () => sessionManager.getSessionName(),
    setSessionName: (name: string) => sessionManager.appendSessionInfo(name),
  } as never);
  const emit = (event: string, fields = {}) =>
    handlers.get(event)?.({ type: event, ...fields }, ctx);
  const startMessage = (content: unknown, role = "user") =>
    emit("message_start", { message: { role, content } });
  return {
    requests,
    emit,
    startMessage,
    get sessionManager() {
      return sessionManager;
    },
    switchSession: () => {
      sessionManager = SessionManager.inMemory(dir);
    },
    cleanup: () => {
      emit("session_shutdown");
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      if (oldHerdr === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = oldHerdr;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("names from the first user message before it is persisted or any assistant reply exists", async () => {
  const h = sessionAutonameHarness();
  try {
    assert.equal(
      h.startMessage("Make session naming faster"),
      undefined,
      "naming must not block the agent",
    );
    assert.equal(h.requests.length, 1, "must start without waiting for agent_settled");
    assert.equal(h.sessionManager.getBranch().length, 0);
    assert.match(JSON.stringify(h.requests[0].context), /Make session naming faster/);
    h.requests[0].resolve(response());
    await flush();
    assert.equal(h.sessionManager.getSessionName(), "faster session naming");
  } finally {
    h.cleanup();
  }
});

test("keeps earlier branch user text and includes the unpersisted prompt exactly once", () => {
  const h = sessionAutonameHarness();
  try {
    h.sessionManager.appendMessage({
      role: "user",
      content: "Earlier request",
      timestamp: Date.now(),
    });
    h.startMessage([
      { type: "text", text: "Current request" },
      { type: "image", data: "ignore-image" },
    ]);
    assert.equal(h.requests.length, 1);
    const context = JSON.stringify(h.requests[0].context);
    assert.match(context, /Earlier request/);
    assert.equal(context.match(/Current request/g)?.length, 1);
    assert.doesNotMatch(context, /ignore-image/);
  } finally {
    h.cleanup();
  }
});

test("ignores non-user and textless messages without consuming the naming attempt", () => {
  const h = sessionAutonameHarness();
  try {
    h.startMessage("Assistant reply", "assistant");
    h.startMessage("Tool output", "toolResult");
    h.startMessage("Injected message", "custom");
    h.startMessage([{ type: "image", data: "image" }]);
    h.startMessage("  ");
    assert.equal(h.requests.length, 0);
    h.startMessage("A real request");
    assert.equal(h.requests.length, 1);
  } finally {
    h.cleanup();
  }
});

test("attempts naming only once across subsequent messages and settled events", async () => {
  const h = sessionAutonameHarness();
  try {
    h.startMessage("First request");
    h.startMessage("Steering request");
    h.emit("agent_settled", { aborted: false });
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve(response("", "error"));
    await flush();
    h.startMessage("Next request");
    h.emit("agent_settled", { aborted: false });
    assert.equal(h.requests.length, 1, "failed attempts must not repeatedly spend tokens");
  } finally {
    h.cleanup();
  }
});

test("preserves manual names both before and during background naming", async () => {
  const h = sessionAutonameHarness();
  try {
    h.sessionManager.appendSessionInfo("Manual title");
    h.startMessage("Already named");
    assert.equal(h.requests.length, 0);
    h.switchSession();
    h.startMessage("Unnamed request");
    assert.equal(h.requests.length, 1);
    h.sessionManager.appendSessionInfo("Manual override");
    h.requests[0].resolve(response());
    await flush();
    assert.equal(h.sessionManager.getSessionName(), "Manual override");
  } finally {
    h.cleanup();
  }
});

test("shutdown cancels naming and prevents a late title from being applied", async () => {
  const h = sessionAutonameHarness();
  try {
    h.startMessage("Name this session");
    assert.equal(h.requests.length, 1);
    h.emit("session_shutdown");
    assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve(response());
    await flush();
    assert.equal(h.sessionManager.getSessionName(), undefined);
  } finally {
    h.cleanup();
  }
});

test("late responses cannot name a different session and each session gets its own attempt", async () => {
  const h = sessionAutonameHarness();
  try {
    h.startMessage("Original request");
    assert.equal(h.requests.length, 1);
    h.switchSession();
    h.requests[0].resolve(response("old session title"));
    await flush();
    assert.equal(h.sessionManager.getSessionName(), undefined);
    h.startMessage("New request");
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve(response("new session title"));
    await flush();
    assert.equal(h.sessionManager.getSessionName(), "new session title");
  } finally {
    h.cleanup();
  }
});

test("disabled naming or an unavailable utility model never starts a request", () => {
  for (const options of [{ enabled: false }, { available: false }]) {
    const h = sessionAutonameHarness(options);
    try {
      h.startMessage("Name this session");
      assert.equal(h.requests.length, 0);
    } finally {
      h.cleanup();
    }
  }
});
