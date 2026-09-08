import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runToolkitSetup } from "./toolkit-setup.mjs";
import { readToolkitJson } from "./toolkit-settings.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-toolkit-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "source");
  const agentDir = join(base, "agent");
  for (const dir of ["extensions", "skills/demo", "local-packages/local"]) mkdirSync(join(root, "dotfiles", dir), { recursive: true });
  const put = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  put("package.json", { name: "@gdezan/pi-agent-setup", files: ["dotfiles/extensions", "dotfiles/skills", "dotfiles/local-packages"],
    pi: { extensions: ["./dotfiles/extensions/demo.ts"], skills: ["./dotfiles/skills"] } });
  put("manifest.json", { version: 1, packages: [
    { id: "one", source: "npm:one", description: "One" },
    { id: "two", source: "git:git@github.com:owner/two", description: "Two" },
  ] });
  put("preferences.json", { theme: "dark", terminal: { showTerminalProgress: true } });
  put("dotfiles/APPEND_SYSTEM.md", "Shared instructions\n");
  put("dotfiles/extensions/demo.ts", "export default function demo() {}\n");
  put("dotfiles/skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo skill\n---\nDemo\n");
  const installed = [];
  const output = { isTTY: false, text: "", write(value) { this.text += value; } };
  const run = (args = ["--skip-packages"], installPackage = async (...call) => installed.push(call)) =>
    runToolkitSetup({ root, argv: ["--agent-dir", agentDir, ...args], input: { isTTY: false }, output, installPackage });
  return { base, root, agentDir, put, installed, output, run };
}

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

test("copy setup installs only allowlisted resources and seeds settings", async (t) => {
  const f = fixture(t);
  f.put("unrelated-secret.txt", "never copy");
  mkdirSync(join(f.root, "dotfiles/skills/demo/__pycache__"));
  f.put("dotfiles/skills/demo/__pycache__/cache.pyc", "never copy");
  await f.run();
  assert.deepEqual(json(join(f.agentDir, "settings.json")), {
    theme: "dark", terminal: { showTerminalProgress: true }, packages: ["toolkits/pi-agent-setup"],
  });
  const pkg = join(f.agentDir, "toolkits/pi-agent-setup");
  assert.equal(readFileSync(join(pkg, "dotfiles/extensions/demo.ts"), "utf8"), "export default function demo() {}\n");
  assert.equal(existsSync(join(pkg, "unrelated-secret.txt")), false);
  assert.equal(existsSync(join(pkg, "dotfiles/skills/demo/__pycache__")), false);
  assert.equal(existsSync(join(f.agentDir, "auth.json")), false);
  assert.equal(existsSync(join(f.agentDir, "extensions")), false);
  assert.deepEqual(f.installed, []);
});

test("reruns preserve runtime settings, credentials, extra packages, and toolkit filters", async (t) => {
  const f = fixture(t);
  await f.run();
  const settings = { defaultModel: "local-model", lastChangelogVersion: "future", theme: "light", externalEditor: "local-editor",
    packages: ["npm:extra", { source: "toolkits/pi-agent-setup", extensions: [] }] };
  writeJson(join(f.agentDir, "settings.json"), settings);
  writeFileSync(join(f.agentDir, "auth.json"), "local secret");
  await f.run();
  assert.deepEqual(json(join(f.agentDir, "settings.json")), { ...settings, terminal: { showTerminalProgress: true } });
  assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), "local secret");
  const before = readdirSync(join(f.agentDir, "toolkit-backups"));
  await f.run();
  assert.deepEqual(readdirSync(join(f.agentDir, "toolkit-backups")), before);
});

