import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runToolkitSetup } from "./toolkit-setup.mjs";
import { readToolkitJson, toolkitPackageIdentity } from "./toolkit-settings.mjs";
import { inspectToolkitInventory } from "./toolkit-inventory.mjs";
import { toolkitPathHash } from "./toolkit-files.mjs";

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
    pi: { extensions: ["./dotfiles/extensions/demo.ts", "./dotfiles/local-packages/local/index.ts"], skills: ["./dotfiles/skills"] } });
  put("manifest.json", { version: 1, resources: [
    { id: "demo", kind: "extensions", path: "dotfiles/extensions/demo.ts", legacy: ["extensions/demo.ts"] },
    { id: "local", kind: "extensions", path: "dotfiles/local-packages/local/index.ts", legacy: ["local-packages/local/index.ts"], packageName: "@local/local" },
    { id: "demo-skill", kind: "skills", path: "dotfiles/skills/demo/SKILL.md", legacy: ["skills/demo/SKILL.md"] },
  ], packages: [
    { id: "one", source: "npm:one", description: "One" },
    { id: "two", source: "git:git@github.com:owner/two", description: "Two" },
  ] });
  put("preferences.json", { theme: "dark", terminal: { showTerminalProgress: true } });
  put("dotfiles/APPEND_SYSTEM.md", "Shared instructions\n");
  put("dotfiles/extensions/demo.ts", "export default function demo() {}\n");
  put("dotfiles/skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo skill\n---\nDemo\n");
  put("dotfiles/local-packages/local/package.json", { name: "@local/local", pi: { extensions: ["./index.ts"] } });
  put("dotfiles/local-packages/local/index.ts", "export default function local() {}\n");
  const installed = [];
  const output = { isTTY: false, text: "", write(value) { this.text += value; } };
  const install = async (source, target) => {
    installed.push([source, target]);
    const identity = toolkitPackageIdentity(source, target);
    const name = identity.slice(identity.indexOf(":") + 1);
    const path = identity.startsWith("npm:") ? join(target, "npm/node_modules", name) : join(target, "git", name);
    writeJson(join(path, "package.json"), { name, version: source.endsWith("@1.2.3") ? "1.2.3" : "1.0.0" });
  };
  const run = (args = ["--skip-packages"], installPackage = install, extra = {}) =>
    runToolkitSetup({ root, argv: ["--agent-dir", agentDir, ...args], input: { isTTY: false }, output, installPackage, ...extra });
  return { base, root, agentDir, put, installed, output, run, install };
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
  assert.equal(lstatSync(join(f.agentDir, "toolkits/pi-agent-setup")).isSymbolicLink(), true);
  await f.run(["--copy", "--skip-packages"]);
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
  writeJson(join(f.agentDir, "npm/node_modules/one/package.json"), { name: "one", version: "1.2.3" });
  await f.run(["--packages", "one"]);
  assert.deepEqual(f.installed, []);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages.slice(0, 2), [pinned, "npm:other"]);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).selectedPackages, ["one"]);
  await f.run(["--skip-packages"]);
  await f.run(["--reuse-selection"]);
  assert.equal(f.installed.length, 0);
  await f.run(["--reuse-selection", "--update-packages"]);
  assert.deepEqual(f.installed, [["npm:one@1.2.3", f.agentDir]]);
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
  await assert.rejects(f.run(), /Toolkit decision required/);
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
  await assert.rejects(f.run(), /Toolkit decision required/);
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

