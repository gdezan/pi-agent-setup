import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  collectToolkitFiles, resolveToolkitAgentDir, assertToolkitWritePaths, toolkitPathStat,
  toolkitContentHash, toolkitLinkMatches, deployToolkitPackage, replaceToolkitPath, writeToolkitJson,
} from "./toolkit-files.mjs";
import {
  readToolkitJson, validateToolkitManifest, mergeToolkitPreferences, registerToolkitPackage,
  findToolkitPackage, toolkitPackageSource,
} from "./toolkit-settings.mjs";

const TOOLKIT_SOURCE = "toolkits/pi-agent-setup";
const HELP = `Portable Pi toolkit

Usage: node setup.mjs [options]

Without package flags, ask which third-party packages to install. Choices stay
in the destination's toolkit-state.json, never in this repository.

  --agent-dir PATH       Destination (PI_CODING_AGENT_DIR or ~/.pi/agent)
  --link                 Link owned resources to this checkout instead of copying
  --dry-run              Validate and print the plan without writes or commands
  --list-packages        List package IDs from manifest.json
  --packages ID,ID       Select packages explicitly (suitable for scripts)
  --all-packages         Select every package in the manifest
  --skip-packages        Deploy owned resources only; keep saved package choices
  --reuse-selection     Reuse this machine's saved choices without prompting
  --apply-preferences   Apply shared preferences over existing values
  --replace-config      Back up and replace a conflicting APPEND_SYSTEM.md
  --help                 Show this help

Setup never uninstalls packages or copies credentials, sessions, or caches.
Existing package pins and resource filters are preserved. Close Pi before setup.
Pi and Node >=22.19 must already be installed; setup does not change either.
`;

function runPiInstall(source, agentDir) {
  const result = spawnSync("pi", ["install", source, "--no-approve"], {
    cwd: agentDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    stdio: "inherit",
  });
  if (result.error) throw new Error(`Pi package installation failed: ${source}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Pi package installation failed: ${source} (exit ${result.status}, signal ${result.signal ?? "none"})`);
}

function assertNoLegacyToolkitResources(root, agentDir, settings) {
  const collisions = [];
  for (const kind of ["extensions", "skills"]) {
    for (const name of readdirSync(join(root, "dotfiles", kind))) {
      const path = join(agentDir, kind, name);
      if (toolkitPathStat(path)) collisions.push(path);
    }
  }
  for (const name of readdirSync(join(root, "dotfiles", "local-packages"))) {
    const source = `local-packages/${name}`;
    if (findToolkitPackage(settings.packages ?? [], source, agentDir)) collisions.push(source);
  }
  if (collisions.length) {
    throw new Error(`Legacy Pi resources would load twice: ${collisions.join(", ")}. Use an empty --agent-dir; migrate the existing installation separately.`);
  }
}

function readToolkitState(path) {
  const state = readToolkitJson(path, {});
  if (Object.keys(state).length && (state.version !== 1 || state.ownsPackage !== true ||
      !Array.isArray(state.selectedPackages) || state.selectedPackages.some((id) => typeof id !== "string") ||
      typeof state.appendSystemHash !== "string")) {
    throw new Error(`Invalid toolkit state: ${path}`);
  }
  return state;
}

function assertAppendSystemOwnership(target, source, content, state, replaceConfig) {
  const stat = toolkitPathStat(target);
  if (!stat) return;
  if (toolkitLinkMatches(target, source)) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unmanaged toolkit instruction path: ${target}`);
  const current = readFileSync(target);
  if (current.equals(content) || toolkitContentHash(current) === state.appendSystemHash || replaceConfig) return;
  throw new Error(`Local Pi instructions would be overwritten: ${target}. Review them first, then use --replace-config to back up and replace.`);
}

function createToolkitQuestions(input, output) {
  const readline = createInterface({ input, output });
  readline.on("SIGINT", () => readline.close());
  return {
    close: () => readline.close(),
    async yesNo(message, defaultYes) {
      while (true) {
        const answer = await new Promise((accept, reject) => {
          if (readline.closed) { reject(new Error("Toolkit setup cancelled before installation")); return; }
          const cancelled = () => reject(new Error("Toolkit setup cancelled before installation"));
          readline.once("close", cancelled);
          readline.question(`${message} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (value) => {
            readline.removeListener("close", cancelled);
            accept(value.trim().toLowerCase());
          });
        });
        if (!answer) return defaultYes;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
        output.write("Please answer yes or no.\n");
      }
    },
  };
}

