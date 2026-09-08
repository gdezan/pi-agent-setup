import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runToolkitCommand, ToolkitCancelled } from "./toolkit-command.mjs";

const PENDING = "Pi setup dependency installation incomplete.\n";

/** Bootstrap the locked checkout dependencies once; preserve a retry marker if npm is interrupted. */
export async function ensureToolkitDependencies(root, { dryRun, signal, onOutput = () => {} }) {
  const lock = join(root, ".toolkit-dependencies.lock");
  const pending = join(root, ".toolkit-dependencies.pending");
  for (const path of [lock, pending]) {
    try { if (!lstatSync(path).isFile()) throw new Error(`Unsafe toolkit dependency marker: ${path}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const locked = () => new Error(`Toolkit dependencies are locked: ${lock}. Wait for the other setup; remove this file only if no setup is running.`);
  if (existsSync(lock)) {
    let stale = false;
    try {
      const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid lock PID");
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") stale = true; else throw error; }
    } catch (error) {
      if (!stale) throw locked();
    }
    if (stale) rmSync(lock);
  }
  const retry = existsSync(pending);
  if (retry && readFileSync(pending, "utf8") !== PENDING) throw new Error(`Unrecognized toolkit dependency marker: ${pending}`);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missing = Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies }).some(([name, version]) => {
    try { return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"))?.version !== version; }
    catch { return true; }
  });
  if (!missing && !retry) return;
  if (dryRun) throw new Error(retry ? "Toolkit dependency installation was interrupted. Run setup normally to retry, then repeat the dry run." :
    "Toolkit dependencies are missing. Run npm ci --ignore-scripts --legacy-peer-deps --include=dev in the checkout, then repeat the dry run.");
  if (signal?.aborted) throw new ToolkitCancelled();
  try { writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code === "EEXIST") throw locked(); throw error; }
  try {
    if (!retry) writeFileSync(pending, PENDING, { flag: "wx", mode: 0o600 });
    onOutput("Installing locked setup dependencies in this checkout…\n");
    await runToolkitCommand({ command: "npm", args: ["ci", "--ignore-scripts", "--legacy-peer-deps", "--include=dev", "--no-audit", "--no-fund"],
      cwd: root, signal, onOutput });
    rmSync(pending);
  } finally { rmSync(lock, { force: true }); }
}
