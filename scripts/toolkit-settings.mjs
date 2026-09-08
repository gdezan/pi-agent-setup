import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SHARED_PREFERENCE_KEYS = new Set([
  "theme", "hideThinkingBlock", "compaction", "autocompleteMaxVisible", "terminal", "tuiMode",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read a JSON object; malformed existing configuration must never become empty defaults. */
export function readToolkitJson(path, fallback) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
  const value = JSON.parse(text.replace(/^\uFEFF/, ""), (key, entry) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`Unsafe toolkit JSON key: ${key} in ${path}`);
    }
    return entry;
  });
  if (!isObject(value)) throw new Error(`Expected toolkit JSON object: ${path}`);
  return value;
}

/** Validate the package menu before any installation or configuration write. */
export function validateToolkitManifest(manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error("Invalid toolkit manifest: expected version 1 and a packages array");
  }
  const ids = new Set();
  const sources = new Set();
  for (const entry of manifest.packages) {
    if (!isObject(entry) || !/^[a-z][a-z0-9-]*$/.test(entry.id ?? "") ||
        typeof entry.source !== "string" || !/^(npm:|git:)/.test(entry.source) ||
        /\s/.test(entry.source) || typeof entry.description !== "string") {
      throw new Error("Invalid toolkit package: expected id, npm/git source, and description");
    }
    const identity = toolkitPackageIdentity(entry.source, "/");
    if (ids.has(entry.id) || sources.has(identity)) {
      throw new Error(`Duplicate toolkit package: ${entry.id}`);
    }
    ids.add(entry.id);
    sources.add(identity);
  }
  return manifest;
}

/** Normalize Pi package identities without discarding the installed entry's pins or filters. */
export function toolkitPackageIdentity(source, agentDir) {
  if (typeof source !== "string" || !source) throw new Error("Invalid Pi package source: expected a string");
  if (source.startsWith("npm:")) {
    const name = source.slice(4);
    const version = name.indexOf("@", 1);
    return `npm:${version < 0 ? name : name.slice(0, version)}`;
  }
  if (/^(git:|https?:\/\/|ssh:\/\/)/.test(source)) {
    let repo = source.replace(/^git:/, "").replace(/^(?:https?|ssh):\/\//, "")
      .replace(/^git@/, "").replace(/^([^/]+):/, "$1/");
    const ref = repo.indexOf("@", repo.indexOf("/") + 1);
    if (ref >= 0) repo = repo.slice(0, ref);
    return `git:${repo.replace(/\/$/, "").replace(/\.git$/, "")}`;
  }
  return `local:${resolve(agentDir, source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : source)}`;
}

/** Read a Pi package entry while preserving its object-form resource filters. */
export function toolkitPackageSource(entry) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string" || !source) throw new Error("Invalid Pi packages entry: missing source");
  return source;
}

/** Find an existing package by Pi identity, including pinned npm and Git entries. */
export function findToolkitPackage(packages, source, agentDir) {
  const identity = toolkitPackageIdentity(source, agentDir);
  return packages.find((entry) => toolkitPackageIdentity(toolkitPackageSource(entry), agentDir) === identity);
}

/** Seed shared preferences; overwriting existing values requires explicit opt-in. */
export function mergeToolkitPreferences(settings, preferences, overwrite = false) {
  for (const key of Object.keys(preferences)) {
    if (!SHARED_PREFERENCE_KEYS.has(key)) throw new Error(`Unmanaged toolkit preference: ${key}`);
  }
  function merge(current, defaults) {
    const result = structuredClone(current);
    for (const [key, value] of Object.entries(defaults)) {
      if (isObject(value) && isObject(result[key])) result[key] = merge(result[key], value);
      else if (!(key in result) || overwrite) result[key] = structuredClone(value);
    }
    return result;
  }
  return merge(settings, preferences);
}

/** Register the owned package without replacing any machine-local package entries. */
export function registerToolkitPackage(settings, source, agentDir) {
  const result = structuredClone(settings);
  if (result.packages !== undefined && !Array.isArray(result.packages)) {
    throw new Error("Invalid Pi packages setting: expected an array");
  }
  const packages = result.packages ?? [];
  if (!findToolkitPackage(packages, source, agentDir)) result.packages = [...packages, source];
  return result;
}
