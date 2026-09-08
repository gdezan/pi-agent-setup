import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectToolkitFiles, resolveToolkitAgentDir, assertToolkitWritePaths, toolkitContentHash, toolkitCopyMatches,
  toolkitLinkMatches, toolkitPathHash, deployToolkitPackage, replaceToolkitPath, writeToolkitJson } from "./toolkit-files.mjs";
import { readToolkitJson, validateToolkitManifest } from "./toolkit-settings.mjs";
import { TOOLKIT_PACKAGE_SOURCE, inspectToolkitInventory, validateToolkitResources, verifyToolkitInventory } from "./toolkit-inventory.mjs";
import { readToolkitState, planToolkitSetup, reconcileToolkitExclusions, snapshotToolkitPlan, summarizeToolkitPlan } from "./toolkit-plan.mjs";
import { parseToolkitOptions, TOOLKIT_HELP } from "./toolkit-options.mjs";
import { createToolkitUI } from "./toolkit-ui.mjs";
import { runToolkitCommand, ToolkitCancelled } from "./toolkit-command.mjs";

/** Run one Pi package operation asynchronously; no shell, interactive child input, or mixed wizard output. */
export async function runToolkitPackageCommand(source, agentDir, { action, signal }) {
  const args = action === "update" ? ["update", "--extension", source, "--no-approve"] : ["install", source, "--no-approve"];
  try {
    await runToolkitCommand({ command: "pi", args, cwd: agentDir, signal, env: {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
    } });
  } catch (error) {
    if (error instanceof ToolkitCancelled) throw error;
    throw new Error(`Pi package operation failed: ${source}: ${error.message}\nRerun setup with --reuse-selection to retry.`);
  }
}

function selectionIds(options, state, manifest) {
  if (options.packages !== undefined) {
    const ids = [...new Set(options.packages.split(",").map((id) => id.trim()))];
    if (ids.some((id) => !id)) throw new Error("Empty toolkit package selection: use --skip-packages instead");
    return ids;
  }
  if (options["all-packages"]) return manifest.packages.map((entry) => entry.id);
  if (options["skip-packages"]) return [];
  if (options["reuse-selection"]) {
    if (!state.selectedPackages) throw new Error("No saved toolkit package selection: run setup interactively or use --packages");
    return state.selectedPackages.filter((id) => manifest.packages.some((entry) => entry.id === id));
  }
}

function checkSelection(ids, manifest) {
  for (const id of ids) {
    if (!manifest.packages.some((entry) => entry.id === id)) throw new Error(`Unknown toolkit package ID: ${id}. See --list-packages.`);
  }
}

function stateAfterDeployment(plan, files) {
  const next = structuredClone(plan.state);
  if (plan.resources.action !== "keep" || (next.ownsPackage && (plan.mode === "link" ?
    toolkitLinkMatches(plan.resources.target, plan.root) : toolkitCopyMatches(plan.resources.target, files)))) {
    next.packageHash = toolkitPathHash(plan.resources.target);
  }
  if (plan.instructions.owned) next.appendSystemHash = toolkitContentHash(plan.instructions.content);
  return next;
}

