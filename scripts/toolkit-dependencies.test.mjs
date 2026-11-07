import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { toolkitPathHash } from "./toolkit-files.mjs";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
function checkout(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-wizard-dependencies-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "checkout");
  const bin = join(base, "bin");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(bin);
  cpSync(join(source, "setup.mjs"), join(root, "setup.mjs"));
  for (const name of ["toolkit-options.mjs", "toolkit-command.mjs", "toolkit-dependencies.mjs"])
    cpSync(join(source, "scripts", name), join(root, "scripts", name));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: { fixture: "1.0.0" } }),
  );
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ packages: [] }));
  writeFileSync(
    join(root, "scripts/toolkit-setup.mjs"),
    "export async function runToolkitSetup(){process.stdout.write(JSON.stringify({status:'applied'})+'\\n')}\n",
  );
  const log = join(base, "npm.log");
  const fakeNpm = join(bin, process.platform === "win32" ? "npm-fixture.cjs" : "npm");
  writeFileSync(
    fakeNpm,
    `#!${process.execPath}\n` +
      `const fs=require('node:fs');fs.appendFileSync(process.env.NPM_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n');\n` +
      `fs.mkdirSync('node_modules/fixture',{recursive:true});fs.writeFileSync('node_modules/fixture/package.json',JSON.stringify({version:'1.0.0'}));\n` +
      `console.log('fake dependency install');if(process.env.NPM_TEST_FAIL==='1')process.exitCode=3;\n`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    writeFileSync(join(bin, "npm.cmd"), `@"${process.execPath}" "${fakeNpm}" %*\r\n`);
  }
  const run = (args, extra = {}) =>
    spawnSync(process.execPath, [join(root, "setup.mjs"), "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        NPM_TEST_LOG: log,
        ...extra,
      },
    });
  return { root, log, run };
}

test("help/list stay dependency-free and a cold dry run never bootstraps", (t) => {
  const f = checkout(t);
  const before = toolkitPathHash(f.root);
  assert.equal(f.run(["--help"]).status, 0);
  assert.equal(f.run(["--list-packages"]).status, 0);
  const result = f.run(["--dry-run", "--skip-packages"]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /dependencies are missing/);
  assert.equal(result.stderr, "");
  assert.equal(toolkitPathHash(f.root), before);
  assert.equal(existsSync(f.log), false);
});

test("an interrupted dependency bootstrap is retried even when direct package metadata exists", (t) => {
  const f = checkout(t);
  const failed = f.run(["--skip-packages"], { NPM_TEST_FAIL: "1" });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, "error");
  assert.equal(existsSync(join(f.root, ".toolkit-dependencies.pending")), true);
  assert.equal(existsSync(join(f.root, ".toolkit-dependencies.lock")), false);
  const resumed = f.run(["--skip-packages"]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "applied");
  assert.match(resumed.stderr, /fake dependency install/);
  assert.equal(existsSync(join(f.root, ".toolkit-dependencies.pending")), false);
  const again = f.run(["--skip-packages"]);
  assert.equal(again.status, 0);
  assert.equal(again.stderr, "");
  const calls = readFileSync(f.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    "ci",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--include=dev",
    "--no-audit",
    "--no-fund",
  ]);
});

test("bootstrap respects an existing checkout lock without altering its marker", (t) => {
  const f = checkout(t);
  const lock = join(f.root, ".toolkit-dependencies.lock");
  writeFileSync(lock, "other process\n");
  const result = f.run(["--skip-packages"]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /dependencies are locked/);
  assert.equal(readFileSync(lock, "utf8"), "other process\n");
  assert.equal(existsSync(f.log), false);
});

test("a dead dependency-bootstrap lock is recovered", (t) => {
  const f = checkout(t);
  writeFileSync(join(f.root, ".toolkit-dependencies.lock"), "2147483647\n");
  const result = f.run(["--skip-packages"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(f.root, ".toolkit-dependencies.lock")), false);
  assert.equal(existsSync(join(f.root, ".toolkit-dependencies.pending")), false);
});
