import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectToolkitFiles,
  resolveToolkitAgentDir,
  assertToolkitWritePaths,
  toolkitCopyMatches,
  toolkitLinkMatches,
  toolkitPathHash,
  toolkitPathStat,
  deployToolkitPackage,
  archiveToolkitLegacyPath,
  replaceToolkitPath,
  writeToolkitJson,
} from "./toolkit-files.mjs";
import { readToolkitJson, validateToolkitManifest } from "./toolkit-settings.mjs";
import {
  LEGACY_TOOLKIT_PACKAGE_SOURCE,
  TOOLKIT_PACKAGE_SOURCE,
  inspectToolkitInventory,
  validateToolkitResources,
  verifyToolkitInventory,
} from "./toolkit-inventory.mjs";
import {
  readToolkitState,
  planToolkitSetup,
  reconcileToolkitExclusions,
  snapshotToolkitPlan,
  summarizeToolkitPlan,
} from "./toolkit-plan.mjs";
import { parseToolkitOptions, TOOLKIT_HELP } from "./toolkit-options.mjs";
import { createToolkitUI } from "./toolkit-ui.mjs";
import { runToolkitCommand, ToolkitCancelled } from "./toolkit-command.mjs";
import {
  installToolkitExtensionDependencies,
  toolkitExtensionDependenciesMissing,
} from "./toolkit-dependencies.mjs";
import {
  assertToolkitCleanupPath,
  listToolkitCleanupCandidates,
  readToolkitKeep,
  TOOLKIT_KEEP_FILE,
} from "./toolkit-cleanup.mjs";

/** Run one Pi package operation asynchronously; no shell, interactive child input, or mixed wizard output. */
export async function runToolkitPackageCommand(source, agentDir, { action, signal }) {
  const args =
    action === "update"
      ? ["update", "--extension", source, "--no-approve"]
      : ["install", source, "--no-approve"];
  try {
    await runToolkitCommand({
      command: "pi",
      args,
      cwd: agentDir,
      signal,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
      },
    });
  } catch (error) {
    if (error instanceof ToolkitCancelled) throw error;
    throw new Error(
      `Pi package operation failed: ${source}: ${error.message}\nRerun setup with --reuse-selection to retry.`,
    );
  }
}

