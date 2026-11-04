import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SKIP_SOURCE_ENTRIES = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

/** Inspect an install path without following a possibly dangling symlink. */
export function toolkitPathStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  );
}

function canonicalPath(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return resolve(canonicalPath(parent), relative(parent, absolute));
}

/** Reject source/runtime overlap, including paths hidden behind parent symlinks. */
export function resolveToolkitAgentDir(root, requested) {
  if (/[\x00-\x1f\x7f]/.test(requested))
    throw new Error("Unsafe toolkit destination: control characters are not supported");
  const source = realpathSync(root);
  const agentDir = canonicalPath(requested);
  if (agentDir === dirname(agentDir) || isInside(source, agentDir) || isInside(agentDir, source)) {
    throw new Error(
      `Unsafe toolkit destination: source and agent directory must be separate (${agentDir})`,
    );
  }
  const stat = toolkitPathStat(agentDir);
  if (stat && !stat.isDirectory()) throw new Error(`Invalid toolkit agent directory: ${agentDir}`);
  return agentDir;
}

/** Keep installer writes inside the agent directory; only the two deliberate resource links are allowed. */
export function assertToolkitWritePaths(agentDir) {
  for (const name of [
    "toolkits",
    "toolkit-backups",
    "settings.json",
    "toolkit-state.json",
    "toolkit-setup.lock",
  ]) {
    const path = join(agentDir, name);
    const stat = toolkitPathStat(path);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing toolkit write through symlink: ${path}`);
    const directory = name === "toolkits" || name === "toolkit-backups";
    if (stat && (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Invalid toolkit write destination: ${path}`);
    }
  }
}

/** Collect only package-declared source files, never runtime state or dependency installations. */
export function collectToolkitFiles(root, packageJson) {
  const files = new Map();
  function collect(path) {
    const absolute = resolve(root, path);
    if (
      !isInside(root, absolute) ||
      absolute === root ||
      !isInside(realpathSync(root), realpathSync(absolute))
    ) {
      throw new Error(`Unsafe toolkit source path: ${path}`);
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unsupported toolkit source symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        if (!SKIP_SOURCE_ENTRIES.has(entry) && !entry.endsWith(".pyc")) collect(join(path, entry));
      }
    } else if (stat.isFile()) {
      files.set(path, { content: readFileSync(absolute), mode: stat.mode & 0o777 });
    } else throw new Error(`Unsupported toolkit source file: ${path}`);
  }
  if (!Array.isArray(packageJson.files)) throw new Error("Missing toolkit package files allowlist");
  collect("package.json");
  for (const path of packageJson.files) collect(path);
  for (const [kind, paths] of Object.entries(packageJson.pi ?? {})) {
    if (!["extensions", "skills", "prompts", "themes"].includes(kind) || !Array.isArray(paths)) {
      throw new Error(`Invalid toolkit Pi resource type: ${kind}`);
    }
    for (const path of paths) {
      const absolute = resolve(root, path);
      if (!isInside(root, absolute) || !existsSync(absolute))
        throw new Error(`Missing toolkit Pi resource: ${path}`);
      const resource = relative(root, absolute);
      if (![...files.keys()].some((name) => name === resource || isInside(resource, name))) {
        throw new Error(`Unpackaged toolkit Pi resource: ${path}`);
      }
    }
  }
  return files;
}

/** Hash a source-owned instruction file to distinguish updates from local edits. */
export function toolkitContentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Compare a deployed package with its allowlisted source files, including additions and removals. */
export function toolkitCopyMatches(target, files) {
  if (!toolkitPathStat(target)?.isDirectory()) return false;
  const deployed = [];
  function walk(path) {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!walk(full)) return false;
      } else if (stat.isFile()) deployed.push(relative(target, full));
      else return false;
    }
    return true;
  }
  if (!walk(target) || deployed.length !== files.size) return false;
  return deployed.every((name) => {
    const source = files.get(name);
    const path = join(target, name);
    return (
      source &&
      readFileSync(path).equals(source.content) &&
      (lstatSync(path).mode & 0o111) === (source.mode & 0o111)
    );
  });
}