test("differing legacy resources require a decision, and keeping them avoids duplicate loads", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(f.agentDir, "extensions/demo.ts"), "export default function legacyDemo() {}\n");
  writeJson(join(f.agentDir, "local-packages/local/package.json"), { name: "@local/local", pi: { extensions: ["./index.ts"] } });
  writeFileSync(join(f.agentDir, "local-packages/local/index.ts"), "export default function legacyLocal() {}\n");
  writeJson(join(f.agentDir, "settings.json"), { packages: ["local-packages/local"] });
  await assert.rejects(f.run(), /Toolkit decision required: Legacy demo differs/);
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.match(readFileSync(join(f.agentDir, "extensions/demo.ts"), "utf8"), /legacyDemo/);
  const settings = json(join(f.agentDir, "settings.json"));
  assert.deepEqual(settings.packages[1].extensions, ["-dotfiles/extensions/demo.ts", "-dotfiles/local-packages/local/index.ts"]);
  const inventory = await inspectToolkitInventory({ root: f.root, agentDir: f.agentDir, settings, manifest: json(join(f.root, "manifest.json")) });
  assert.equal(inventory.paths.extensions.filter((entry) => entry.enabled).length, 2);
  const hash = toolkitPathHash(f.agentDir);
  assert.equal((await f.run()).status, "unchanged");
  assert.equal(toolkitPathHash(f.agentDir), hash);
});

test("identical legacy extension, skill, and local package move to backup and activate the bundle", async (t) => {
  const f = fixture(t);
  const copies = [
    ["dotfiles/extensions/demo.ts", "extensions/demo.ts"],
    ["dotfiles/skills/demo/SKILL.md", "skills/demo/SKILL.md"],
    ["dotfiles/local-packages/local/index.ts", "local-packages/local/index.ts"],
    ["dotfiles/local-packages/local/package.json", "local-packages/local/package.json"],
  ];
  for (const [source, target] of copies) {
    const path = join(f.agentDir, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(f.root, source)));
  }
  writeJson(join(f.agentDir, "settings.json"), { packages: ["local-packages/local"] });
  const receipt = await f.run();
  assert.equal(receipt.actions.filter((entry) => entry.action === "migrate").length, 3);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages, ["toolkits/pi-agent-setup"]);
  for (const [, target] of copies) assert.equal(existsSync(join(f.agentDir, target)), false);
  const backup = readdirSync(join(f.agentDir, "toolkit-backups"))[0];
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "legacy/extensions/demo.ts"), "utf8"), readFileSync(join(f.root, "dotfiles/extensions/demo.ts"), "utf8"));
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "legacy/local-packages/local/index.ts"), "utf8"), readFileSync(join(f.root, "dotfiles/local-packages/local/index.ts"), "utf8"));
  assert.equal((await f.run()).status, "unchanged");
});

test("legacy directory extensions move with their helper files rather than only index.ts", async (t) => {
  const f = fixture(t);
  const manifest = json(join(f.root, "manifest.json"));
  manifest.resources[0].path = "dotfiles/extensions/demo/index.ts";
  manifest.resources[0].legacy = ["extensions/demo/index.ts"];
  f.put("manifest.json", manifest);
  const pkg = json(join(f.root, "package.json"));
  pkg.pi.extensions[0] = "./dotfiles/extensions/demo/index.ts";
  f.put("package.json", pkg);
  mkdirSync(join(f.root, "dotfiles/extensions/demo"));
  f.put("dotfiles/extensions/demo/index.ts", "import './helper.js';\n");
  f.put("dotfiles/extensions/demo/helper.js", "export const helper = true;\n");
  const old = join(f.agentDir, "extensions/demo");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "index.ts"), "import './helper.js';\n");
  writeFileSync(join(old, "helper.js"), "export const helper = true;\n");
  await f.run();
  assert.equal(existsSync(old), false);
  const backup = readdirSync(join(f.agentDir, "toolkit-backups"))[0];
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "legacy/extensions/demo/helper.js"), "utf8"), "export const helper = true;\n");
});

test("differing legacy copy is preserved until explicit migration and then archived", async (t) => {
  const f = fixture(t);
  const old = join(f.agentDir, "extensions/demo.ts");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, "local custom extension\n");
  await assert.rejects(f.run(), /Toolkit decision required/);
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.equal(readFileSync(old, "utf8"), "local custom extension\n");
  await f.run(["--skip-packages", "--replace-legacy"]);
  assert.equal(existsSync(old), false);
  const backup = readdirSync(join(f.agentDir, "toolkit-backups")).at(-1);
  assert.equal(readFileSync(join(f.agentDir, "toolkit-backups", backup, "legacy/extensions/demo.ts"), "utf8"), "local custom extension\n");
  assert.equal(json(join(f.agentDir, "settings.json")).packages[0].source, "toolkits/pi-agent-setup");
});