test("link and copy modes keep one package registration and never symlink settings", async (t) => {
  const f = fixture(t);
  await f.run(["--link", "--skip-packages"]);
  assert.equal(readlinkSync(join(f.agentDir, "toolkits/pi-agent-setup")), f.root);
  assert.equal(readlinkSync(join(f.agentDir, "APPEND_SYSTEM.md")), join(f.root, "dotfiles/APPEND_SYSTEM.md"));
  assert.equal(lstatSync(join(f.agentDir, "settings.json")).isSymbolicLink(), false);
  await f.run();
  assert.equal(lstatSync(join(f.agentDir, "toolkits/pi-agent-setup")).isDirectory(), true);
  assert.equal(lstatSync(join(f.agentDir, "APPEND_SYSTEM.md")).isSymbolicLink(), false);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages, ["toolkits/pi-agent-setup"]);
  assert.equal(readFileSync(join(f.root, "dotfiles/APPEND_SYSTEM.md"), "utf8"), "Shared instructions\n");
});

test("dry runs do not create a destination or execute package commands", async (t) => {
  const f = fixture(t);
  await f.run(["--dry-run", "--all-packages"]);
  assert.equal(existsSync(f.agentDir), false);
  assert.deepEqual(f.installed, []);
  assert.match(f.output.text, /Dry run: no files written/);
});

test("explicit selection preserves installed pins and filters and is reusable", async (t) => {
  const f = fixture(t);
  const pinned = { source: "npm:one@1.2.3", extensions: [] };
  writeJson(join(f.agentDir, "settings.json"), { packages: [pinned, "npm:other"] });
  await f.run(["--packages", "one"]);
  assert.deepEqual(f.installed, [["npm:one@1.2.3", f.agentDir]]);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages.slice(0, 2), [pinned, "npm:other"]);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).selectedPackages, ["one"]);
  await f.run(["--skip-packages"]);
  await f.run(["--reuse-selection"]);
  assert.equal(f.installed.length, 2);
});

test("noninteractive setup requires a concrete package selection", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run([]), /requires a terminal/);
  await assert.rejects(f.run(["--packages", "unknown"]), /Unknown toolkit package ID/);
  await assert.rejects(f.run(["--reuse-selection"]), /No saved toolkit package selection/);
  await assert.rejects(f.run(["--all-packages", "--skip-packages"]), /Conflicting toolkit package flags/);
  assert.equal(existsSync(f.agentDir), false);
});

test("malformed settings and forbidden preference keys fail before deployment", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  writeFileSync(join(f.agentDir, "settings.json"), "not json");
  await assert.rejects(f.run(), SyntaxError);
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
  writeJson(join(f.agentDir, "settings.json"), {});
  f.put("preferences.json", { defaultModel: "shared-model" });
  await assert.rejects(f.run(), /Unmanaged toolkit preference/);
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
});

test("local instruction conflicts require explicit replacement and retain a backup", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "local instructions");
  await assert.rejects(f.run(), /Local Pi instructions would be overwritten/);
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
  await f.run(["--skip-packages", "--replace-config"]);
  const backup = readdirSync(join(f.agentDir, "toolkit-backups"))[0];
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "APPEND_SYSTEM.md"), "utf8"), "local instructions");
});

test("source-owned instruction updates are applied but edited copies are protected", async (t) => {
  const f = fixture(t);
  await f.run();
  f.put("dotfiles/APPEND_SYSTEM.md", "updated source\n");
  await f.run();
  assert.equal(readFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "utf8"), "updated source\n");
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "local edit\n");
  f.put("dotfiles/APPEND_SYSTEM.md", "another source update\n");
  await assert.rejects(f.run(), /Local Pi instructions would be overwritten/);
});

test("copy updates remove obsolete package files only after backing up the owned package", async (t) => {
  const f = fixture(t);
  f.put("dotfiles/extensions/obsolete.ts", "old source");
  await f.run();
  rmSync(join(f.root, "dotfiles/extensions/obsolete.ts"));
  await f.run();
  assert.equal(existsSync(join(f.agentDir, "toolkits/pi-agent-setup/dotfiles/extensions/obsolete.ts")), false);
  const backup = readdirSync(join(f.agentDir, "toolkit-backups"))[0];
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "package/dotfiles/extensions/obsolete.ts"), "utf8"), "old source");
});

