import { parseArgs } from "node:util";

/** CLI help stays dependency-free, including in a fresh checkout. */
export const TOOLKIT_HELP = `Pi setup

Usage: node setup.mjs [options]

Inspect an existing setup, choose packages, and review changes before applying.
Working third-party packages, model choices, and version pins are kept.

  --agent-dir PATH       Destination (PI_CODING_AGENT_DIR or ~/.pi/agent)
  --link                 Link custom resources to this checkout
  --copy                 Copy resources (default on first run; mode is remembered)
  --packages ID,ID       Choose packages without the checklist
  --all-packages         Select every package in manifest.json
  --skip-packages        Update custom resources only; keep saved choices
  --extensions ID,ID     Enable selected bundled extensions
  --all-extensions       Enable every bundled extension
  --skip-extensions      Disable bundled extensions without removing their files
  --reuse-selection     Use this machine's saved choices
  --update-packages     Explicitly update selected packages, respecting pins
  --repair              Repair selected missing or incomplete packages
  --conflicts keep      Preserve conflicting files/packages without prompting
  --replace-resources   Back up and replace locally changed custom resources
  --replace-legacy      Back up differing manifest-listed legacy resources and activate bundled copies
  --replace-config      Back up and replace differing system instructions
  --apply-preferences   Apply shared preferences over existing values
  --dry-run             Show the plan without writes, downloads, or installs
  --non-interactive     Never prompt; saved choices or selection flags are required
  --yes                 Accept the plan, not unresolved conflicts or missing input
  --json                Emit one JSON receipt; implies --non-interactive
  --no-color            Disable color
  --list-packages       List package IDs and sources
  -h, --help            Show this help

Close Pi before applying changes. Recognized, identical legacy resources are moved to backups;
differing ones require a decision. Unrelated local resources are never moved.
The interactive cleanup checklist can permanently delete individually checked unselected packages
and unmanaged local resources; it is unchecked by default and unavailable noninteractively.
Kept conflict decisions are remembered until the source or destination changes.
Inspection and verification cover this global agent directory, not project overrides.
`;

/** Validate flags before loading dependencies, inspecting files, or changing anything. */
export function parseToolkitOptions(argv) {
  const { values } = parseArgs({ args: argv, options: {
    "agent-dir": { type: "string" }, link: { type: "boolean" }, copy: { type: "boolean" },
    packages: { type: "string" }, "all-packages": { type: "boolean" }, "skip-packages": { type: "boolean" },
    extensions: { type: "string" }, "all-extensions": { type: "boolean" }, "skip-extensions": { type: "boolean" },
    "reuse-selection": { type: "boolean" }, "update-packages": { type: "boolean" }, repair: { type: "boolean" },
    conflicts: { type: "string" }, "replace-resources": { type: "boolean" }, "replace-config": { type: "boolean" },
    "replace-legacy": { type: "boolean" }, "apply-preferences": { type: "boolean" }, "dry-run": { type: "boolean" }, "non-interactive": { type: "boolean" },
    yes: { type: "boolean" }, json: { type: "boolean" }, "no-color": { type: "boolean" },
    "list-packages": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (["packages", "all-packages", "skip-packages", "reuse-selection"].filter((key) => values[key] !== undefined).length > 1) {
    throw new Error("Conflicting toolkit package flags: choose only one selection mode");
  }
  if (["extensions", "all-extensions", "skip-extensions"].filter((key) => values[key] !== undefined).length > 1) {
    throw new Error("Conflicting toolkit extension flags: choose only one selection mode");
  }
  if (values.link && values.copy) throw new Error("Conflicting toolkit modes: choose --link or --copy");
  if (values.conflicts !== undefined && values.conflicts !== "keep") throw new Error("Invalid toolkit conflict policy: use --conflicts keep");
  return values;
}
