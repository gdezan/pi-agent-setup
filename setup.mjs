#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runToolkitSetup } from "./scripts/toolkit-setup.mjs";

try {
  await runToolkitSetup({ root: dirname(fileURLToPath(import.meta.url)), argv: process.argv.slice(2) });
} catch (error) {
  console.error(`Toolkit setup failed: ${error.message}`);
  process.exitCode = 1;
}