/** Recognize only the exact link managed by this checkout, without following its target. */
export function toolkitLinkMatches(target, source) {
  return (
    toolkitPathStat(target)?.isSymbolicLink() &&
    resolve(dirname(target), readlinkSync(target)) === resolve(source)
  );
}

/** Replace one owned path using a staged write and a recoverable, private backup. */
export function replaceToolkitPath({ target, backupRoot, backupName, create }) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = join(dirname(target), `.toolkit-stage-${randomUUID()}`);
  const previous = toolkitPathStat(target);
  let backup = join(backupRoot, backupName);
  if (toolkitPathStat(backup)) backup += `-${randomUUID()}`;
  let moved = false;
  try {
    create(staging);
    if (previous) {
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      renameSync(target, backup);
      moved = true;
    }
    renameSync(staging, target);
  } catch (error) {
    if (moved && !toolkitPathStat(target)) renameSync(backup, target);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Deploy source files as a copy or a single link; keep the registered package path stable across modes. */
export function deployToolkitPackage({ root, target, files, link, backupRoot }) {
  if (link ? toolkitLinkMatches(target, root) : toolkitCopyMatches(target, files)) return false;
  replaceToolkitPath({
    target,
    backupRoot,
    backupName: "package",
    create(staging) {
      if (link) symlinkSync(root, staging, process.platform === "win32" ? "junction" : "dir");
      else {
        mkdirSync(staging, { mode: 0o700 });
        for (const [name, file] of files) {
          const path = join(staging, name);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, file.content, { mode: file.mode });
        }
      }
    },
  });
  return true;
}

/** Archive a manifest-listed legacy resource without following a link or deleting its contents. */
export function archiveToolkitLegacyPath({ agentDir, target, backupRoot, legacy }) {
  if (!isInside(agentDir, target) || !toolkitPathStat(target))
    throw new Error(`Invalid toolkit legacy path: ${target}`);
  let parent = dirname(target);
  while (parent !== agentDir) {
    if (toolkitPathStat(parent)?.isSymbolicLink())
      throw new Error(`Refusing toolkit legacy move through symlink: ${parent}`);
    parent = dirname(parent);
  }
  const backup = join(
    backupRoot,
    "legacy",
    toolkitPathStat(target).isDirectory() ? dirname(legacy) : legacy,
  );
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  renameSync(target, backup);
}

/** Fingerprint deployed files and links without traversing symlinks; missing paths have a null fingerprint. */
export function toolkitPathHash(path) {
  const stat = toolkitPathStat(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return toolkitContentHash(`link:${readlinkSync(path)}`);
  if (stat.isFile())
    return toolkitContentHash(
      Buffer.concat([Buffer.from(`file:${stat.mode & 0o111}:`), readFileSync(path)]),
    );
  if (!stat.isDirectory()) throw new Error(`Unsupported toolkit destination file: ${path}`);
  return toolkitContentHash(
    JSON.stringify(
      readdirSync(path)
        .sort()
        .map((name) => [name, toolkitPathHash(join(path, name))]),
    ),
  );
}

/** Write JSON atomically and back up the previous file, preserving byte-identical files on reruns. */
export function writeToolkitJson({ path, value, backupRoot, backupName }) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (toolkitPathStat(path)?.isFile()) {
    const existing = readFileSync(path, "utf8");
    if (
      existing === content ||
      JSON.stringify(JSON.parse(existing.replace(/^\uFEFF/, ""))) === JSON.stringify(value)
    )
      return;
  }
  replaceToolkitPath({
    target: path,
    backupRoot,
    backupName,
    create: (staging) => writeFileSync(staging, content, { mode: 0o600 }),
  });
}
