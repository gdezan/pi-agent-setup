import { spawn } from "node:child_process";

/** Cancellation is not consent; callers retain completed changes and pending-operation receipts. */
export class ToolkitCancelled extends Error {
  constructor() {
    super("Toolkit setup cancelled");
  }
}

/** Run commands and terminate the Unix process group before releasing caller locks. */
export function runToolkitCommand({
  command,
  args,
  cwd,
  env = process.env,
  signal,
  onOutput = () => {},
}) {
  if (signal?.aborted) return Promise.reject(new ToolkitCancelled());
  // npm and Pi are normally .cmd shims on Windows, which cannot be spawned directly.
  // Limit cmd.exe to these known commands and safe arguments: batch files reparse
  // their arguments, so general-purpose shell escaping is not sufficient here.
  let executable = command;
  let commandArgs = args;
  let windowsVerbatimArguments = false;
  if (process.platform === "win32" && (command === "npm" || command === "pi")) {
    if (args.some((arg) => !/^[a-zA-Z0-9_./:@=+,~-]+$/.test(arg))) {
      return Promise.reject(new Error(`Unsafe argument for Windows ${command} command`));
    }
    executable = env.ComSpec || env.COMSPEC || "cmd.exe";
    commandArgs = ["/d", "/s", "/c", `"${command}.cmd ${args.map((arg) => `"${arg}"`).join(" ")}"`];
    windowsVerbatimArguments = true;
  }
  return new Promise((accept, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, commandArgs, {
      cwd,
      env,
      detached: grouped,
      windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    let failure;
    let timer;
    const terminate = (kind) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    };
    const abort = () => {
      terminate("SIGTERM");
      timer = setTimeout(() => terminate("SIGKILL"), 3000);
      timer.unref();
    };
    const collect = (chunk) => {
      tail = (tail + chunk.toString()).slice(-16000);
      onOutput(chunk.toString());
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      failure = error;
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("close", (status, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        terminate("SIGKILL");
        reject(new ToolkitCancelled());
        return;
      }
      if (failure || status !== 0)
        reject(
          new Error(
            `Toolkit command failed: ${command} (${failure?.message ?? `exit ${status}, signal ${childSignal ?? "none"}`})\n${tail.trim()}`,
          ),
        );
      else accept();
    });
  });
}
