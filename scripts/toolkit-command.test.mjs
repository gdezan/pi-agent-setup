import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runToolkitCommand, ToolkitCancelled } from "./toolkit-command.mjs";

function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-wizard-command-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("package command arguments are literal and stdout/stderr stay behind the output callback", async (t) => {
  let output = "";
  await runToolkitCommand({ command: process.execPath, cwd: workspace(t),
    args: ["-e", "console.log(process.argv[1]); console.error('stderr captured')", "literal; $(not-a-command)"],
    onOutput: (text) => { output += text; } });
  assert.match(output, /literal; \$\(not-a-command\)/);
  assert.match(output, /stderr captured/);
});

test("command failures keep bounded diagnostics", async (t) => {
  await assert.rejects(runToolkitCommand({ command: process.execPath, cwd: workspace(t),
    args: ["-e", "process.stderr.write('x'.repeat(100000)); process.exitCode=2"] }), (error) => {
    assert.match(error.message, /Toolkit command failed/);
    assert.ok(error.message.length < 17000);
    return true;
  });
});

test("pre-cancelled commands never start", async (t) => {
  await assert.rejects(runToolkitCommand({ command: "this-command-must-not-be-spawned", args: [], cwd: workspace(t),
    signal: AbortSignal.abort() }), ToolkitCancelled);
});

test("cancellation waits for a process group with a SIGTERM-resistant descendant", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const controller = new AbortController();
  let output = "";
  let parent;
  t.after(() => { if (parent) { try { process.kill(-parent, "SIGKILL"); } catch {} } });
  const grandchild = "process.on('SIGTERM',()=>{}); console.log('descendant ready'); setInterval(()=>{},1000)";
  const source = `console.log('parent='+process.pid); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000)`;
  await assert.rejects(runToolkitCommand({ command: process.execPath, args: ["-e", source], cwd: workspace(t), signal: controller.signal,
    onOutput: (text) => {
      output += text;
      parent = Number(output.match(/parent=(\d+)/)?.[1]) || parent;
      if (output.includes("descendant ready")) controller.abort();
    } }), ToolkitCancelled);
  assert.ok(parent);
  assert.throws(() => process.kill(parent, 0), { code: "ESRCH" });
});
