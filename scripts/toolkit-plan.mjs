import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectToolkitFiles, toolkitContentHash, toolkitCopyMatches, toolkitLinkMatches, toolkitPathHash, toolkitPathStat } from "./toolkit-files.mjs";
import { findToolkitPackage, mergeToolkitPreferences, readToolkitJson, registerToolkitPackage, toolkitPackageSource } from "./toolkit-settings.mjs";
import { TOOLKIT_PACKAGE_SOURCE } from "./toolkit-inventory.mjs";

/** Read old ownership records conservatively; v1 has no package baseline and cannot prove a safe overwrite. */
export function readToolkitState(path) {
  const state = readToolkitJson(path, {});
  if (!Object.keys(state).length) return state;
  if (![1, 2].includes(state.version) || typeof state.ownsPackage !== "boolean" ||
      !Array.isArray(state.selectedPackages) || state.selectedPackages.some((id) => typeof id !== "string") ||
      (state.appendSystemHash != null && typeof state.appendSystemHash !== "string") ||
      (state.packageHash != null && typeof state.packageHash !== "string") ||
      (state.mode !== undefined && !["copy", "link"].includes(state.mode)) ||
      (state.pendingPackages !== undefined && (!Array.isArray(state.pendingPackages) || state.pendingPackages.some((id) => typeof id !== "string")))) {
    throw new Error(`Invalid toolkit state: ${path}`);
  }
  if ([state.resourceExclusions, state.keptConflicts].some((value) => value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))) ||
      Object.values(state.keptConflicts ?? {}).some((value) => typeof value !== "string")) {
    throw new Error(`Invalid toolkit decision state: ${path}`);
  }
  for (const patterns of Object.values(state.resourceExclusions ?? {})) {
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || !pattern.startsWith("-"))) {
      throw new Error(`Invalid toolkit resource exclusions: ${path}`);
    }
  }
  return state;
}

/** Layer only toolkit-owned exclusions over user filters, including explicitly disabled resource types. */
export function reconcileToolkitExclusions(settings, agentDir, resources, previous = {}) {
  const result = structuredClone(settings);
  const entry = findToolkitPackage(result.packages ?? [], TOOLKIT_PACKAGE_SOURCE, agentDir);
  const exclusions = {};
  if (!entry) return { settings: result, exclusions };
  const index = result.packages.indexOf(entry);
  const filtered = typeof entry === "string" ? { source: entry } : entry;
  for (const kind of ["extensions", "skills"]) {
    if (filtered[kind] !== undefined && !Array.isArray(filtered[kind])) throw new Error(`Invalid toolkit resource filters: ${kind}`);
    let patterns = filtered[kind];
    // [] is Pi's explicit "disable all"; never turn it into a negative-only filter.
    if (patterns?.length === 0) continue;
    const old = previous[kind] ?? [];
    if (patterns && old.length) {
      patterns = patterns.filter((pattern) => !old.includes(pattern));
      if (!patterns.length) patterns = undefined;
    }
    const required = resources.filter((resource) => resource.kind === kind && resource.existing.length &&
      (resource.existing.some((entry) => entry.enabled) || !patterns?.includes(`+${resource.path}`))).map((resource) => `-${resource.path}`);
    const additions = required.filter((pattern) => !(patterns ?? []).includes(pattern));
    if (additions.length) exclusions[kind] = additions;
    if (patterns !== undefined || additions.length) filtered[kind] = [...(patterns ?? []), ...additions];
    else delete filtered[kind];
  }
  result.packages[index] = typeof entry === "string" && Object.keys(filtered).length === 1 ? entry : filtered;
  return { settings: result, exclusions };
}