test("a rerun removes a stale local-package registration after an interrupted legacy move", async (t) => {
  const f = fixture(t);
  await f.run();
  const statePath = join(f.agentDir, "toolkit-state.json");
  writeJson(statePath, { ...json(statePath), pendingLegacy: ["local-packages/local/index.ts"] });
  writeJson(join(f.agentDir, "settings.json"), { packages: ["local-packages/local", "toolkits/pi-agent-setup"] });
  await f.run();
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages, ["toolkits/pi-agent-setup"]);
  assert.deepEqual(json(statePath).pendingLegacy, []);
});

test("interactive cleanup deletes only checked items without keeping a delete choice", async (t) => {
  const f = fixture(t);
  await f.run();
  const extra = join(f.agentDir, "extensions/extra.ts");
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, "export default function extra() {}\n");
  const other = join(f.agentDir, "skills/other/SKILL.md");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "---\nname: other\ndescription: Other\n---\nOther\n");
  writeJson(join(f.agentDir, "settings.json"), { packages: ["toolkits/pi-agent-setup", "npm:old", "npm:leave"] });
  const removed = [];
  const removePackage = async (source) => {
    removed.push(source);
    const settings = json(join(f.agentDir, "settings.json"));
    settings.packages = settings.packages.filter((entry) => entry !== source);
    writeJson(join(f.agentDir, "settings.json"), settings);
  };
  const uiFactory = async () => ({ interactive: true, start() {}, plan() {}, finish() {},
    async cleanup(candidates) {
      assert.deepEqual(candidates.map((entry) => entry.id), ["package:npm:old", "package:npm:leave",
        "resource:extensions/extra.ts", "resource:skills/other"]);
      return candidates.filter((entry) => ["package:npm:old", "resource:extensions/extra.ts"].includes(entry.id));
    },
    async confirm() { return "apply"; }, async task(_title, fn) { return fn(); } });
  await f.run(["--skip-packages"], f.install, { uiFactory, removePackage });
  assert.deepEqual(removed, ["npm:old"]);
  assert.equal(existsSync(extra), false);
  assert.equal(existsSync(other), true);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages, ["toolkits/pi-agent-setup", "npm:leave"]);
  assert.equal((await f.run(["--skip-packages"])).status, "unchanged");
  assert.equal(existsSync(other), true);
});

test("deleting a configured local extension package removes its registration too", async (t) => {
  const f = fixture(t);
  await f.run();
  const path = join(f.agentDir, "extensions/custom");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "index.ts"), "export default function custom() {}\n");
  writeJson(join(f.agentDir, "settings.json"), { packages: ["toolkits/pi-agent-setup", "extensions/custom"] });
  const uiFactory = async () => ({ interactive: true, start() {}, plan() {}, finish() {},
    async cleanup(candidates) { return candidates.filter((entry) => entry.id === "package:extensions/custom"); },
    async confirm() { return "apply"; }, async task(_title, fn) { return fn(); } });
  const removePackage = async (source) => {
    assert.equal(source, "extensions/custom");
    writeJson(join(f.agentDir, "settings.json"), { packages: ["toolkits/pi-agent-setup"] });
  };
  await f.run(["--skip-packages"], f.install, { uiFactory, removePackage });
  assert.equal(existsSync(path), false);
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages, ["toolkits/pi-agent-setup"]);
});

test("noninteractive setup never deletes unrelated resources", async (t) => {
  const f = fixture(t);
  const extra = join(f.agentDir, "extensions/extra.ts");
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, "export default function extra() {}\n");
  await f.run(["--skip-packages", "--yes"]);
  assert.equal(existsSync(extra), true);
});