/** Run toolkit setup against an explicit source root; dependency injection keeps tests off the live Pi installation. */
export async function runToolkitSetup({ root, argv, input = process.stdin, output = process.stdout, installPackage = runPiInstall }) {
  const { values } = parseArgs({ args: argv, options: {
    "agent-dir": { type: "string" }, link: { type: "boolean" }, "dry-run": { type: "boolean" },
    "list-packages": { type: "boolean" }, packages: { type: "string" },
    "all-packages": { type: "boolean" }, "skip-packages": { type: "boolean" },
    "reuse-selection": { type: "boolean" }, "apply-preferences": { type: "boolean" },
    "replace-config": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { output.write(HELP); return; }
  const manifest = validateToolkitManifest(readToolkitJson(join(root, "manifest.json")));
  if (values["list-packages"]) {
    for (const entry of manifest.packages) output.write(`${entry.id}: ${entry.source}\n  ${entry.description}\n`);
    return;
  }
  const selectionFlags = ["packages", "all-packages", "skip-packages", "reuse-selection"];
  if (selectionFlags.filter((key) => values[key] !== undefined).length > 1) {
    throw new Error("Conflicting toolkit package flags: choose only one selection mode");
  }
  const agentDir = resolveToolkitAgentDir(root, values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  assertToolkitWritePaths(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const statePath = join(agentDir, "toolkit-state.json");
  const packagePath = join(agentDir, TOOLKIT_SOURCE);
  const appendSource = join(root, "dotfiles", "APPEND_SYSTEM.md");
  const appendTarget = join(agentDir, "APPEND_SYSTEM.md");
  const appendContent = readFileSync(appendSource);
  const settings = readToolkitJson(settingsPath, {});
  const state = readToolkitState(statePath);
  const preferences = readToolkitJson(join(root, "preferences.json"));
  const mergedSettings = registerToolkitPackage(mergeToolkitPreferences(settings, preferences, values["apply-preferences"]), TOOLKIT_SOURCE, agentDir);
  const files = collectToolkitFiles(root, readToolkitJson(join(root, "package.json")));
  assertNoLegacyToolkitResources(root, agentDir, settings);
  if (toolkitPathStat(packagePath) && !state.ownsPackage) {
    throw new Error(`Unmanaged toolkit package destination: ${packagePath}`);
  }
  assertAppendSystemOwnership(appendTarget, appendSource, appendContent, state, values["replace-config"]);

  let ids;
  let questions;
  try {
    if (values.packages !== undefined) {
      ids = values.packages.split(",").map((id) => id.trim());
      if (ids.some((id) => !id)) throw new Error("Empty toolkit package selection: use --skip-packages instead");
    } else if (values["all-packages"]) ids = manifest.packages.map((entry) => entry.id);
    else if (values["skip-packages"]) ids = [];
    else if (values["reuse-selection"]) {
      if (!state.selectedPackages) throw new Error("No saved toolkit package selection: run setup interactively first");
      ids = state.selectedPackages;
    } else {
      if (!input.isTTY || !output.isTTY) {
        throw new Error("Toolkit package selection requires a terminal: use --packages, --all-packages, --skip-packages, or --reuse-selection");
      }
      questions = createToolkitQuestions(input, output);
      output.write("Choose third-party packages. Unselected packages already installed are kept.\n");
      ids = [];
      for (const entry of manifest.packages) {
        const suggested = state.selectedPackages ? state.selectedPackages.includes(entry.id) : true;
        if (await questions.yesNo(`${entry.id}: ${entry.description}\nInstall ${entry.source}?`, suggested)) ids.push(entry.id);
      }
    }
    for (const id of ids) {
      if (!manifest.packages.some((entry) => entry.id === id)) throw new Error(`Unknown toolkit package ID: ${id}. See --list-packages.`);
    }
    const selected = manifest.packages.filter((entry) => ids.includes(entry.id));
    output.write(`\nSource: ${root}\nDestination: ${agentDir}\nMode: ${values.link ? "link" : "copy"}\n`);
    output.write(`Owned resources: ${files.size} files, plus APPEND_SYSTEM.md\nPreferences: ${values["apply-preferences"] ? "apply shared keys" : "seed missing keys only"}\n`);
    output.write(`Third-party packages: ${selected.map((entry) => entry.id).join(", ") || "none"}\n`);
    if (values["dry-run"]) { output.write("Dry run: no files written and no commands executed.\n"); return; }
    if (questions && !await questions.yesNo("Apply this setup? Close running Pi sessions first.", false)) {
      output.write("Cancelled: no changes made.\n"); return;
    }
    questions?.close();
    questions = undefined;
    // Recheck the user-owned settings after the interactive menu, before publishing anything.
    if (JSON.stringify(readToolkitJson(settingsPath, {})) !== JSON.stringify(settings)) {
      throw new Error("Pi settings changed during toolkit setup: close Pi and retry");
    }
    const backupRoot = join(agentDir, "toolkit-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    deployToolkitPackage({ root, target: packagePath, files, link: values.link, backupRoot });
    const appendMatches = values.link ? toolkitLinkMatches(appendTarget, appendSource) :
      toolkitPathStat(appendTarget)?.isFile() && readFileSync(appendTarget).equals(appendContent);
    if (!appendMatches) replaceToolkitPath({ target: appendTarget, backupRoot, backupName: "APPEND_SYSTEM.md", create(staging) {
      if (values.link) symlinkSync(appendSource, staging, "file");
      else writeFileSync(staging, appendContent, { mode: 0o600 });
    } });
    writeToolkitJson({ path: settingsPath, value: mergedSettings, backupRoot, backupName: "settings.json" });
    // Ownership is recorded before network work so a failed package install is safely retryable.
    writeToolkitJson({ path: statePath, backupRoot, backupName: "toolkit-state.json", value: {
      version: 1, ownsPackage: true, appendSystemHash: toolkitContentHash(appendContent),
      selectedPackages: values["skip-packages"] ? (state.selectedPackages ?? []) : selected.map((entry) => entry.id),
    } });
    for (const entry of selected) {
      const current = readToolkitJson(settingsPath, {});
      const installed = findToolkitPackage(current.packages ?? [], entry.source, agentDir);
      const source = installed ? toolkitPackageSource(installed) : entry.source;
      output.write(`Installing ${source}\n`);
      await installPackage(source, agentDir);
    }
    if (existsSync(backupRoot)) output.write(`Previous files: ${backupRoot}\n`);
    output.write("Toolkit setup complete. Use pi config to disable individual owned resources.\n");
    output.write(`Start with: PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)} pi\n`);
  } finally {
    questions?.close();
  }
}