function planPackageFiles({ root, agentDir, files, state, mode, replaceResources }) {
  const target = join(agentDir, TOOLKIT_PACKAGE_SOURCE);
  const exists = Boolean(toolkitPathStat(target));
  const matches = mode === "link" ? toolkitLinkMatches(target, root) : toolkitCopyMatches(target, files);
  const baseline = state.ownsPackage && (state.packageHash === toolkitPathHash(target) || toolkitLinkMatches(target, root));
  const conflict = exists && !matches && !baseline && !replaceResources;
  return { id: "resources", target, action: !exists ? "install" : matches ? "keep" : conflict ? "conflict" : "update",
    owned: Boolean(state.ownsPackage || !exists || replaceResources), register: !conflict,
    message: "Custom resources", conflictMessage: "Custom resources contain local changes or have no recorded baseline." };
}

function planInstructions({ root, agentDir, state, mode, replaceConfig }) {
  const source = join(root, "dotfiles/APPEND_SYSTEM.md");
  const target = join(agentDir, "APPEND_SYSTEM.md");
  const content = readFileSync(source);
  const stat = toolkitPathStat(target);
  const hash = stat?.isFile() ? toolkitContentHash(readFileSync(target)) : null;
  const linked = toolkitLinkMatches(target, source);
  const matches = mode === "link" ? linked : hash === toolkitContentHash(content);
  const baseline = Boolean(linked || (state.appendSystemHash && state.appendSystemHash === hash));
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Invalid toolkit instruction destination: ${target}`);
  return { id: "instructions", target, source, action: !stat ? "install" : matches ? "keep" : (baseline || replaceConfig) ? "update" : "conflict",
    owned: Boolean(!stat || baseline || replaceConfig), content,
    message: "System instructions", conflictMessage: "Existing system instructions differ from the shared version." };
}

/** Build a no-write installation plan; unresolved conflicts must be decided before apply. */
export function planToolkitSetup({ root, agentDir, settings, state, manifest, preferences, files, inventory, selectedIds, options }) {
  const mode = options.link ? "link" : options.copy ? "copy" : state.mode ?? (toolkitLinkMatches(join(agentDir, TOOLKIT_PACKAGE_SOURCE), root) ? "link" : "copy");
  const resources = planPackageFiles({ root, agentDir, files, state, mode, replaceResources: options["replace-resources"] });
  const instructions = planInstructions({ root, agentDir, state, mode, replaceConfig: options["replace-config"] });
  let nextSettings = mergeToolkitPreferences(settings, preferences, options["apply-preferences"]);
  if (resources.register) nextSettings = registerToolkitPackage(nextSettings, TOOLKIT_PACKAGE_SOURCE, agentDir);
  const packages = inventory.packages.filter((entry) => selectedIds.includes(entry.id)).map((entry) => {
    const retry = state.pendingPackages?.includes(entry.id);
    const action = retry ? "repair" : !entry.present ? (entry.registered ? (options.repair ? "repair" : "conflict") : "install") :
      options["update-packages"] ? "update" : entry.registered ? "keep" : "register";
    if (action !== "conflict") nextSettings = registerToolkitPackage(nextSettings, entry.source, agentDir);
    return { ...entry, action, message: entry.id,
      conflictMessage: `Registered package is missing or does not match its configured version: ${entry.source}` };
  });
  const keptConflicts = { ...(state.keptConflicts ?? {}) };
  const uncertainResources = inventory.resources.filter((resource) => resource.existing.some((entry) => entry.uncertain)).map((resource) => ({
    id: resource.id, action: "conflict", retainOnly: true, source: resource.existing.map((entry) => entry.path).join(", "),
    desired: resource.existing.map((entry) => [entry.path, entry.hash]),
    conflictMessage: `Possible duplicate of ${resource.id}: matching source at an unrecognized path. Keep it and exclude the bundled copy?`,
  }));
  for (const entry of [resources, instructions, ...packages, ...uncertainResources]) {
    if (entry.action !== "conflict") continue;
    const key = entry === resources ? "resources" : entry === instructions ? "instructions" : entry.retainOnly ? `resource:${entry.id}` : `package:${entry.id}`;
    const desired = entry === resources ? [...files].map(([path, file]) => [path, toolkitContentHash(file.content)]) :
      entry === instructions ? toolkitContentHash(entry.content) : entry.desired ?? entry.source;
    const signature = toolkitContentHash(JSON.stringify([entry.target ? toolkitPathHash(entry.target) : entry.installedPath ?? null, desired]));
    entry.conflictKey = key;
    entry.signature = signature;
    const decision = options.decisions?.[key] ?? options.conflicts ?? (keptConflicts[key] === signature ? "keep" : undefined);
    if (decision === "keep") {
      entry.action = "keep";
      entry.keptConflict = true;
      keptConflicts[key] = signature;
    } else if (decision === "replace" || decision === "repair") {
      entry.action = entry.target ? "update" : "repair";
      delete keptConflicts[key];
      if (entry === resources) { entry.owned = true; entry.register = true; nextSettings = registerToolkitPackage(nextSettings, TOOLKIT_PACKAGE_SOURCE, agentDir); }
      else if (entry === instructions) entry.owned = true;
      else nextSettings = registerToolkitPackage(nextSettings, entry.source, agentDir);
    }
  }
  const reconciled = reconcileToolkitExclusions(nextSettings, agentDir, inventory.resources, state.resourceExclusions);
  nextSettings = reconciled.settings;
  const nextState = { version: 2, ownsPackage: resources.owned, mode,
    packageHash: state.packageHash ?? null, appendSystemHash: instructions.owned ? state.appendSystemHash ?? null : null,
    selectedPackages: options["skip-packages"] ? state.selectedPackages ?? [] : selectedIds,
    pendingPackages: state.pendingPackages ?? [], resourceExclusions: reconciled.exclusions, keptConflicts };
  const warnings = inventory.resources.filter((entry) => entry.existing.filter((path) => path.enabled).length > 1)
    .map((entry) => `Existing duplicate registrations for ${entry.id} were left unchanged.`);
  for (const entry of inventory.packages.filter((entry) => entry.registered && !entry.present &&
    !packages.some((operation) => operation.id === entry.id && ["install", "repair", "update"].includes(operation.action)))) {
    warnings.push(`Package ${entry.id} still needs repair; use --repair with its selection.`);
  }
  return { root, agentDir, mode, resources, instructions, packages, inventory, settings: nextSettings, state: nextState, warnings,
    conflicts: [resources, instructions, ...packages, ...uncertainResources].filter((entry) => entry.action === "conflict") };
}

/** Record only planned data paths; source hashes use the allowlist, never credentials or Git metadata. */
export function snapshotToolkitPlan({ root, agentDir, packageJson, inventory }) {
  const source = [...collectToolkitFiles(root, packageJson)].map(([path, file]) => [path, toolkitContentHash(file.content), file.mode]);
  const paths = ["settings.json", "toolkit-state.json", "APPEND_SYSTEM.md", TOOLKIT_PACKAGE_SOURCE].map((path) => join(agentDir, path));
  for (const resource of inventory.resources) for (const entry of resource.existing) paths.push(entry.path);
  return JSON.stringify({ source, preferences: toolkitPathHash(join(root, "preferences.json")), manifest: toolkitPathHash(join(root, "manifest.json")),
    instructions: toolkitPathHash(join(root, "dotfiles/APPEND_SYSTEM.md")), paths: [...new Set(paths)].map((path) => [path, toolkitPathHash(path)]) });
}

/** Produce a bounded receipt with actions and paths, never the contents of user settings. */
export function summarizeToolkitPlan(plan) {
  return { directory: plan.agentDir, mode: plan.mode,
    actions: [plan.resources, plan.instructions, ...plan.packages].map((entry) => ({ id: entry.id, action: entry.action, path: entry.target ?? entry.installedPath, source: entry.source })),
    retained: plan.inventory.resources.filter((entry) => entry.existing.length).map((entry) => ({ id: entry.id, paths: entry.existing.map((path) => path.path) })),
    conflicts: plan.conflicts.map((entry) => ({ id: entry.id, message: entry.conflictMessage })),
    warnings: [...plan.warnings, ...(plan.state.pendingPackages.length ? [`Incomplete package operations: ${plan.state.pendingPackages.join(", ")}. Rerun with --reuse-selection.`] : [])] };
}