test("pre-existing duplicate load paths fail verification instead of being reported as ready", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  const source = readFileSync(join(f.root, "dotfiles/extensions/demo.ts"));
  writeFileSync(join(f.agentDir, "extensions/demo.ts"), source);
  writeFileSync(join(f.agentDir, "extensions/second-demo.ts"), source);
  await assert.rejects(f.run(["--skip-packages", "--conflicts", "keep"]), /multiple enabled load paths/);
  assert.equal(readFileSync(join(f.agentDir, "extensions/second-demo.ts"), "utf8"), source.toString());
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
    `fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),agentDir:process.env.PI_CODING_AGENT_DIR,sessions:process.env.PI_CODING_AGENT_SESSION_DIR})+'\\n');\n` +
    `const path=require('node:path'); const source=process.argv[2]==='update'?process.argv[4]:process.argv[3]; const name=source.replace(/^npm:/,'').replace(/@[^@/]+$/,''); const dest=source.startsWith('npm:')?path.join(process.cwd(),'npm/node_modules',name):path.join(process.cwd(),'git/github.com/gdezan/pi-workflow'); fs.mkdirSync(dest,{recursive:true}); fs.writeFileSync(path.join(dest,'package.json'),JSON.stringify({name:source,version:'1.2.3'}));\n`, { mode: 0o755 });
  const pinned = { source: "npm:pi-web-search@1.2.3", extensions: [] };
  writeJson(join(target, "settings.json"), { packages: [pinned] });
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "setup.mjs"), "--agent-dir", target, "--packages", "web-search,workflow", "--repair"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PI_LOG: log,
      PI_CODING_AGENT_DIR: join(f.base, "wrong-agent"), PI_CODING_AGENT_SESSION_DIR: join(f.base, "wrong-sessions") },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.args), [
    ["install", "git:git@github.com:gdezan/pi-workflow", "--no-approve"],
    ["install", "npm:pi-web-search@1.2.3", "--no-approve"],
  ]);
  for (const call of calls) {
    assert.equal(call.cwd, target);
    assert.equal(call.agentDir, target);
    assert.equal(call.sessions, join(target, "sessions"));
  }
  assert.deepEqual(json(join(target, "settings.json")).packages[0], pinned);
  assert.equal(existsSync(join(f.base, "wrong-agent")), false);
  const updated = spawnSync(process.execPath, [join(REPO_ROOT, "setup.mjs"), "--agent-dir", target, "--packages", "web-search", "--update-packages", "--json"], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_PI_LOG: log },
  });
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  const updatedCalls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(updatedCalls.length, 3);
  assert.deepEqual(updatedCalls[2].args, ["update", "--extension", "npm:pi-web-search@1.2.3", "--no-approve"]);
});

test("an unchanged rerun neither rewrites files nor reinstalls selected packages", async (t) => {
  const f = fixture(t);
  await f.run(["--all-packages"]);
  const paths = ["settings.json", "toolkit-state.json", "APPEND_SYSTEM.md", "toolkits/pi-agent-setup/package.json"];
  const metadata = () => paths.map((path) => {
    const stat = lstatSync(join(f.agentDir, path));
    return [stat.ino, stat.mtimeMs];
  });
  const before = metadata();
  const hash = toolkitPathHash(f.agentDir);
  f.installed.length = 0;
  assert.equal((await f.run([])).status, "unchanged");
  assert.deepEqual(f.installed, []);
  assert.deepEqual(metadata(), before);
  assert.equal(toolkitPathHash(f.agentDir), hash);
});

test("kept local instructions are remembered without adopting their contents", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "My local instructions\n");
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.equal(json(join(f.agentDir, "toolkit-state.json")).appendSystemHash, null);
  assert.equal((await f.run()).status, "unchanged");
  f.put("dotfiles/APPEND_SYSTEM.md", "A changed shared version\n");
  await assert.rejects(f.run(), /Toolkit decision required/);
  assert.equal(readFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "utf8"), "My local instructions\n");
});

