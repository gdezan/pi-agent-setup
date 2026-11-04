import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolkitContentHash, toolkitLinkMatches, toolkitPathStat } from "./toolkit-files.mjs";

const BEGIN = "<!-- BEGIN pi-agent-setup:shared -->";
const END = "<!-- END pi-agent-setup:shared -->";
const LOCAL =
  "\n\n## Machine-specific instructions\n\nThese instructions supplement the shared rules above.\nWhere they conflict, follow these machine-specific rules.\n\n";

function splitInstructions(content) {
  const begins = content.split(BEGIN).length - 1;
  const ends = content.split(END).length - 1;
  if (!begins && !ends) return undefined;
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  const standalone = (index, marker) =>
    (index === 0 || content[index - 1] === "\n") &&
    /^(?:\r?\n|$)/.test(content.slice(index + marker.length));
  if (
    begins !== 1 ||
    ends !== 1 ||
    end <= start ||
    !standalone(start, BEGIN) ||
    !standalone(end, END)
  ) {
    throw new Error(
      "Invalid system instruction markers: expected one ordered pair of standalone pi-agent-setup:shared comments. Repair them before rerunning setup.",
    );
  }
  return {
    before: content.slice(0, start),
    block: content.slice(start, end + END.length),
    after: content.slice(end + END.length),
  };
}

export function planToolkitInstructions({ root, agentDir, state, replaceConfig }) {
  const source = join(root, "dotfiles/APPEND_SYSTEM.md");
  const target = join(agentDir, "APPEND_SYSTEM.md");
  const shared = readFileSync(source, "utf8");
  if (shared.includes(BEGIN) || shared.includes(END))
    throw new Error("Shared instruction source must not contain managed instruction markers.");
  const block = `${BEGIN}\n${shared}${shared.endsWith("\n") ? "" : "\n"}${END}`;
  const blockHash = toolkitContentHash(block);
  const stat = toolkitPathStat(target);
  const linked = toolkitLinkMatches(target, source);
  if (stat && !stat.isFile() && !linked) {
    throw new Error(
      `Invalid toolkit instruction destination: ${target}. Use a regular file or the toolkit's source link.`,
    );
  }
  const existing = stat ? readFileSync(target, "utf8") : "";
  const parts = splitInstructions(existing);
  const legacyOwned =
    linked ||
    (!parts &&
      Boolean(state.appendSystemHash && state.appendSystemHash === toolkitContentHash(existing)));
  const matches = Boolean(parts && parts.block === block);
  const baseline = parts
    ? state.appendSystemBlockHash === toolkitContentHash(parts.block)
    : legacyOwned;
  const safeMigration = !parts && (legacyOwned || existing === shared || !existing);
  const content = Buffer.from(
    parts ? parts.before + block + parts.after : block + LOCAL + (safeMigration ? "" : existing),
  );
  return {
    id: "instructions",
    target,
    source,
    content,
    blockHash,
    action: !stat
      ? "install"
      : matches
        ? "keep"
        : baseline || safeMigration || replaceConfig
          ? "update"
          : "conflict",
    owned: Boolean(!stat || matches || baseline || safeMigration || replaceConfig),
    message: "System instructions",
    conflictMessage: parts
      ? "The shared instruction block has local edits or no recorded baseline. Updating it preserves everything outside the markers."
      : "Existing instructions have no shared markers. Adding the shared block preserves the existing text as machine-specific instructions; review it for duplicate or conflicting rules.",
  };
}