/** Remove only a package explicitly checked in the wizard, using Pi's package manager. */
export async function runToolkitRemoveCommand(source, agentDir, { signal }) {
  await runToolkitCommand({
    command: "pi",
    args: ["remove", source, "--no-approve"],
    cwd: agentDir,
    signal,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function selectionIds(options, state, manifest) {
  if (options.packages !== undefined) {
    const ids = [...new Set(options.packages.split(",").map((id) => id.trim()))];
    if (ids.some((id) => !id))
      throw new Error("Empty toolkit package selection: use --skip-packages instead");
    return ids;
  }
  if (options["all-packages"]) return manifest.packages.map((entry) => entry.id);
  if (options["skip-packages"]) return [];
  if (options["reuse-selection"]) {
    if (!state.selectedPackages)
      throw new Error(
        "No saved toolkit package selection: run setup interactively or use --packages",
      );
    return state.selectedPackages.filter((id) =>
      manifest.packages.some((entry) => entry.id === id),
    );
  }
}

function extensionSelectionIds(options, state, manifest) {
  const extensions = manifest.resources.filter((resource) => resource.kind === "extensions");
  const all = extensions.map((resource) => resource.id);
  if (options.extensions !== undefined) {
    const ids = [...new Set(options.extensions.split(",").map((id) => id.trim()))];
    if (ids.some((id) => !id))
      throw new Error("Empty toolkit extension selection: use --skip-extensions instead");
    return ids;
  }
  if (options["all-extensions"]) return all;
  if (options["skip-extensions"]) return [];
  return (state.selectedExtensions ?? all).filter((id) => all.includes(id));
}

function checkSelection(ids, manifest) {
  for (const id of ids) {
    if (!manifest.packages.some((entry) => entry.id === id))
      throw new Error(`Unknown toolkit package ID: ${id}. See --list-packages.`);
  }
}

function checkExtensionSelection(ids, manifest) {
  const known = new Set(
    manifest.resources
      .filter((resource) => resource.kind === "extensions")
      .map((resource) => resource.id),
  );
  for (const id of ids) {
    if (!known.has(id))
      throw new Error(`Unknown toolkit extension ID: ${id}. See manifest.json resources.`);
  }
}

function stateAfterDeployment(plan, files) {
  const next = structuredClone(plan.state);
  if (
    plan.resources.action !== "keep" ||
    (next.ownsPackage &&
      (plan.mode === "link"
        ? toolkitLinkMatches(plan.resources.target, plan.root)
        : toolkitCopyMatches(plan.resources.target, files)))
  ) {
    next.packageHash = toolkitPathHash(plan.resources.target, { ignoreDependencies: true });
  }
  if (plan.instructions.owned) {
    next.appendSystemHash = null;
    next.appendSystemBlockHash = plan.instructions.blockHash;
  }
  return next;
}

/** Inspect, plan, apply, and verify a global setup; dependencies keep tests off the live installation. */
export async function runToolkitSetup({
  root,
  argv,
  input = process.stdin,
  output = process.stdout,
  installPackage = runToolkitPackageCommand,
  installExtensionDependencies = installToolkitExtensionDependencies,
  removePackage = runToolkitRemoveCommand,
  uiFactory = createToolkitUI,
  signal: suppliedSignal,
}) {
  const options = parseToolkitOptions(argv);
  if (options.help) {
    output.write(options.json ? `${JSON.stringify({ help: TOOLKIT_HELP })}\n` : TOOLKIT_HELP);
    return;
  }
  const manifest = validateToolkitManifest(readToolkitJson(join(root, "manifest.json")));
  if (options["list-packages"]) {
    output.write(
      options.json
        ? `${JSON.stringify({ packages: manifest.packages })}\n`
        : manifest.packages
            .map((entry) => `${entry.id}: ${entry.source}\n  ${entry.description}\n`)
            .join(""),
    );
    return;
  }
  const agentDir = resolveToolkitAgentDir(
    root,
    options["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
  assertToolkitWritePaths(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const statePath = join(agentDir, "toolkit-state.json");
  const settings = readToolkitJson(settingsPath, {});
  const state = readToolkitState(statePath);
  const preferences = readToolkitJson(join(root, "preferences.json"));
  const packageJson = readToolkitJson(join(root, "package.json"));
  const files = collectToolkitFiles(root, packageJson);
  validateToolkitResources(manifest, files);
  if (settings.packages !== undefined && !Array.isArray(settings.packages))
    throw new Error("Invalid Pi packages setting: expected an array");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = suppliedSignal
    ? AbortSignal.any([suppliedSignal, controller.signal])
    : controller.signal;
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let locked = false;
  let applied = false;
  const lockPath = join(agentDir, "toolkit-setup.lock");
  const checkAbort = () => {
    if (signal.aborted) throw new ToolkitCancelled();
  };
  try {
    const ui = await uiFactory({ input, output, options, signal });
    ui.start(agentDir);
    const inspection = { root, agentDir, settings, manifest };
    const inventory = await inspectToolkitInventory(inspection);
    checkAbort();
    const keep = readToolkitKeep(agentDir);
    const snapshotCleanup = listToolkitCleanupCandidates({
      agentDir,
      settings,
      manifest,
      selectedIds: [],
      keep,
    }).candidates;
    const snapshot = snapshotToolkitPlan({
      root,
      agentDir,
      packageJson,
      inventory,
      cleanup: snapshotCleanup,
    });
    let ids = selectionIds(options, state, manifest);
    let selectedExtensions = extensionSelectionIds(options, state, manifest);
    let cleanup = [];
    let plan;
    let keptReported = false;
    const canChoose = ids === undefined && ui.interactive;
    const canChooseExtensions =
      ui.interactive &&
      options.extensions === undefined &&
      !options["all-extensions"] &&
      !options["skip-extensions"] &&
      !options["reuse-selection"];
    if (ids === undefined && !ui.interactive) {
      if (!state.selectedPackages)
        throw new Error(
          "Toolkit package selection requires a terminal or saved choices: use --packages, --all-packages, or --skip-packages",
        );
      ids = selectionIds({ "reuse-selection": true }, state, manifest);
    }
    const initial =
      state.selectedPackages?.filter((id) => manifest.packages.some((entry) => entry.id === id)) ??
      inventory.packages.filter((entry) => entry.registered).map((entry) => entry.id);
    while (true) {
      if (canChoose) ids = await ui.packages(inventory, ids ?? initial);
      checkSelection(ids, manifest);
      if (canChooseExtensions && ui.extensions)
        selectedExtensions = await ui.extensions(inventory, selectedExtensions);
      checkExtensionSelection(selectedExtensions, manifest);
      const { candidates: cleanupCandidates, kept } = listToolkitCleanupCandidates({
        agentDir,
        settings,
        manifest,
        selectedIds: ids,
        keep,
      });
      // Say what the keep list saved, so an honoured entry is visible rather than
      // looking like the cleanup step quietly forgot it.
      if (kept.length > 0 && !keptReported) {
        keptReported = true;
        ui.kept?.(TOOLKIT_KEEP_FILE, kept);
      }
      // Deletions are never inherited from saved choices or accepted by noninteractive flags.
      cleanup = ui.interactive ? ((await ui.cleanup?.(cleanupCandidates)) ?? []) : [];
      const build = () =>
        planToolkitSetup({
          root,
          agentDir,
          settings,
          state,
          manifest,
          preferences,
          files,
          inventory,
          selectedIds: ids,
          selectedExtensions,
          options,
        });
      plan = build();
      plan.cleanup = cleanup;
      if (!options["dry-run"]) {
        for (const conflict of plan.conflicts) {
          if (!ui.interactive)
            throw new Error(
              `Toolkit decision required: ${conflict.conflictMessage} Use --conflicts keep, --replace-legacy, --repair, --replace-config, or --replace-resources as appropriate.`,
            );
          options.decisions ??= {};
          options.decisions[conflict.conflictKey] = await ui.conflict(conflict, files, root);
        }
        plan = build();
        plan.cleanup = cleanup;
      }
      const settingsChanged = JSON.stringify(plan.settings) !== JSON.stringify(settings);
      ui.plan(plan, settingsChanged);
      if (options["dry-run"]) {
        const receipt = {
          status: "planned",
          ...summarizeToolkitPlan(plan),
          message: "Dry run: no files written and no package installs or updates run.",
        };
        ui.finish(receipt);
        return receipt;
      }
      // Calculate baseline metadata without rewriting files; this also upgrades safe v1 records once.
      plan.state = stateAfterDeployment(plan, files);
      const changes =
        [plan.resources, plan.instructions, ...plan.packages, ...plan.migrations].some(
          (entry) => entry.action !== "keep",
        ) ||
        cleanup.length > 0 ||
        (plan.resources.register &&
          !plan.resources.keptConflict &&
          toolkitExtensionDependenciesMissing({
            root: plan.resources.target,
            resources: manifest.resources,
            selectedExtensions: plan.state.selectedExtensions,
          })) ||
        settingsChanged ||
        JSON.stringify(plan.state) !== JSON.stringify(state);
      if (!changes) {
        await verifyToolkitInventory(
          {
            ...inspection,
            requireBundledResources: plan.resources.register && !plan.resources.keptConflict,
          },
          inventory,
        );
        const summary = summarizeToolkitPlan(plan);
        const receipt = {
          status: "unchanged",
          ...summary,
          ...(!summary.warnings.length
            ? { next: { command: "pi", env: { PI_CODING_AGENT_DIR: agentDir } } }
            : {}),
          message: summary.warnings.length
            ? "No changes requested. Review the reported warnings."
            : "Everything is already set up.",
        };
        ui.finish(receipt);
        return receipt;
      }
      if (!ui.interactive || options.yes) break;
      const choice = await ui.confirm({ canChoose: canChoose || canChooseExtensions });
      if (choice === "cancel") throw new ToolkitCancelled();
      if (choice === "back") {
        if (canChoose || canChooseExtensions) continue;
        throw new ToolkitCancelled();
      }
      break;
    }
    checkAbort();
    assertToolkitWritePaths(agentDir);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      locked = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid lock PID");
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (probe.code === "ESRCH") stale = true;
          else throw probe;
        }
      } catch (probe) {
        if (!stale)
          throw new Error(
            `Toolkit setup is locked: ${lockPath}. Wait for the other setup; remove this file only if no setup is running.`,
          );
      }
      if (!stale)
        throw new Error(
          `Toolkit setup is locked: ${lockPath}. Wait for the other setup; remove this file only if no setup is running.`,
        );
      rmSync(lockPath);
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      locked = true;
    }
    if (
      snapshotToolkitPlan({ root, agentDir, packageJson, inventory, cleanup: snapshotCleanup }) !==
      snapshot
    ) {
      throw new Error(
        "Toolkit inputs changed during setup: no planned changes applied. Close Pi and rerun setup.",
      );
    }
    for (const entry of cleanup) if (entry.path) assertToolkitCleanupPath(agentDir, entry.path);
    const backupRoot = join(
      agentDir,
      "toolkit-backups",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    applied = true;
    if (plan.resources.action !== "keep") {
      deployToolkitPackage({
        root,
        target: plan.resources.target,
        files,
        link: plan.mode === "link",
        backupRoot,
      });
      if (
        plan.resources.legacyPackageTarget &&
        toolkitPathStat(plan.resources.legacyPackageTarget)
      ) {
        archiveToolkitLegacyPath({
          agentDir,
          target: plan.resources.legacyPackageTarget,
          backupRoot,
          legacy: LEGACY_TOOLKIT_PACKAGE_SOURCE,
          preservePath: true,
        });
      }
    }
    if (plan.instructions.action !== "keep")
      replaceToolkitPath({
        target: plan.instructions.target,
        backupRoot,
        backupName: "APPEND_SYSTEM.md",
        create(staging) {
          writeFileSync(staging, plan.instructions.content, { mode: 0o600 });
        },
      });
    const pendingLegacy = plan.migrations
      .filter((entry) => entry.action === "migrate")
      .map((entry) => entry.legacy);
    // Keep exclusion ownership from the settings still on disk until those settings are replaced.
    if (pendingLegacy.length)
      writeToolkitJson({
        path: statePath,
        value: {
          ...plan.state,
          resourceExclusions: state.resourceExclusions ?? {},
          pendingLegacy,
        },
        backupRoot,
        backupName: "toolkit-state.json",
      });
    for (const entry of plan.migrations.filter((entry) => entry.action === "migrate")) {
      archiveToolkitLegacyPath({
        agentDir,
        target: entry.target,
        backupRoot,
        legacy: entry.legacy,
      });
    }
    plan.state = stateAfterDeployment(plan, files);
    const operations = plan.packages.filter((entry) =>
      ["install", "repair", "update"].includes(entry.action),
    );
    plan.state.pendingPackages = [
      ...new Set([...plan.state.pendingPackages, ...operations.map((entry) => entry.id)]),
    ];
    writeToolkitJson({
      path: settingsPath,
      value: plan.settings,
      backupRoot,
      backupName: "settings.json",
    });
    const saveState = () =>
      writeToolkitJson({
        path: statePath,
        value: plan.state,
        backupRoot,
        backupName: "toolkit-state.json",
      });
    saveState();
    const extensionDependencies = {
      root: plan.resources.target,
      resources: manifest.resources,
      selectedExtensions: plan.state.selectedExtensions,
      signal,
    };
    if (
      plan.resources.register &&
      !plan.resources.keptConflict &&
      toolkitExtensionDependenciesMissing(extensionDependencies)
    ) {
      await ui.task(
        "Installing local extension dependencies",
        () => installExtensionDependencies(extensionDependencies),
        "Installed local extension dependencies",
      );
    }
    for (const entry of operations) {
      checkAbort();
      await ui.task(
        `${entry.action === "update" ? "Updating" : entry.action === "repair" ? "Repairing" : "Installing"} ${entry.id}`,
        () => installPackage(entry.source, agentDir, { action: entry.action, signal }),
        `Package command finished: ${entry.id}`,
      );
      checkAbort();
      const installed = await inspectToolkitInventory({
        ...inspection,
        settings: readToolkitJson(settingsPath),
      });
      if (!installed.packages.find((pkg) => pkg.id === entry.id)?.present) {
        throw new Error(
          `Toolkit package verification failed: ${entry.source} is still missing or has the wrong version. Rerun with --reuse-selection to repair.`,
        );
      }
      plan.state.pendingPackages = plan.state.pendingPackages.filter((id) => id !== entry.id);
      saveState();
    }
    for (const entry of cleanup) {
      checkAbort();
      if (entry.path) assertToolkitCleanupPath(agentDir, entry.path);
      if (entry.kind === "package") {
        await ui.task(
          `Deleting ${entry.label}`,
          () => removePackage(entry.source, agentDir, { signal }),
          `Deleted ${entry.label}`,
        );
      }
      if (entry.path) {
        rmSync(entry.path, { recursive: true, force: true });
      }
    }
    checkAbort();
    // Newly installed packages can contain a catalogued resource. Exclude its bundled counterpart before verifying.
    const currentSettings = readToolkitJson(settingsPath);
    const after = await inspectToolkitInventory({ ...inspection, settings: currentSettings });
    // A downloaded package can reveal a previously unknown copy. Do not infer equivalence from its contents.
    const recheck = () =>
      planToolkitSetup({
        root,
        agentDir,
        settings: currentSettings,
        state: plan.state,
        manifest,
        preferences,
        files,
        inventory: after,
        selectedIds: [],
        selectedExtensions: plan.state.selectedExtensions,
        options: { ...options, "skip-packages": true },
      });
    for (const conflict of recheck().conflicts.filter((entry) => entry.retainOnly)) {
      if (!ui.interactive)
        throw new Error(
          `New package resources need a decision: ${conflict.conflictMessage} Rerun with --reuse-selection to choose, or --conflicts keep to retain them.`,
        );
      options.decisions ??= {};
      options.decisions[conflict.conflictKey] = await ui.conflict(conflict, files, root);
    }
    checkAbort();
    plan.state.keptConflicts = recheck().state.keptConflicts;
    const reconciled = reconcileToolkitExclusions(
      currentSettings,
      agentDir,
      after.resources,
      plan.state.selectedExtensions,
      plan.state.resourceExclusions,
    );
    plan.state.resourceExclusions = reconciled.exclusions;
    writeToolkitJson({
      path: settingsPath,
      value: reconciled.settings,
      backupRoot,
      backupName: "settings.json",
    });
    saveState();
    await ui.task(
      "Verifying global resources",
      () =>
        verifyToolkitInventory(
          {
            ...inspection,
            settings: reconciled.settings,
            requireBundledResources: plan.resources.register && !plan.resources.keptConflict,
          },
          inventory,
        ),
      "Verified global resources",
    );
    const summary = summarizeToolkitPlan(plan);
    const receipt = {
      status: "applied",
      ...summary,
      backup: existsSync(backupRoot) ? backupRoot : undefined,
      ...(!summary.warnings.length
        ? { next: { command: "pi", env: { PI_CODING_AGENT_DIR: agentDir } } }
        : {}),
      message: summary.warnings.length
        ? "Setup finished with warnings; review them before starting Pi."
        : "Pi setup complete. Existing local resources were preserved.",
    };
    ui.finish(receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ToolkitCancelled)
      error.message = applied
        ? "Toolkit setup cancelled. Completed changes were kept; rerun with --reuse-selection to resume."
        : "Toolkit setup cancelled. No changes made.";
    throw error;
  } finally {
    if (locked) rmSync(lockPath, { force: true });
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
