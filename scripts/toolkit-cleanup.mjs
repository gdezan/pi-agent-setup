import { existsSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { toolkitPackageIdentity, toolkitPackageSource } from "./toolkit-settings.mjs";
import { toolkitPathStat } from "./toolkit-files.mjs";

/** Guard a permanent delete against a configured local path escaping Pi's conventional resource roots. */
export function assertToolkitCleanupPath(agentDir, path) {
  const parent = dirname(path);
  if (!["extensions", "skills", "local-packages"].some((kind) => parent === join(agentDir, kind)) ||
      toolkitPathStat(parent)?.isSymbolicLink()) {
    throw new Error(`Unsafe toolkit cleanup path: ${path}`);
  }
}

/** List unselected configured packages and unrelated loose Pi resources, excluding managed legacy paths. */
export function listToolkitCleanupCandidates({ agentDir, settings, manifest, selectedIds }) {
  const selectedSources = new Set(manifest.packages.filter((entry) => selectedIds.includes(entry.id))
    .map((entry) => toolkitPackageIdentity(entry.source, agentDir)));
  const ownPackage = toolkitPackageIdentity("toolkits/pi-agent-setup", agentDir);
  const legacy = new Set(manifest.resources.flatMap((entry) => entry.legacy.map((path) =>
    path.endsWith("/index.ts") || path.endsWith("/index.js") || path.endsWith("/SKILL.md") ? path.slice(0, path.lastIndexOf("/")) : path)));
  const candidates = [];
  const packagePaths = new Set();
  const resourceParents = new Set(["extensions", "skills", "local-packages"].map((kind) => join(agentDir, kind)));
  for (const entry of settings.packages ?? []) {
    const source = toolkitPackageSource(entry);
    const identity = toolkitPackageIdentity(source, agentDir);
    if (identity === ownPackage || selectedSources.has(identity)) continue;
    const local = !/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(source);
    const path = local ? identity.slice("local:".length) : undefined;
    if (path) packagePaths.add(path);
    if (local && (!resourceParents.has(dirname(path)) || toolkitPathStat(dirname(path))?.isSymbolicLink() ||
      legacy.has(relative(agentDir, path)))) continue;
    candidates.push({ id: `package:${source}`, kind: "package", label: source, source, path });
  }
  for (const kind of ["extensions", "skills", "local-packages"]) {
    const directory = join(agentDir, kind);
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(agentDir, path);
      if (legacy.has(relativePath) || packagePaths.has(path)) continue;
      const stat = lstatSync(path);
      const recognized = kind === "extensions" ?
        stat.isFile() && /\.[cm]?[jt]s$/.test(name) || stat.isDirectory() && (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js"))) :
        kind === "skills" ? stat.isDirectory() && existsSync(join(path, "SKILL.md")) :
          stat.isDirectory() && existsSync(join(path, "package.json"));
      if (recognized) candidates.push({ id: `resource:${relativePath}`, kind: "resource", label: relativePath, path });
    }
  }
  return candidates;
}
