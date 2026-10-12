import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const legacy of [false, true]) {
  test(`native Pi loads toolkit extensions and skills with ${legacy ? "migrated legacy" : "fresh copied"} resources`, (t) => {
    const base = mkdtempSync(join(tmpdir(), "pi-wizard-native-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const agentDir = join(base, "agent");
    const home = join(base, "home");
    mkdirSync(home);
    mkdirSync(agentDir);
    if (legacy) {
      for (const kind of ["extensions", "skills", "local-packages"]) cpSync(join(root, "dotfiles", kind), join(agentDir, kind), { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "keep-local-model", theme: "light",
        packages: ["local-packages/ask-user-question",
          { source: "toolkits/pi-agent-setup", extensions: ["+dotfiles/extensions/model-tiers.ts"] }] }));
    }
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    const setup = spawnSync(process.execPath, [join(root, "setup.mjs"), "--skip-packages", "--conflicts", "keep", "--json"], { env, encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const sdk = pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {DefaultResourceLoader} from ${JSON.stringify(sdk)};
      const loader = new DefaultResourceLoader({cwd:${JSON.stringify(join(base, "project"))}, agentDir:process.env.PI_CODING_AGENT_DIR, noContextFiles:true});
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.deepEqual(loader.getSkills().diagnostics, []);
      assert.equal(loader.getExtensions().extensions.length, 6);
      for (const name of ['impeccable', 'analyze-sessions']) {
        assert.equal(loader.getSkills().skills.filter((skill) => skill.name === name).length, 1);
      }
    `], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (legacy) {
      assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultModel, "keep-local-model");
      assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).packages.some((entry) =>
        String(typeof entry === "string" ? entry : entry.source).startsWith("local-packages/")), false);
    }
    const rerun = spawnSync(process.execPath, [join(root, "setup.mjs"), "--skip-packages", "--json"], { env, encoding: "utf8" });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).status, "unchanged");
  });
}