/** Inspect, plan, apply, and verify a global setup; dependencies keep tests off the live installation. */
export async function runToolkitSetup({ root, argv, input = process.stdin, output = process.stdout,
  installPackage = runToolkitPackageCommand, uiFactory = createToolkitUI, signal: suppliedSignal }) {
  const options = parseToolkitOptions(argv);
  if (options.help) { output.write(options.json ? `${JSON.stringify({ help: TOOLKIT_HELP })}\n` : TOOLKIT_HELP); return; }
  const manifest = validateToolkitManifest(readToolkitJson(join(root, "manifest.json")));
  if (options["list-packages"]) {
    output.write(options.json ? `${JSON.stringify({ packages: manifest.packages })}\n` : manifest.packages.map((entry) => `${entry.id}: ${entry.source}\n  ${entry.description}\n`).join(""));
    return;
  }
  const agentDir = resolveToolkitAgentDir(root, options["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  assertToolkitWritePaths(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const statePath = join(agentDir, "toolkit-state.json");
  const settings = readToolkitJson(settingsPath, {});
  const state = readToolkitState(statePath);
  const preferences = readToolkitJson(join(root, "preferences.json"));
  const packageJson = readToolkitJson(join(root, "package.json"));
  const files = collectToolkitFiles(root, packageJson);
  validateToolkitResources(manifest, files);
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error("Invalid Pi packages setting: expected an array");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, controller.signal]) : controller.signal;
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let locked = false;
  let applied = false;
  const lockPath = join(agentDir, "toolkit-setup.lock");
  const checkAbort = () => { if (signal.aborted) throw new ToolkitCancelled(); };
  try {
    const ui = await uiFactory({ input, output, options, signal });
    ui.start(agentDir);
    const inspection = { root, agentDir, settings, manifest };
    const inventory = await inspectToolkitInventory(inspection);
    checkAbort();
    const snapshot = snapshotToolkitPlan({ root, agentDir, packageJson, inventory });
    let ids = selectionIds(options, state, manifest);
    let plan;
    const canChoose = ids === undefined && ui.interactive;
    if (ids === undefined && !ui.interactive) {
      if (!state.selectedPackages) throw new Error("Toolkit package selection requires a terminal or saved choices: use --packages, --all-packages, or --skip-packages");
      ids = selectionIds({ "reuse-selection": true }, state, manifest);
    }
    const initial = state.selectedPackages?.filter((id) => manifest.packages.some((entry) => entry.id === id)) ?? inventory.packages.filter((entry) => entry.registered).map((entry) => entry.id);
    while (true) {
      if (canChoose) ids = await ui.packages(inventory, ids ?? initial);
      checkSelection(ids, manifest);
      const build = () => planToolkitSetup({ root, agentDir, settings, state, manifest, preferences, files, inventory, selectedIds: ids, options });
      plan = build();
      if (!options["dry-run"]) {
        for (const conflict of plan.conflicts) {
          if (!ui.interactive) throw new Error(`Toolkit decision required: ${conflict.conflictMessage} Use --conflicts keep, --repair, --replace-config, or --replace-resources as appropriate.`);
          options.decisions ??= {};
          options.decisions[conflict.conflictKey] = await ui.conflict(conflict, files, root);
        }
        plan = build();
      }
      const settingsChanged = JSON.stringify(plan.settings) !== JSON.stringify(settings);
      ui.plan(plan, settingsChanged);
      if (options["dry-run"]) {
        const receipt = { status: "planned", ...summarizeToolkitPlan(plan), message: "Dry run: no files written and no package installs or updates run." };
        ui.finish(receipt); return receipt;
      }
      // Calculate baseline metadata without rewriting files; this also upgrades safe v1 records once.
      plan.state = stateAfterDeployment(plan, files);
      const changes = [plan.resources, plan.instructions, ...plan.packages].some((entry) => entry.action !== "keep") || settingsChanged ||
        JSON.stringify(plan.state) !== JSON.stringify(state);
      if (!changes) {
        await verifyToolkitInventory({ ...inspection, requireBundledResources: plan.resources.register && !plan.resources.keptConflict }, inventory);
        const summary = summarizeToolkitPlan(plan);
        const receipt = { status: "unchanged", ...summary,
          ...(!summary.warnings.length ? { next: { command: "pi", env: { PI_CODING_AGENT_DIR: agentDir } } } : {}),
          message: summary.warnings.length ? "No changes requested. Review the reported warnings." : "Everything is already set up." };
        ui.finish(receipt); return receipt;
      }
      if (!ui.interactive || options.yes) break;
      const choice = await ui.confirm({ canChoose });
      if (choice === "cancel") throw new ToolkitCancelled();
      if (choice === "back") {
        if (canChoose) continue;
        throw new ToolkitCancelled();
      }
      break;
    }
    checkAbort();
    assertToolkitWritePaths(agentDir);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    try { writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); locked = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid lock PID");
        try { process.kill(pid, 0); } catch (probe) { if (probe.code === "ESRCH") stale = true; else throw probe; }
      } catch (probe) {
        if (!stale) throw new Error(`Toolkit setup is locked: ${lockPath}. Wait for the other setup; remove this file only if no setup is running.`);
      }
      if (!stale) throw new Error(`Toolkit setup is locked: ${lockPath}. Wait for the other setup; remove this file only if no setup is running.`);
      rmSync(lockPath);
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      locked = true;
    }
    if (snapshotToolkitPlan({ root, agentDir, packageJson, inventory }) !== snapshot) {
      throw new Error("Toolkit inputs changed during setup: no planned changes applied. Close Pi and rerun setup.");
    }
    const backupRoot = join(agentDir, "toolkit-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
    applied = true;
    if (plan.resources.action !== "keep") deployToolkitPackage({ root, target: plan.resources.target, files, link: plan.mode === "link", backupRoot });
    if (plan.instructions.action !== "keep") replaceToolkitPath({ target: plan.instructions.target, backupRoot, backupName: "APPEND_SYSTEM.md", create(staging) {
      if (plan.mode === "link") symlinkSync(plan.instructions.source, staging, "file");
      else writeFileSync(staging, plan.instructions.content, { mode: 0o600 });
    } });
    plan.state = stateAfterDeployment(plan, files);
    const operations = plan.packages.filter((entry) => ["install", "repair", "update"].includes(entry.action));
    plan.state.pendingPackages = [...new Set([...plan.state.pendingPackages, ...operations.map((entry) => entry.id)])];
    writeToolkitJson({ path: settingsPath, value: plan.settings, backupRoot, backupName: "settings.json" });
    const saveState = () => writeToolkitJson({ path: statePath, value: plan.state, backupRoot, backupName: "toolkit-state.json" });
    saveState();
    for (const entry of operations) {
      checkAbort();
      await ui.task(`${entry.action === "update" ? "Updating" : entry.action === "repair" ? "Repairing" : "Installing"} ${entry.id}`, () =>
        installPackage(entry.source, agentDir, { action: entry.action, signal }), `Package command finished: ${entry.id}`);
      checkAbort();
      const installed = await inspectToolkitInventory({ ...inspection, settings: readToolkitJson(settingsPath) });
      if (!installed.packages.find((pkg) => pkg.id === entry.id)?.present) {
        throw new Error(`Toolkit package verification failed: ${entry.source} is still missing or has the wrong version. Rerun with --reuse-selection to repair.`);
      }
      plan.state.pendingPackages = plan.state.pendingPackages.filter((id) => id !== entry.id);
      saveState();
    }
    checkAbort();
    // Newly installed packages can contain a catalogued resource. Exclude its bundled counterpart before verifying.
    const currentSettings = readToolkitJson(settingsPath);
    const after = await inspectToolkitInventory({ ...inspection, settings: currentSettings });
    // A downloaded package can reveal a previously unknown copy. Do not infer equivalence from its contents.
    const recheck = () => planToolkitSetup({ root, agentDir, settings: currentSettings, state: plan.state, manifest, preferences,
      files, inventory: after, selectedIds: [], options: { ...options, "skip-packages": true } });
    for (const conflict of recheck().conflicts.filter((entry) => entry.retainOnly)) {
      if (!ui.interactive) throw new Error(`New package resources need a decision: ${conflict.conflictMessage} Rerun with --reuse-selection to choose, or --conflicts keep to retain them.`);
      options.decisions ??= {};
      options.decisions[conflict.conflictKey] = await ui.conflict(conflict, files, root);
    }
    checkAbort();
    plan.state.keptConflicts = recheck().state.keptConflicts;
    const reconciled = reconcileToolkitExclusions(currentSettings, agentDir, after.resources, plan.state.resourceExclusions);
    plan.state.resourceExclusions = reconciled.exclusions;
    writeToolkitJson({ path: settingsPath, value: reconciled.settings, backupRoot, backupName: "settings.json" });
    saveState();
    await ui.task("Verifying global resources", () => verifyToolkitInventory({ ...inspection, settings: reconciled.settings, requireBundledResources: plan.resources.register && !plan.resources.keptConflict }, inventory), "Verified global resources");
    const summary = summarizeToolkitPlan(plan);
    const receipt = { status: "applied", ...summary, backup: existsSync(backupRoot) ? backupRoot : undefined,
      ...(!summary.warnings.length ? { next: { command: "pi", env: { PI_CODING_AGENT_DIR: agentDir } } } : {}),
      message: summary.warnings.length ? "Setup finished with warnings; review them before starting Pi." : "Pi setup complete. Existing local resources were preserved." };
    ui.finish(receipt); return receipt;
  } catch (error) {
    if (error instanceof ToolkitCancelled) error.message = applied ? "Toolkit setup cancelled. Completed changes were kept; rerun with --reuse-selection to resume." : "Toolkit setup cancelled. No changes made.";
    throw error;
  } finally {
    if (locked) rmSync(lockPath, { force: true });
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