test("legacy loose resources and local package entries are not migrated implicitly", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(f.agentDir, "extensions/demo.ts"), "live source");
  await assert.rejects(f.run(), /Legacy Pi resources would load twice/);
  assert.equal(readFileSync(join(f.agentDir, "extensions/demo.ts"), "utf8"), "live source");
  rmSync(join(f.agentDir, "extensions"), { recursive: true });
  writeJson(join(f.agentDir, "settings.json"), { packages: ["local-packages/local"] });
  await assert.rejects(f.run(), /Legacy Pi resources would load twice/);
});

test("source/runtime overlap and symlinked write destinations are rejected", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(["--agent-dir", f.root, "--skip-packages"]), /Unsafe toolkit destination/);
  symlinkSync(f.root, join(f.base, "alias"), "dir");
  await assert.rejects(f.run(["--agent-dir", join(f.base, "alias/runtime"), "--skip-packages"]), /Unsafe toolkit destination/);
  mkdirSync(f.agentDir);
  symlinkSync(join(f.root, "preferences.json"), join(f.agentDir, "settings.json"));
  await assert.rejects(f.run(), /Refusing toolkit write through symlink/);
});

test("a source allowlist cannot follow a parent symlink outside the checkout", async (t) => {
  const f = fixture(t);
  const outside = join(f.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.txt"), "not toolkit source");
  symlinkSync(outside, join(f.root, "external"), "dir");
  const manifest = json(join(f.root, "package.json"));
  manifest.files.push("external/private.txt");
  f.put("package.json", manifest);
  await assert.rejects(f.run(), /Unsafe toolkit source path/);
  assert.equal(existsSync(f.agentDir), false);
});

test("invalid backup destinations fail before any owned resources are deployed", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  writeFileSync(join(f.agentDir, "toolkit-backups"), "unrelated file");
  await assert.rejects(f.run(), /Invalid toolkit write destination/);
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups"), "utf8"), "unrelated file");
});

test("failed third-party installs report failure but leave a retryable owned installation", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(["--all-packages"], async () => { throw new Error("upstream unavailable"); }), /upstream unavailable/);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).selectedPackages, ["one", "two"]);
  await f.run(["--reuse-selection"]);
  assert.equal(f.installed.length, 2);
});

test("JSON prototype keys are rejected rather than merged", (t) => {
  const f = fixture(t);
  f.put("preferences.json", '{"terminal":{"__proto__":{"polluted":true}}}');
  assert.throws(() => readToolkitJson(join(f.root, "preferences.json")), /Unsafe toolkit JSON key/);
  assert.equal({}.polluted, undefined);
});

test("real CLI validates the full repository in a fresh destination without writes", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "setup.mjs"), "--agent-dir", f.agentDir, "--dry-run", "--skip-packages"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run: no files written/);
  assert.equal(existsSync(f.agentDir), false);
});

test("real CLI passes selected packages and an isolated agent directory to Pi", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const bin = join(f.base, "bin");
  const target = join(f.base, "agent with spaces");
  const log = join(f.base, "pi-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),agentDir:process.env.PI_CODING_AGENT_DIR,sessions:process.env.PI_CODING_AGENT_SESSION_DIR})+'\\n');\n`, { mode: 0o755 });
  const pinned = { source: "npm:pi-mcp-adapter@1.2.3", extensions: [] };
  writeJson(join(target, "settings.json"), { packages: [pinned] });
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "setup.mjs"), "--agent-dir", target, "--packages", "mcp,workflow"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PI_LOG: log,
      PI_CODING_AGENT_DIR: join(f.base, "wrong-agent"), PI_CODING_AGENT_SESSION_DIR: join(f.base, "wrong-sessions") },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.args), [
    ["install", "npm:pi-mcp-adapter@1.2.3", "--no-approve"],
    ["install", "git:git@github.com:gdezan/pi-workflow", "--no-approve"],
  ]);
  for (const call of calls) {
    assert.equal(call.cwd, target);
    assert.equal(call.agentDir, target);
    assert.equal(call.sessions, join(target, "sessions"));
  }
  assert.deepEqual(json(join(target, "settings.json")).packages[0], pinned);
  assert.equal(existsSync(join(f.base, "wrong-agent")), false);
});
