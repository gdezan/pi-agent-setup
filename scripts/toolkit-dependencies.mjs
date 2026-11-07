import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runToolkitCommand, ToolkitCancelled } from "./toolkit-command.mjs";

const PENDING = "Pi setup dependency installation incomplete.\n";

function runtimeLockHash(root) {
  return createHash("sha256")
    .update(`${process.platform}:${process.arch}:${process.versions.modules}:`)
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
}

function dependenciesMissing(root, includeDev) {
  if (existsSync(join(root, ".toolkit-dependencies.pending"))) return true;
  if (!includeDev) {
    const stamp = join(root, "node_modules/.toolkit-lock-hash");
    if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== runtimeLockHash(root)) return true;
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return Object.entries({
    ...packageJson.dependencies,
    ...(includeDev ? packageJson.devDependencies : {}),
  }).some(([name, version]) => {
    try {
      return (
        JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"))
          ?.version !== version
      );
    } catch {
      return true;
    }
  });
}

function extensionDependencyRoots({ root, resources, selectedExtensions }) {
  return [
    ...new Set(
      resources
        .filter(
          (resource) => resource.kind === "extensions" && selectedExtensions.includes(resource.id),
        )
        .map((resource) => dirname(join(root, resource.path))),
    ),
  ].filter(
    (directory) =>
      existsSync(join(directory, "package.json")) &&
      Object.keys(
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dependencies ?? {},
      ).length,
  );
}

export function toolkitExtensionDependenciesMissing(options) {
  return extensionDependencyRoots(options).some((root) => dependenciesMissing(root, false));
}

export async function installToolkitExtensionDependencies(
  options,
  installCommand = runToolkitCommand,
) {
  for (const root of extensionDependencyRoots(options)) {
    await ensureToolkitDependencies(root, { ...options, includeDev: false }, installCommand);
  }
}

/** Preserve a retry marker when a locked dependency installation is interrupted. */
export async function ensureToolkitDependencies(
  root,
  { dryRun, signal, includeDev = true, onOutput = () => {} },
  installCommand = runToolkitCommand,
) {
  const lock = join(root, ".toolkit-dependencies.lock");
  const pending = join(root, ".toolkit-dependencies.pending");
  for (const path of [lock, pending]) {
    try {
      if (!lstatSync(path).isFile()) throw new Error(`Unsafe toolkit dependency marker: ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const locked = () =>
    new Error(
      `Toolkit dependencies are locked: ${lock}. Wait for the other setup; remove this file only if no setup is running.`,
    );
  if (existsSync(lock)) {
    let stale = false;
    try {
      const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid lock PID");
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") stale = true;
        else throw error;
      }
    } catch (error) {
      if (!stale) throw locked();
    }
    if (stale) rmSync(lock);
  }
  const retry = existsSync(pending);
  if (retry && readFileSync(pending, "utf8") !== PENDING)
    throw new Error(`Unrecognized toolkit dependency marker: ${pending}`);
  const missing = dependenciesMissing(root, includeDev);
  if (!missing && !retry) return;
  if (dryRun)
    throw new Error(
      retry
        ? "Toolkit dependency installation was interrupted. Run setup normally to retry, then repeat the dry run."
        : "Toolkit dependencies are missing. Run npm ci --ignore-scripts --legacy-peer-deps --include=dev in the checkout, then repeat the dry run.",
    );
  if (signal?.aborted) throw new ToolkitCancelled();
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw locked();
    throw error;
  }
  try {
    if (!retry) writeFileSync(pending, PENDING, { flag: "wx", mode: 0o600 });
    const lockHash = includeDev ? undefined : runtimeLockHash(root);
    onOutput(
      `Installing locked ${includeDev ? "setup" : "extension runtime"} dependencies in ${root}…\n`,
    );
    await installCommand({
      command: "npm",
      args: [
        "ci",
        "--ignore-scripts",
        "--legacy-peer-deps",
        includeDev ? "--include=dev" : "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      cwd: root,
      signal,
      onOutput,
    });
    if (!includeDev)
      writeFileSync(join(root, "node_modules/.toolkit-lock-hash"), lockHash, { mode: 0o600 });
    rmSync(pending);
  } finally {
    rmSync(lock, { force: true });
  }
}
