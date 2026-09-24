import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertToolkitCleanupPath, listToolkitCleanupCandidates } from "./toolkit-cleanup.mjs";

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
  const candidates = listToolkitCleanupCandidates({ agentDir, settings, manifest, selectedIds: ["selected"] });
  assert.deepEqual(candidates.map((entry) => entry.id), ["package:npm:unselected", "package:npm:unknown",
    "package:local-packages/extra", "package:extensions/custom", "resource:extensions/extra.ts", "resource:skills/extra"]);
});

test("cleanup never offers a configured package behind a symlinked resource parent", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cleanup-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-cleanup-outside-"));
  t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(outside, "custom"));
  symlinkSync(outside, join(agentDir, "extensions"), "dir");
  const path = join(agentDir, "extensions/custom");
  const candidates = listToolkitCleanupCandidates({ agentDir, settings: { packages: ["extensions/custom"] },
    manifest: { packages: [], resources: [] }, selectedIds: [] });
  assert.deepEqual(candidates, []);
  assert.throws(() => assertToolkitCleanupPath(agentDir, path), /Unsafe toolkit cleanup path/);
});
