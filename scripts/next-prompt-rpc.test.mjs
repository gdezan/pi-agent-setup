import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test(
  "RPC publishes copyable suggestions before settlement without adding model messages",
  { timeout: 30_000 },
  async (t) => {
    const base = mkdtempSync(join(tmpdir(), "pi-next-prompt-rpc-"));
    const agent = join(base, "agent");
    mkdirSync(agent);
    const settings = join(agent, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({ utilityModel: { model: "utility-test/utility", thinkingLevel: "low" } }),
    );
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--offline",
        "--no-approve",
        "--no-session",
        "--provider",
        "utility-test",
        "--model",
        "conversation",
        "-e",
        join(root, "extensions/tests/fixtures/utility-model-provider.ts"),
        "-e",
        join(root, "extensions/pi-next-prompt/index.ts"),
      ],
      {
        cwd: base,
        env: {
          ...process.env,
          HOME: base,
          PI_CODING_AGENT_DIR: agent,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
      },
    );
    const lines = createInterface({ input: child.stdout });
    const events = lines[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      lines.close();
      child.kill();
      rmSync(base, { recursive: true, force: true });
    });
    let nextId = 0;
    async function send(command, done) {
      const id = String(++nextId);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      const records = [];
      while (true) {
        const line = await events.next();
        assert.ok(!line.done, stderr);
        const event = JSON.parse(line.value);
        records.push(event);
        if (event.type === "response" && event.id === id)
          assert.equal(event.success, true, JSON.stringify(event));
        if (done(event, id)) return records;
      }
    }
    const command = (text) =>
      send({ type: "prompt", message: text }, (e, id) => e.type === "response" && e.id === id);
    const prompt = () =>
      send(
        { type: "prompt", message: "Please fix the settings bug" },
        (e) => e.type === "agent_settled",
      );
    const suggestions = (records) =>
      records
        .filter(
          (e) =>
            e.type === "extension_ui_request" &&
            e.method === "notify" &&
            e.message.startsWith("Next:"),
        )
        .map((e) => e.message);
    const expected = ["Next: Yes, implement the fix"];
    assert.deepEqual(suggestions(await prompt()), expected);
    const messages = await send(
      { type: "get_messages" },
      (e, id) => e.type === "response" && e.id === id,
    );
    assert.deepEqual(
      messages
        .at(-1)
        .data.messages.map((m) => m.role)
        .filter((role) => role !== "system"),
      ["user", "assistant"],
    );
    let useResponse = false;
    let useSettled = false;
    const used = await send({ type: "prompt", message: "/use-next-prompt" }, (e, id) => {
      if (e.type === "response" && e.id === id) useResponse = true;
      if (e.type === "agent_settled") useSettled = true;
      return useResponse && useSettled;
    });
    const userMessages = used.filter((e) => e.type === "message_end" && e.message.role === "user");
    assert.equal(userMessages.length, 1);
    const content = userMessages[0].message.content;
    assert.equal(
      typeof content === "string" ? content : content.map((part) => part.text).join(""),
      "Yes, implement the fix",
    );
    await command("/next-prompt editor");
    assert.deepEqual(suggestions(await prompt()), []);
    const unavailable = await command("/use-next-prompt");
    assert.ok(
      unavailable.some(
        (e) =>
          e.type === "extension_ui_request" &&
          e.method === "notify" &&
          e.message === "No next prompt available.",
      ),
    );
    assert.ok(!unavailable.some((e) => e.type === "agent_start"));
    await command("/next-prompt transcript");
    assert.deepEqual(suggestions(await prompt()), expected);
    await command("/next-prompt off");
    assert.deepEqual(suggestions(await prompt()), []);
    await command("/next-prompt on");
    assert.deepEqual(suggestions(await prompt()), expected);
    await command("/next-prompt auto");
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).nextPrompt.mode, "auto");
    assert.deepEqual(suggestions(await prompt()), expected);
  },
);
