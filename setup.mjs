#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { parseToolkitOptions, TOOLKIT_HELP } from "./scripts/toolkit-options.mjs";
import { ToolkitCancelled } from "./scripts/toolkit-command.mjs";
import { ensureToolkitDependencies } from "./scripts/toolkit-dependencies.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const controller = new AbortController();
const abort = () => controller.abort();
let outputError;
process.stdout.on("error", (error) => {
  outputError = error;
  process.exitCode = error.code === "EPIPE" ? 0 : 1;
  abort();
});
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
let options;
try {
  options = parseToolkitOptions(process.argv.slice(2));
  if (options["no-color"] || options.json || process.env.NO_COLOR || !process.stdout.isTTY) {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
  }
  if (options.help) {
    process.stdout.write(
      options.json ? `${JSON.stringify({ help: TOOLKIT_HELP })}\n` : TOOLKIT_HELP,
    );
  } else if (options["list-packages"]) {
    const { packages } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ packages })}\n`
        : packages
            .map((entry) => `${entry.id}: ${entry.source}\n  ${entry.description}\n`)
            .join(""),
    );
  } else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19))
      throw new Error("Toolkit requires Node.js 22.19 or newer");
    // Read-only npm root lookups during inventory must not create npm logs or check for updates.
    process.env.npm_config_logs_max = "0";
    process.env.npm_config_update_notifier = "false";
    await ensureToolkitDependencies(root, {
      dryRun: options["dry-run"],
      signal: controller.signal,
      onOutput: (text) => process.stderr.write(text),
    });
    const { runToolkitSetup } = await import("./scripts/toolkit-setup.mjs");
    await runToolkitSetup({ root, argv: process.argv.slice(2), signal: controller.signal });
  }
} catch (error) {
  const message = stripVTControlCharacters(String(error?.message ?? error));
  const cancelled = error instanceof ToolkitCancelled;
  if (!outputError) {
    if (options?.json || process.argv.includes("--json"))
      process.stdout.write(
        `${JSON.stringify({ status: cancelled ? "cancelled" : "error", message })}\n`,
      );
    else
      console.error(
        message.startsWith("Toolkit setup cancelled")
          ? message
          : `Toolkit setup failed: ${message}`,
      );
    process.exitCode = cancelled ? 130 : 1;
  }
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
