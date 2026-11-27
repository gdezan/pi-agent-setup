import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("native Pi loads the questionnaire as a standalone local package", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-question-standalone-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentDir = join(base, "agent");
  mkdirSync(agentDir);
  const packagePath = join(root, "extensions/pi-ask-user-question");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packagePath] }));
  const sdk = pathToFileURL(
    join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { DefaultResourceLoader } from ${JSON.stringify(sdk)};
    const loader = new DefaultResourceLoader({cwd:${JSON.stringify(join(base, "project"))}, agentDir:${JSON.stringify(agentDir)}, noContextFiles:true});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getExtensions().extensions.map((extension) => extension.resolvedPath), [${JSON.stringify(join(packagePath, "index.ts"))}]);
  `,
    ],
    {
      env: { ...process.env, HOME: base, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const legacy of [false, true]) {
  test(`native Pi loads toolkit extensions with ${legacy ? "migrated legacy" : "fresh copied"} resources`, (t) => {
    const base = mkdtempSync(join(tmpdir(), "pi-wizard-native-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const agentDir = join(base, "agent");
    const home = join(base, "home");
    mkdirSync(home);
    mkdirSync(agentDir);
    mkdirSync(join(base, ".git"));
    if (legacy) {
      mkdirSync(join(agentDir, "extensions"));
      cpSync(join(root, "extensions/pi-footer"), join(agentDir, "extensions/pi-footer"), {
        recursive: true,
      });
      cpSync(
        join(root, "extensions/pi-ask-user-question"),
        join(agentDir, "local-packages/ask-user-question"),
        { recursive: true },
      );
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultModel: "keep-local-model",
          theme: "light",
          packages: [
            "local-packages/ask-user-question",
            {
              source: "toolkits/pi-agent-setup",
              extensions: ["+dotfiles/extensions/favorites-cycle.ts"],
            },
          ],
        }),
      );
    }
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    };
    const setup = spawnSync(
      process.execPath,
      [join(root, "setup.mjs"), "--skip-packages", "--conflicts", "keep", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const sdk = pathToFileURL(
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import {sep} from 'node:path';
      import {DefaultResourceLoader} from ${JSON.stringify(sdk)};
      const loader = new DefaultResourceLoader({cwd:${JSON.stringify(join(base, "project"))}, agentDir:process.env.PI_CODING_AGENT_DIR, noContextFiles:true});
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.deepEqual(loader.getSkills().diagnostics, []);
      assert.equal(loader.getExtensions().extensions.some((extension) =>
        extension.resolvedPath.split(sep).join('/').includes('/utility-model/')), false, 'utility model helpers are not a separate extension');
      assert.equal(loader.getExtensions().extensions.length, 7);
      for (const suffix of ['pi-footer/index.ts', 'pi-favorites-cycle/index.ts',
        'pi-provider-usage/index.ts', 'pi-session-autoname/index.ts',
        'pi-cache-observer/index.ts', 'pi-ask-user-question/index.ts',
        'pi-next-prompt/index.ts']) {
        assert.equal(loader.getExtensions().extensions.filter((extension) =>
          extension.resolvedPath.split(sep).join('/').endsWith('/' + suffix)).length, 1, suffix);
      }
      assert.deepEqual(loader.getSkills().skills, []);
    `,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (legacy) {
      const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      assert.equal(savedSettings.defaultModel, "keep-local-model");
      assert.equal(
        savedSettings.packages.some((entry) =>
          String(typeof entry === "string" ? entry : entry.source).startsWith("local-packages/"),
        ),
        false,
      );
      assert.equal(
        savedSettings.packages.some(
          (entry) => (typeof entry === "string" ? entry : entry.source) === "pi-gd",
        ),
        true,
      );
      assert.equal(
        savedSettings.packages.some(
          (entry) =>
            (typeof entry === "string" ? entry : entry.source) === "toolkits/pi-agent-setup",
        ),
        false,
      );
    }
    const rerun = spawnSync(
      process.execPath,
      [join(root, "setup.mjs"), "--skip-packages", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).status, "unchanged");
  });
}
