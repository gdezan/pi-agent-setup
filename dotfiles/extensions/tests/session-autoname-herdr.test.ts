import assert from "node:assert/strict";
import test from "node:test";
import {
  herdrAgentNameCandidates,
  herdrAgentNameFromTitle,
  parseHerdrFailure,
  renameHerdrAgent,
  resolveHerdrAgentTarget,
  syncHerdrAgentName,
  type HerdrCommandRunner,
  type HerdrCommandResult,
} from "../session-autoname.ts";

const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

function recordingRunner(
  results: HerdrCommandResult[],
): HerdrCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];

  const runner = async (_bin: string, args: readonly string[]): Promise<HerdrCommandResult> => {
    calls.push([...args]);
    return results[Math.min(calls.length - 1, results.length - 1)] ?? { ok: true };
  };

  return Object.assign(runner, { calls });
}

test("derives a valid Herdr agent name from a session title", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Herdr agent sidebar label behavior", "herdr-agent-sidebar-label"],
    ["Fix: cron parser, twice!", "fix-cron-parser-twice"],
    ["Autonome sessionörn", "autonome-sessionorn"],
    ["3 bugs in the watcher", "session-3-bugs-in-the-watcher"],
    ["--dashes--", "dashes"],
    ["Приветствие", undefined],
    ["!!! ???", undefined],
    ["", undefined],
  ];

  for (const [title, expected] of cases) {
    assert.equal(herdrAgentNameFromTitle(title), expected, title);
  }
});

test("keeps every derived name inside the Herdr name limits", () => {
  for (const title of [
    "Refactor the terminal session control and observe contract for embedded bridges",
    "Herdr agent sidebar label behavior",
    "x".repeat(80),
  ]) {
    const name = herdrAgentNameFromTitle(title);
    assert.ok(name, title);
    assert.match(name, HERDR_AGENT_NAME, title);
    assert.doesNotMatch(name, /[-_]$/u, title);
  }
});

test("keeps the base name first and fits suffixes inside the limit", () => {
  const candidates = herdrAgentNameCandidates("herdr-agent-sidebar-label");

  assert.equal(candidates[0], "herdr-agent-sidebar-label");
  assert.deepEqual(candidates.slice(1), [
    "herdr-agent-sidebar-label-2",
    "herdr-agent-sidebar-label-3",
    "herdr-agent-sidebar-label-4",
  ]);
  assert.ok(candidates.every((candidate) => HERDR_AGENT_NAME.test(candidate)));
});

test("resolves a Herdr target only inside a Herdr pane", () => {
  assert.deepEqual(resolveHerdrAgentTarget({ HERDR_ENV: "1", HERDR_PANE_ID: "w13:p5" }), {
    bin: "herdr",
    paneId: "w13:p5",
  });
  assert.deepEqual(
    resolveHerdrAgentTarget({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w13:p5",
      HERDR_BIN_PATH: "/opt/herdr",
    }),
    { bin: "/opt/herdr", paneId: "w13:p5" },
  );
  assert.equal(resolveHerdrAgentTarget({ HERDR_PANE_ID: "w13:p5" }), undefined);
  assert.equal(resolveHerdrAgentTarget({ HERDR_ENV: "0", HERDR_PANE_ID: "w13:p5" }), undefined);
  assert.equal(resolveHerdrAgentTarget({ HERDR_ENV: "1", HERDR_PANE_ID: " " }), undefined);
});

test("reads the structured Herdr failure from CLI output", () => {
  assert.deepEqual(
    parseHerdrFailure(
      '{"error":{"code":"agent_name_taken","message":"agent name proposal-review is already used"},"id":"cli:agent:rename"}\n',
    ),
    { code: "agent_name_taken", message: "agent name proposal-review is already used" },
  );
  assert.deepEqual(
    parseHerdrFailure(
      undefined,
      '{"error":{"code":"invalid_agent_name","message":"agent name must start"}}',
    ),
    { code: "invalid_agent_name", message: "agent name must start" },
  );
  assert.deepEqual(parseHerdrFailure("not json\nstill not json"), {});
});

test("renames the pane agent once when Herdr accepts the name", async () => {
  const runner = recordingRunner([{ ok: true }]);
  const outcome = await renameHerdrAgent(
    { bin: "herdr", paneId: "w1:p2" },
    "Fix cron parsing",
    runner,
  );

  assert.deepEqual(outcome, { kind: "renamed", name: "fix-cron-parsing" });
  assert.deepEqual(runner.calls, [["agent", "rename", "w1:p2", "fix-cron-parsing"]]);
});

test("retries a taken name and stops at the first accepted suffix", async () => {
  const runner = recordingRunner([
    { ok: false, code: "agent_name_taken", message: "agent name fix-cron-parsing is already used" },
    { ok: true },
  ]);
  const outcome = await renameHerdrAgent(
    { bin: "herdr", paneId: "w1:p2" },
    "Fix cron parsing",
    runner,
  );

  assert.deepEqual(outcome, { kind: "renamed", name: "fix-cron-parsing-2" });
  assert.deepEqual(runner.calls, [
    ["agent", "rename", "w1:p2", "fix-cron-parsing"],
    ["agent", "rename", "w1:p2", "fix-cron-parsing-2"],
  ]);
});

test("reports a non-collision failure without retrying", async () => {
  const runner = recordingRunner([
    { ok: false, code: "agent_not_found", message: "no agent in pane w1:p2" },
  ]);
  const outcome = await renameHerdrAgent(
    { bin: "herdr", paneId: "w1:p2" },
    "Fix cron parsing",
    runner,
  );

  assert.deepEqual(outcome, { kind: "failed", message: "no agent in pane w1:p2" });
  assert.equal(runner.calls.length, 1);
});

test("gives up after the suffix attempts when every name is taken", async () => {
  const runner = recordingRunner([
    { ok: false, code: "agent_name_taken", message: "already used" },
  ]);
  const outcome = await renameHerdrAgent(
    { bin: "herdr", paneId: "w1:p2" },
    "Fix cron parsing",
    runner,
  );

  assert.deepEqual(outcome, { kind: "failed", message: "already used" });
  assert.equal(runner.calls.length, 4);
});

test("skips the Herdr call for unnameable titles and outside Herdr", async () => {
  const runner = recordingRunner([{ ok: true }]);

  assert.equal(
    (await renameHerdrAgent({ bin: "herdr", paneId: "w1:p2" }, "Приветствие", runner)).kind,
    "failed",
  );
  assert.equal(runner.calls.length, 0);

  assert.equal(await syncHerdrAgentName("Fix cron parsing", runner, {}), undefined);
  assert.equal(runner.calls.length, 0);

  assert.deepEqual(
    await syncHerdrAgentName("Fix cron parsing", runner, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
    }),
    { kind: "renamed", name: "fix-cron-parsing" },
  );
  assert.deepEqual(runner.calls, [["agent", "rename", "w1:p2", "fix-cron-parsing"]]);
});