test("local edits in copied resources stay protected across repeated source updates", async (t) => {
  const f = fixture(t);
  await f.run();
  const path = join(f.agentDir, "toolkits/pi-agent-setup/dotfiles/extensions/demo.ts");
  writeFileSync(path, "local edit\n");
  await assert.rejects(f.run(), /Toolkit decision required/);
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.equal((await f.run()).status, "unchanged");
  f.put("dotfiles/extensions/demo.ts", "updated shared resource\n");
  await assert.rejects(f.run(), /Toolkit decision required/);
  assert.equal(readFileSync(path, "utf8"), "local edit\n");
  await f.run(["--skip-packages", "--replace-resources"]);
  assert.equal(readFileSync(path, "utf8"), "updated shared resource\n");
});

test("v1 ownership records upgrade safely and do not infer a missing baseline", async (t) => {
  const f = fixture(t);
  await f.run();
  const statePath = join(f.agentDir, "toolkit-state.json");
  const old = { version: 1, ownsPackage: true, appendSystemHash: json(statePath).appendSystemHash, selectedPackages: [] };
  writeJson(statePath, old);
  await f.run();
  assert.equal(json(statePath).version, 2);
  assert.equal((await f.run()).status, "unchanged");
  writeJson(statePath, old);
  f.put("dotfiles/extensions/demo.ts", "a new source version\n");
  await assert.rejects(f.run(), /Toolkit decision required/);
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.equal(json(statePath).packageHash, null);
  assert.equal((await f.run()).status, "unchanged");
});

test("unmanaged package destinations can be kept without activating or owning them", async (t) => {
  const f = fixture(t);
  const path = join(f.agentDir, "toolkits/pi-agent-setup");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "unrelated.txt"), "local file");
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  assert.equal(json(join(f.agentDir, "settings.json")).packages, undefined);
  assert.equal(json(join(f.agentDir, "toolkit-state.json")).ownsPackage, false);
  assert.equal((await f.run()).status, "unchanged");
  assert.equal(readFileSync(join(path, "unrelated.txt"), "utf8"), "local file");
});

test("legacy resource exclusions are removed when the old copy goes away, without removing user filters", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  const legacy = join(f.agentDir, "extensions/demo.ts");
  writeFileSync(legacy, "export default function legacy() {}\n");
  const userFilter = "-dotfiles/local-packages/local/index.ts";
  writeJson(join(f.agentDir, "settings.json"), { packages: [{ source: "toolkits/pi-agent-setup", extensions: [userFilter] }] });
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  rmSync(legacy);
  await f.run();
  assert.deepEqual(json(join(f.agentDir, "settings.json")).packages[0].extensions, [userFilter]);
});

test("disabled local resources and disabled package types stay disabled", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(f.agentDir, "extensions/demo.ts"), "export default function disabled() {}\n");
  writeJson(join(f.agentDir, "settings.json"), { extensions: ["-extensions/demo.ts"],
    packages: [{ source: "toolkits/pi-agent-setup", extensions: [] }] });
  await f.run();
  const settings = json(join(f.agentDir, "settings.json"));
  assert.deepEqual(settings.packages[0].extensions, []);
  const inventory = await inspectToolkitInventory({ root: f.root, agentDir: f.agentDir, settings, manifest: json(join(f.root, "manifest.json")) });
  assert.equal(inventory.paths.extensions.filter((entry) => entry.enabled).length, 0);
  assert.equal((await f.run()).status, "unchanged");
});

