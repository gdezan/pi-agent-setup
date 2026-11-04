import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { satisfies, validRange } from "semver";
import {
  findToolkitPackage,
  readToolkitJson,
  toolkitPackageIdentity,
  toolkitPackageSource,
} from "./toolkit-settings.mjs";
import { toolkitContentHash, toolkitPathHash } from "./toolkit-files.mjs";

/** Stable package registration shared by inventory, planning, and deployment. */
export const TOOLKIT_PACKAGE_SOURCE = "toolkits/pi-agent-setup";

function resourceFile(path, kind) {
  if (!existsSync(path)) return path;
  if (!statSync(path).isDirectory()) return path;
  const names = kind === "skills" ? ["SKILL.md"] : ["index.ts", "index.js"];
  return names.map((name) => join(path, name)).find(existsSync) ?? path;
}

function canonicalResource(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function readPackageName(path) {
  const file = join(path, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    return readToolkitJson(file).name;
  } catch {
    return undefined;
  }
}

/** Validate explicit legacy resource identities; filenames alone never identify arbitrary extensions. */
export function validateToolkitResources(manifest, files) {
  if (!Array.isArray(manifest.resources))
    throw new Error("Missing toolkit resource catalog: manifest.resources must be an array");
  const ids = new Set();
  for (const resource of manifest.resources) {
    const safePath = (path) =>
      typeof path === "string" &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes("..") &&
      !/[\x00-\x1f]/.test(path);
    if (
      !/^[a-z][a-z0-9-]*$/.test(resource.id ?? "") ||
      ids.has(resource.id) ||
      !["extensions", "skills"].includes(resource.kind) ||
      !safePath(resource.path) ||
      !files.has(resource.path) ||
      !Array.isArray(resource.legacy) ||
      !resource.legacy.every(safePath) ||
      (resource.packageName !== undefined && typeof resource.packageName !== "string")
    ) {
      throw new Error(
        "Invalid toolkit resource catalog: expected unique IDs and packaged resource paths",
      );
    }
    ids.add(resource.id);
  }
  return manifest.resources;
}

/** Inspect Pi's global load paths without importing extensions, installing packages, or reading project settings. */
export async function inspectToolkitInventory({ root, agentDir, settings, manifest }) {
  const packages = [...(settings.packages ?? [])];
  for (const entry of manifest.packages) {
    if (!findToolkitPackage(packages, entry.source, agentDir)) packages.push(entry.source);
  }
  // A nonexistent cwd prevents project auto-discovery; in-memory settings never persist anything.
  const manager = new DefaultPackageManager({
    agentDir,
    cwd: join(agentDir, `.toolkit-inspect-${randomUUID()}`),
    settingsManager: SettingsManager.inMemory({ ...settings, packages }),
  });
  const missing = new Set();
  const paths = await manager.resolve(async (source) => {
    missing.add(source);
    return "skip";
  });
  const packageStates = manifest.packages.map((entry) => {
    const registered = findToolkitPackage(settings.packages ?? [], entry.source, agentDir);
    const source = registered ? toolkitPackageSource(registered) : entry.source;
    const installedPath = manager.getInstalledPath(source, "user");
    let present = Boolean(installedPath) && !missing.has(source);
    if (present && source.startsWith("npm:")) {
      // Pi's offline resolver skips the missing-source callback, even for a version mismatch.
      const spec = source.slice(4);
      const at = spec.indexOf("@", 1);
      const range = at < 0 ? null : validRange(spec.slice(at + 1));
      try {
        const version = readToolkitJson(join(installedPath, "package.json")).version;
        present = typeof version === "string" && (!range || satisfies(version, range));
      } catch {
        present = false;
      }
    }
    return { ...entry, source, registered: Boolean(registered), installedPath, present };
  });
  const ownIdentity = toolkitPackageIdentity(TOOLKIT_PACKAGE_SOURCE, agentDir);
  const resources = manifest.resources.map((resource) => {
    const legacyPaths = resource.legacy.map((path) => canonicalResource(join(agentDir, path)));
    const sourceFile = join(root, resource.path);
    const sourceHash = toolkitContentHash(readFileSync(sourceFile));
    const uncertain = new Set();
    const existing = (paths[resource.kind] ?? [])
      .filter((entry) => {
        if (
          entry.metadata.origin === "package" &&
          (!findToolkitPackage(settings.packages ?? [], entry.metadata.source, agentDir) ||
            toolkitPackageIdentity(entry.metadata.source, agentDir) === ownIdentity)
        )
          return false;
        const path = resourceFile(entry.path, resource.kind);
        if (!existsSync(path) || !statSync(path).isFile()) return false;
        if (
          legacyPaths.includes(canonicalResource(path)) ||
          canonicalResource(path) === canonicalResource(sourceFile)
        )
          return true;
        if (
          resource.packageName &&
          entry.metadata.baseDir &&
          readPackageName(entry.metadata.baseDir) === resource.packageName &&
          relative(entry.metadata.baseDir, path) === basename(resource.path)
        )
          return true;
        // Equal entrypoints can import different helpers. Ask before treating unknown copies as equivalent.
        if (toolkitContentHash(readFileSync(path)) === sourceHash) {
          uncertain.add(path);
          return true;
        }
        return false;
      })
      .map((entry) => ({
        path: resourceFile(entry.path, resource.kind),
        enabled: entry.enabled,
        source: entry.metadata.source,
        hash: toolkitPathHash(resourceFile(entry.path, resource.kind)),
        uncertain: uncertain.has(resourceFile(entry.path, resource.kind)),
      }));
    return { ...resource, existing };
  });
  return { packages: packageStates, resources, paths };
}

/** Verify intended resources have one global load path, while honoring disabled resources and reporting old duplicates separately. */
export async function verifyToolkitInventory(options, before) {
  const after = await inspectToolkitInventory(options);
  const ownIdentity = toolkitPackageIdentity(TOOLKIT_PACKAGE_SOURCE, options.agentDir);
  for (const resource of after.resources) {
    const bundlePath = canonicalResource(
      join(options.agentDir, TOOLKIT_PACKAGE_SOURCE, resource.path),
    );
    const isBundled = (entry) =>
      toolkitPackageIdentity(entry.metadata.source, options.agentDir) === ownIdentity &&
      canonicalResource(resourceFile(entry.path, resource.kind)) === bundlePath;
    const bundleEntries = after.paths[resource.kind].filter(isBundled);
    const bundled = bundleEntries.filter((entry) => entry.enabled);
    const retained = resource.existing.filter((entry) => entry.enabled);
    const previous = before.resources
      .find((entry) => entry.id === resource.id)
      .existing.filter((entry) => entry.enabled).length;
    const enabled = bundled.length + retained.length;
    if (enabled > 1) {
      const paths = [...bundled, ...retained].map((entry) => entry.path).join(", ");
      throw new Error(
        `Toolkit verification failed: ${resource.id} has multiple enabled load paths (${paths}). Disable one explicitly and rerun setup.`,
      );
    }
    const disabled = [...bundleEntries, ...resource.existing].some((entry) => !entry.enabled);
    if (!enabled && (previous > 0 || options.requireBundledResources) && !disabled) {
      throw new Error(
        `Toolkit verification failed: expected resource ${resource.id} has no enabled load path. Restore its files or disable it explicitly.`,
      );
    }
  }
  return after;
}
