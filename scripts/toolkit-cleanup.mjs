import { existsSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  readToolkitJson,
  toolkitPackageIdentity,
  toolkitPackageSource,
} from "./toolkit-settings.mjs";
import { toolkitPathStat } from "./toolkit-files.mjs";

export const TOOLKIT_KEEP_FILE = "toolkit-keep.json";
const resourcePath = (agentDir, path) => relative(agentDir, path).split(sep).join("/");
const PROTECTED_TOOLKIT_PATHS = new Set([
  "extensions/herdr-agent-state.ts",
  "extensions/atuin.ts",
  "extensions/scoutr-stream.ts",
]);

/**
 * Read the machine-local keep list.
 *
 * Setup offers to delete every Pi resource it does not own, which is right for
 * packages and stale toolkit copies but wrong for anything a person hand-maintains
 * in the agent directory: herdr rewrites its own integration file there, and
 * machine-local extensions read gitignored notes. Those are load-bearing and are
 * never the toolkit's to remove, so each machine lists them once instead of
 * declining the same prompt on every run.
 *
 * An entry is a path relative to the agent directory. A directory entry keeps
 * everything beneath it. Herdr agent state, Atuin, and Scoutr Stream are protected independently of this list.
 */
export function readToolkitKeep(agentDir) {
  const path = join(agentDir, TOOLKIT_KEEP_FILE);
  const keep = readToolkitJson(path, {}).keep;
  if (keep === undefined) return [];
  if (
    !Array.isArray(keep) ||
    keep.some(
      (entry) =>
        typeof entry !== "string" || !entry || entry.startsWith("/") || entry.includes(".."),
    )
  ) {
    throw new Error(`Invalid toolkit keep list: ${path}`);
  }
  return keep.map((entry) => entry.replace(/\/+$/, ""));
}

/** True when a candidate path is covered by a keep entry, exactly or as a directory prefix. */
export function isKeptToolkitPath(relativePath, keep) {
  return keep.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

/** Guard a permanent delete against a configured local path escaping Pi's conventional resource roots. */
export function assertToolkitCleanupPath(agentDir, path) {
  const parent = dirname(path);
  if (
    PROTECTED_TOOLKIT_PATHS.has(resourcePath(agentDir, path)) ||
    !["extensions", "skills", "local-packages"].some((kind) => parent === join(agentDir, kind)) ||
    toolkitPathStat(parent)?.isSymbolicLink()
  ) {
    throw new Error(`Unsafe toolkit cleanup path: ${path}`);
  }
}

/**
 * List unselected configured packages and unrelated loose Pi resources.
 *
 * Excludes protected extensions, managed legacy paths, and anything on the machine-local keep list.
 * Returns the kept paths that actually matched a candidate alongside the
 * candidates, so the caller can say what it honoured instead of silently
 * dropping entries the person expected to see.
 */
export function listToolkitCleanupCandidates({
  agentDir,
  settings,
  manifest,
  selectedIds,
  keep = [],
}) {
  const selectedSources = new Set(
    manifest.packages
      .filter((entry) => selectedIds.includes(entry.id))
      .map((entry) => toolkitPackageIdentity(entry.source, agentDir)),
  );
  const ownPackage = toolkitPackageIdentity("toolkits/pi-agent-setup", agentDir);
  const legacy = new Set(
    manifest.resources.flatMap((entry) =>
      entry.legacy.map((path) =>
        path.endsWith("/index.ts") || path.endsWith("/index.js") || path.endsWith("/SKILL.md")
          ? path.slice(0, path.lastIndexOf("/"))
          : path,
      ),
    ),
  );
  const candidates = [];
  const honoured = new Set();
  const packagePaths = new Set();
  const resourceParents = new Set(
    ["extensions", "skills", "local-packages"].map((kind) => join(agentDir, kind)),
  );
  for (const entry of settings.packages ?? []) {
    const source = toolkitPackageSource(entry);
    const identity = toolkitPackageIdentity(source, agentDir);
    if (identity === ownPackage || selectedSources.has(identity)) continue;
    const local = !/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(source);
    const path = local ? identity.slice("local:".length) : undefined;
    if (path) packagePaths.add(path);
    if (
      local &&
      (!resourceParents.has(dirname(path)) ||
        toolkitPathStat(dirname(path))?.isSymbolicLink() ||
        legacy.has(resourcePath(agentDir, path)))
    )
      continue;
    // A keep entry is an agent-directory path, so it can only address a local package.
    if (path && isKeptToolkitPath(resourcePath(agentDir, path), keep)) {
      honoured.add(resourcePath(agentDir, path));
      continue;
    }
    if (path && PROTECTED_TOOLKIT_PATHS.has(resourcePath(agentDir, path))) continue;
    candidates.push({ id: `package:${source}`, kind: "package", label: source, source, path });
  }
  for (const kind of ["extensions", "skills", "local-packages"]) {
    const directory = join(agentDir, kind);
    if (
      !existsSync(directory) ||
      lstatSync(directory).isSymbolicLink() ||
      !lstatSync(directory).isDirectory()
    )
      continue;
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = resourcePath(agentDir, path);
      if (legacy.has(relativePath) || packagePaths.has(path)) continue;
      if (isKeptToolkitPath(relativePath, keep)) {
        honoured.add(relativePath);
        continue;
      }
      if (PROTECTED_TOOLKIT_PATHS.has(relativePath)) continue;
      const stat = lstatSync(path);
      const recognized =
        kind === "extensions"
          ? (stat.isFile() && /\.[cm]?[jt]s$/.test(name)) ||
            (stat.isDirectory() &&
              (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js"))))
          : kind === "skills"
            ? stat.isDirectory() && existsSync(join(path, "SKILL.md"))
            : stat.isDirectory() && existsSync(join(path, "package.json"));
      if (recognized)
        candidates.push({
          id: `resource:${relativePath}`,
          kind: "resource",
          label: relativePath,
          path,
        });
    }
  }
  return { candidates, kept: [...honoured].sort() };
}