test("loose skills and explicit relocated extensions suppress only their bundled counterparts", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, "skills/demo"), { recursive: true });
  writeFileSync(join(f.agentDir, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Local\n---\nLocal skill\n");
  const relocated = join(f.base, "elsewhere.ts");
  writeFileSync(relocated, readFileSync(join(f.root, "dotfiles/extensions/demo.ts")));
  writeJson(join(f.agentDir, "settings.json"), { extensions: [relocated] });
  await assert.rejects(f.run(), /Toolkit decision required/);
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  const settings = json(join(f.agentDir, "settings.json"));
  assert.deepEqual(settings.packages[0].extensions, ["-dotfiles/extensions/demo.ts"]);
  assert.deepEqual(settings.packages[0].skills, ["-dotfiles/skills/demo/SKILL.md"]);
});

test("repair needs an explicit decision and a successful retry does not repeat completed installs", async (t) => {
  const f = fixture(t);
  writeJson(join(f.agentDir, "settings.json"), { packages: ["npm:one@1.2.3"] });
  await assert.rejects(f.run(["--packages", "one", "--yes"]), /Toolkit decision required/);
  await f.run(["--packages", "one", "--repair"]);
  f.installed.length = 0;
  await assert.rejects(f.run(["--all-packages"], async (source, target) => {
    await f.install(source, target);
    throw new Error("failed after writing package metadata");
  }), /failed after writing/);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).pendingPackages, ["two"]);
  f.installed.length = 0;
  await f.run(["--reuse-selection"]);
  assert.deepEqual(f.installed.map(([source]) => source), ["git:git@github.com:owner/two"]);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).pendingPackages, []);
  assert.equal((await f.run()).status, "unchanged");
});

test("zero-exit package commands that did not install anything remain retryable failures", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(["--packages", "one"], async () => {}), /Toolkit package verification failed/);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).pendingPackages, ["one"]);
  await f.run(["--reuse-selection"]);
  assert.equal((await f.run()).status, "unchanged");
});

test("source changes during confirmation invalidate the plan before deployment", async (t) => {
  const f = fixture(t);
  const uiFactory = async () => ({ interactive: true, start() {}, plan() {},
    async confirm() { f.put("dotfiles/extensions/demo.ts", "changed during menu\n"); return "apply"; } });
  await assert.rejects(f.run(["--skip-packages"], f.install, { uiFactory }), /Toolkit inputs changed/);
  assert.equal(existsSync(join(f.agentDir, "settings.json")), false);
  assert.equal(existsSync(join(f.agentDir, "toolkit-setup.lock")), false);
});

test("changes to a legacy directory helper during confirmation cancel automatic migration", async (t) => {
  const f = fixture(t);
  const old = join(f.agentDir, "skills/demo");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "SKILL.md"), readFileSync(join(f.root, "dotfiles/skills/demo/SKILL.md")));
  f.put("dotfiles/skills/demo/asset.txt", "original\n");
  writeFileSync(join(old, "asset.txt"), "original\n");
  const uiFactory = async () => ({ interactive: true, start() {}, plan() {},
    async confirm() { writeFileSync(join(old, "asset.txt"), "changed during menu\n"); return "apply"; } });
  await assert.rejects(f.run(["--skip-packages"], f.install, { uiFactory }), /Toolkit inputs changed/);
  assert.equal(readFileSync(join(old, "asset.txt"), "utf8"), "changed during menu\n");
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
});

test("interrupted migration keeps ownership of old exclusions until settings update", async (t) => {
  const f = fixture(t);
  const old = join(f.agentDir, "extensions/demo.ts");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, "local version\n");
  await f.run(["--skip-packages", "--conflicts", "keep"]);
  const statePath = join(f.agentDir, "toolkit-state.json");
  const settingsPath = join(f.agentDir, "settings.json");
  const before = json(statePath);
  assert.deepEqual(before.resourceExclusions.extensions, ["-dotfiles/extensions/demo.ts"]);
  rmSync(old);
  writeJson(statePath, { ...before, pendingLegacy: ["extensions/demo.ts"] });
  await f.run();
  const toolkit = json(settingsPath).packages.find((entry) => (entry.source ?? entry) === "toolkits/pi-agent-setup");
  assert.equal(typeof toolkit === "string" || !toolkit.extensions?.includes("-dotfiles/extensions/demo.ts"), true);
});

