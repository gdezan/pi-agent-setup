import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeToolkitPreferences, registerToolkitPackage, toolkitPackageIdentity,
  findToolkitPackage, validateToolkitManifest,
} from "./toolkit-settings.mjs";

test("preference seeding preserves local models, state, and nested preferences", () => {
  const settings = {
    defaultModel: "local-model", defaultProvider: "local-provider", lastChangelogVersion: "future",
    theme: "light", terminal: { showTerminalProgress: false, showImages: false },
    compaction: { reserveTokens: 123 }, customExtension: { token: "local-only" },
  };
  const result = mergeToolkitPreferences(settings, {
    theme: "dark", terminal: { showTerminalProgress: true }, compaction: { enabled: true },
  });
  assert.deepEqual(result, { ...settings, compaction: { reserveTokens: 123, enabled: true } });
  assert.deepEqual(settings.compaction, { reserveTokens: 123 });
});

test("explicit preference application changes only shared keys", () => {
  const settings = { defaultModel: "local", theme: "light", terminal: { showImages: false, showTerminalProgress: false } };
  assert.deepEqual(mergeToolkitPreferences(settings, { theme: "dark", terminal: { showTerminalProgress: true } }, true), {
    ...settings, theme: "dark", terminal: { showImages: false, showTerminalProgress: true },
  });
  for (const key of ["defaultModel", "defaultProvider", "packages", "lastChangelogVersion", "auth", "externalEditor"]) {
    assert.throws(() => mergeToolkitPreferences({}, { [key]: "wrong" }, true), /Unmanaged toolkit preference/);
  }
});

test("package registration preserves extra packages, pins, and object-form filters", () => {
  const entry = { source: "/tmp/agent/toolkits/pi-agent-setup", extensions: [] };
  const settings = { packages: ["npm:extra@3.1", entry] };
  assert.deepEqual(registerToolkitPackage(settings, "toolkits/pi-agent-setup", "/tmp/agent"), settings);
  assert.deepEqual(registerToolkitPackage({ packages: ["npm:extra"] }, "toolkits/pi-agent-setup", "/tmp/agent").packages,
    ["npm:extra", "toolkits/pi-agent-setup"]);
});

test("package identity matches pinned npm and alternate Git spellings", () => {
  assert.equal(toolkitPackageIdentity("npm:@scope/pkg@1.2.3", "/tmp"), "npm:@scope/pkg");
  assert.equal(toolkitPackageIdentity("npm:pkg@1", "/tmp"), "npm:pkg");
  const gitSources = [
    "git:git@github.com:gdezan/pi-workflow@v1",
    "git:github.com/gdezan/pi-workflow.git@v2",
    "ssh://git@github.com/gdezan/pi-workflow@release/branch",
    "https://github.com/gdezan/pi-workflow.git",
  ];
  for (const source of gitSources) assert.equal(toolkitPackageIdentity(source, "/tmp"), "git:github.com/gdezan/pi-workflow");
  const entry = { source: "npm:@scope/pkg@1.2.3", extensions: [] };
  assert.equal(findToolkitPackage([entry], "npm:@scope/pkg", "/tmp"), entry);
});

test("invalid and duplicate manifests fail before installation", () => {
  const entry = { id: "one", source: "npm:one", description: "One" };
  assert.throws(() => validateToolkitManifest({ packages: [] }), /Invalid toolkit manifest/);
  assert.throws(() => validateToolkitManifest({ version: 1, packages: [entry, entry] }), /Duplicate toolkit package/);
  assert.throws(() => validateToolkitManifest({ version: 1, packages: [{ ...entry, source: "npm:one; echo bad" }] }), /Invalid toolkit package/);
  assert.throws(() => registerToolkitPackage({ packages: false }, "toolkits/pi-agent-setup", "/tmp"), /Invalid Pi packages setting/);
});
