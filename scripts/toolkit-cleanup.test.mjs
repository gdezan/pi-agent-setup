import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertToolkitCleanupPath, isKeptToolkitPath, listToolkitCleanupCandidates, readToolkitKeep } from "./toolkit-cleanup.mjs";

test("cleanup lists only unselected packages and unrelated Pi resources", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cleanup-test-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  for (const path of ["extensions/extra.ts", "extensions/custom/index.ts", "extensions/known.ts", "skills/extra/SKILL.md",
    "local-packages/extra/package.json", "local-packages/known/index.ts", "auth.json"]) {
    const full = join(agentDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "test");
  }
  const manifest = { packages: [{ id: "selected", source: "npm:selected" }, { id: "unselected", source: "npm:unselected" }],
    resources: [{ legacy: ["extensions/known.ts"] }, { legacy: ["local-packages/known/index.ts"] }] };
  const settings = { packages: ["toolkits/pi-agent-setup", "npm:selected", "npm:unselected", "npm:unknown", "local-packages/extra", "extensions/custom"] };
  const { candidates, kept } = listToolkitCleanupCandidates({ agentDir, settings, manifest, selectedIds: ["selected"] });
  assert.deepEqual(candidates.map((entry) => entry.id), ["package:npm:unselected", "package:npm:unknown",
    "package:local-packages/extra", "package:extensions/custom", "resource:extensions/extra.ts", "resource:skills/extra"]);
  assert.deepEqual(kept, []);
});

test("cleanup never offers a configured package behind a symlinked resource parent", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cleanup-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-cleanup-outside-"));
  t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(outside, "custom"));
  symlinkSync(outside, join(agentDir, "extensions"), "dir");
  const path = join(agentDir, "extensions/custom");
  const { candidates } = listToolkitCleanupCandidates({ agentDir, settings: { packages: ["extensions/custom"] },
    manifest: { packages: [], resources: [] }, selectedIds: [] });
  assert.deepEqual(candidates, []);
  assert.throws(() => assertToolkitCleanupPath(agentDir, path), /Unsafe toolkit cleanup path/);
});

test("the keep list suppresses hand-maintained resources and reports what it honoured", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-test-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  for (const path of ["extensions/herdr-agent-state.ts", "extensions/machine-prompt.ts", "extensions/scratch.ts",
    "skills/mine/SKILL.md", "local-packages/mine/index.ts"]) {
    const full = join(agentDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "test");
  }
  writeFileSync(join(agentDir, "toolkit-keep.json"),
    JSON.stringify({ keep: ["extensions/herdr-agent-state.ts", "extensions/machine-prompt.ts"] }));
  const keep = readToolkitKeep(agentDir);
  const { candidates, kept } = listToolkitCleanupCandidates({ agentDir, settings: { packages: [] },
    manifest: { packages: [], resources: [] }, selectedIds: [], keep });
  assert.deepEqual(kept, ["extensions/herdr-agent-state.ts", "extensions/machine-prompt.ts"]);
  assert.deepEqual(candidates.map((entry) => entry.id), ["resource:extensions/scratch.ts", "resource:skills/mine"]);
});

test("a keep entry naming a directory keeps everything beneath it", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-dir-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  for (const path of ["extensions/local/a.ts", "extensions/local/b.ts", "extensions/other.ts"]) {
    const full = join(agentDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "test");
  }
  const { candidates, kept } = listToolkitCleanupCandidates({ agentDir, settings: { packages: [] },
    manifest: { packages: [], resources: [] }, selectedIds: [], keep: ["extensions/local"] });
  // The directory is kept whole, so it is reported as the directory rather than
  // as the files inside it, and the lister never descends into it.
  assert.deepEqual(kept, ["extensions/local"]);
  assert.deepEqual(candidates.map((entry) => entry.id), ["resource:extensions/other.ts"]);
});

test("a keep entry cannot escape the agent directory or a sibling with a shared prefix", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-escape-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const full = join(agentDir, "extensions/other.ts");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "test");
  writeFileSync(join(agentDir, "toolkit-keep.json"), JSON.stringify({ keep: ["../elsewhere", "/absolute", "extensions/o"] }));
  assert.throws(() => readToolkitKeep(agentDir), /Invalid toolkit keep list/);
  assert.equal(isKeptToolkitPath("extensions/other.ts", ["extensions/o"]), false);
  assert.equal(isKeptToolkitPath("extensions/other.ts", ["extensions/other.ts"]), true);
});

test("an absent or empty keep list preserves the old candidate list", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-absent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const full = join(agentDir, "extensions/mine.ts");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "test");
  const args = { agentDir, settings: { packages: [] }, manifest: { packages: [], resources: [] }, selectedIds: [] };
  assert.deepEqual(readToolkitKeep(agentDir), []);
  assert.deepEqual(listToolkitCleanupCandidates(args).candidates.map((entry) => entry.id), ["resource:extensions/mine.ts"]);
  writeFileSync(join(agentDir, "toolkit-keep.json"), JSON.stringify({ keep: [] }));
  assert.deepEqual(listToolkitCleanupCandidates({ ...args, keep: readToolkitKeep(agentDir) }).kept, []);
});

test("the keep list also covers a local package registered in settings", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-pkg-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const full = join(agentDir, "extensions/custom");
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, "index.ts"), "export default function custom() {}\n");
  const { candidates, kept } = listToolkitCleanupCandidates({ agentDir, settings: { packages: ["extensions/custom"] },
    manifest: { packages: [], resources: [] }, selectedIds: [], keep: ["extensions/custom"] });
  assert.deepEqual(candidates, []);
  assert.deepEqual(kept, ["extensions/custom"]);
});