test("another setup lock is preserved and prevents changes", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  const lock = join(f.agentDir, "toolkit-setup.lock");
  writeFileSync(lock, "another setup\n");
  await assert.rejects(f.run(), /Toolkit setup is locked/);
  assert.equal(readFileSync(lock, "utf8"), "another setup\n");
  assert.equal(existsSync(join(f.agentDir, "toolkits")), false);
});

test("a lock from a dead setup process is recovered", async (t) => {
  const f = fixture(t);
  mkdirSync(f.agentDir);
  const lock = join(f.agentDir, "toolkit-setup.lock");
  writeFileSync(lock, "2147483647\n");
  const result = await f.run(["--skip-packages"]);
  assert.equal(result.status, "applied");
  assert.equal(existsSync(lock), false);
});

test("JSON mode returns one clean receipt for plans and actionable errors", (t) => {
  const f = fixture(t);
  const cli = (args) => spawnSync(process.execPath, [join(REPO_ROOT, "setup.mjs"), "--agent-dir", f.agentDir, "--json", ...args], { encoding: "utf8" });
  const planned = cli(["--dry-run", "--skip-packages"]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).status, "planned");
  const missing = cli(["--yes"]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).status, "error");
  assert.match(JSON.parse(missing.stdout).message, /--packages/);
  assert.equal(existsSync(f.agentDir), false);
});

test("offline inventory still detects an installed version that does not satisfy its pin", async (t) => {
  const f = fixture(t);
  const previous = process.env.PI_OFFLINE;
  t.after(() => { if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous; });
  process.env.PI_OFFLINE = "1";
  writeJson(join(f.agentDir, "settings.json"), { packages: ["npm:one@1.2.3"] });
  writeJson(join(f.agentDir, "npm/node_modules/one/package.json"), { name: "one", version: "0.1.0" });
  await assert.rejects(f.run(["--packages", "one"]), /Toolkit decision required/);
  await f.run(["--packages", "one", "--repair"]);
  assert.equal((await f.run()).status, "unchanged");
});

test("kept missing packages produce a warning rather than claiming everything is ready", async (t) => {
  const f = fixture(t);
  writeJson(join(f.agentDir, "settings.json"), { packages: ["npm:one"] });
  await f.run(["--packages", "one", "--conflicts", "keep"]);
  const receipt = await f.run([]);
  assert.equal(receipt.status, "unchanged");
  assert.match(receipt.warnings.join("\n"), /one still needs repair/);
  assert.doesNotMatch(receipt.message, /Everything is already set up/);
  assert.equal(receipt.next, undefined);
});

test("removed catalog choices stop being selected without uninstalling their packages", async (t) => {
  const f = fixture(t);
  await f.run(["--all-packages"]);
  const manifest = json(join(f.root, "manifest.json"));
  manifest.packages = manifest.packages.filter((entry) => entry.id !== "two");
  f.put("manifest.json", manifest);
  f.installed.length = 0;
  await f.run(["--reuse-selection"]);
  assert.deepEqual(json(join(f.agentDir, "toolkit-state.json")).selectedPackages, ["one"]);
  assert.ok(json(join(f.agentDir, "settings.json")).packages.includes("git:git@github.com:owner/two"));
  assert.deepEqual(f.installed, []);
});

test("unknown duplicate contents discovered after a download require a decision on rerun, not another download", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(["--packages", "one"], async (source, target) => {
    await f.install(source, target);
    const path = join(target, "npm/node_modules/one");
    writeJson(join(path, "package.json"), { name: "one", version: "1.0.0", pi: { extensions: ["./index.ts"] } });
    writeFileSync(join(path, "index.ts"), readFileSync(join(f.root, "dotfiles/extensions/demo.ts")));
  }), /New package resources need a decision/);
  f.installed.length = 0;
  await f.run(["--reuse-selection", "--conflicts", "keep"]);
  assert.deepEqual(f.installed, []);
  assert.equal((await f.run()).status, "unchanged");
});
