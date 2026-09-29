import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createTwoFilesPatch } from "diff";
import { toolkitPathStat } from "./toolkit-files.mjs";
import { summarizeToolkitPlan } from "./toolkit-plan.mjs";
import { ToolkitCancelled } from "./toolkit-command.mjs";

const clean = (value) => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Keep terminal rendering outside the plan/apply engine; JSON and non-TTY paths never use prompts. */
export async function createToolkitUI({ input, output, options, signal }) {
  const ci = process.env.CI && !["0", "false"].includes(process.env.CI.toLowerCase());
  const interactive = Boolean(input.isTTY && output.isTTY && !options["non-interactive"] && !options.json && !ci && process.env.TERM !== "dumb");
  const clack = interactive ? await import("@clack/prompts") : undefined;
  const common = { input, output, signal };
  const answer = (value) => { if (clack.isCancel(value)) throw new ToolkitCancelled(); return value; };
  const line = (text) => { if (!options.json) output.write(`${clean(text)}\n`); };
  return {
    interactive,
    start(agentDir) {
      if (clack) { clack.intro("Pi setup", common); clack.log.info(clean(`Directory: ${agentDir}`), common); }
      else line(`Pi setup\nDirectory: ${agentDir}`);
    },
    kept(source, matched) {
      const note = `Kept ${matched.length} local item(s) listed in ${source}: ${matched.join(", ")}`;
      if (clack) clack.log.info(clean(note), common);
      else line(note);
    },
    async packages(inventory, initialValues) {
      if (!inventory.packages.length) return [];
      return answer(await clack.multiselect({ ...common, message: "Choose packages; installed packages are kept",
        required: false, initialValues, maxItems: 12,
        options: inventory.packages.map((entry) => ({ value: entry.id, label: clean(entry.id),
          hint: clean(`${entry.present ? "installed" : entry.registered ? "needs repair" : "not installed"} — ${entry.description}`) })) }));
    },
    async extensions(inventory, initialValues) {
      const extensions = inventory.resources.filter((resource) => resource.kind === "extensions");
      if (!extensions.length) return [];
      return answer(await clack.multiselect({ ...common, message: "Choose bundled extensions to enable",
        required: false, initialValues, maxItems: 12,
        options: extensions.map((entry) => ({ value: entry.id, label: clean(entry.id), hint: clean(entry.path) })) }));
    },
    async cleanup(candidates) {
      if (!candidates.length) return [];
      clack.note("Optional permanent deletion. Nothing is selected by default; no backup is made.", "Clean up local Pi items", common);
      const selected = answer(await clack.multiselect({ ...common, message: "Delete which unselected packages or unmanaged resources?",
        required: false, initialValues: [], options: candidates.map((entry) => ({ value: entry.id,
          label: clean(entry.label), hint: entry.kind === "package" ? "Remove package and its registration" : "Delete local resource" })) }));
      return candidates.filter((entry) => selected.includes(entry.id));
    },
    async conflict(entry, files, root) {
      while (true) {
        clack.note(clean(entry.conflictMessage), clean(entry.target ?? entry.source), common);
        const choice = answer(await clack.select({ ...common, message: "How should setup handle this?", initialValue: "keep",
          options: [{ value: "keep", label: "Keep existing", hint: "Leave it unchanged and remember this choice" },
            ...(entry.target ? [{ value: "diff", label: "View differences" }] : []),
            ...(entry.retainOnly ? [{ value: "cancel", label: "Cancel and inspect manually" }] :
              [{ value: entry.target ? "replace" : "repair", label: entry.migration ? "Move old copy to backup and activate bundled version" : entry.target ? "Back up and replace" : "Repair package" }])] }));
        if (choice === "cancel") throw new ToolkitCancelled();
        if (choice !== "diff") return choice;
        if (entry.migration) {
          const old = toolkitPathStat(entry.target)?.isDirectory() ? join(entry.target, basename(entry.legacy)) : entry.target;
          const next = toolkitPathStat(entry.source)?.isDirectory() ? join(entry.source, basename(entry.legacy)) : entry.source;
          if (!toolkitPathStat(old)?.isFile() || !toolkitPathStat(next)?.isFile()) {
            clack.note("Entrypoint is not a regular file. Inspect the full paths before deciding.", "Differences", common);
          } else {
            clack.note(clean(createTwoFilesPatch(old, next, readFileSync(old, "utf8"), readFileSync(next, "utf8")).slice(0, 16000)), "Entrypoint differences (directory may contain other changes)", common);
          }
          continue;
        }
        if (entry.id === "instructions") {
          const stat = toolkitPathStat(entry.target);
          if (!stat?.isFile()) { clack.note("Existing path is a link. Replacement backs up the link, not its target.", "Differences", common); continue; }
          clack.note(clean(createTwoFilesPatch(entry.target, entry.source, readFileSync(entry.target, "utf8"), entry.content.toString()).slice(0, 16000)), "Differences", common);
        } else {
          const changes = [...files].filter(([path, file]) => {
            const target = join(entry.target, path);
            return !toolkitPathStat(target)?.isFile() || !readFileSync(target).equals(file.content);
          });
          if (!changes.length) { clack.note("Extra files, permissions, or link mode differ. Replacement backs up the existing directory.", "Differences", common); continue; }
          const path = answer(await clack.select({ ...common, message: "View file differences", options: [
            { value: "back", label: "Back" }, ...changes.map(([path]) => ({ value: path, label: clean(path) }))] }));
          if (path === "back") continue;
          const target = join(entry.target, path);
          const old = toolkitPathStat(target)?.isFile() ? readFileSync(target, "utf8") : "";
          clack.note(clean(createTwoFilesPatch(target, join(root, path), old, files.get(path).content.toString()).slice(0, 16000)), "Differences", common);
        }
      }
    },
    plan(plan, settingsChanged) {
      const summary = summarizeToolkitPlan(plan);
      const rows = summary.actions.map((entry) => `${entry.action.padEnd(10)} ${entry.id}`);
      rows.push(`enable     extensions: ${summary.extensionSelection.enabled.join(", ") || "none"}`);
      if (summary.extensionSelection.disabled.length) rows.push(`disable    extensions: ${summary.extensionSelection.disabled.join(", ")}`);
      for (const entry of summary.retained.filter((entry) => entry.paths.length)) rows.push(`retain     ${entry.id} (${entry.paths.join(", ")})`);
      rows.push(`${settingsChanged ? "merge" : "keep"}       local settings`, `Mode: ${plan.mode}`);
      if (clack) clack.note(clean(rows.join("\n")), "Planned changes", common);
      else line(`\nPlanned changes\n${rows.join("\n")}`);
    },
    async confirm({ canChoose = true } = {}) { return answer(await clack.select({ ...common, message: "Apply these changes? Close Pi first.", initialValue: "apply",
      options: [{ value: "apply", label: "Apply" }, ...(canChoose ? [{ value: "back", label: "Back to selections" }] : []), { value: "cancel", label: "Cancel" }] })); },
    async task(title, fn, completed = "Step completed") {
      if (!clack) { line(title); return fn(); }
      const progress = clack.spinner({ output, signal });
      progress.start(clean(title));
      try { const value = await fn(); progress.stop(clean(completed)); return value; }
      catch (error) { progress.stop("Stopped", 1); throw error; }
    },
    finish(receipt) {
      if (options.json) { output.write(`${JSON.stringify(receipt)}\n`); return; }
      for (const warning of receipt.warnings ?? []) {
        if (clack) clack.log.warn(clean(warning), common); else line(`Warning: ${warning}`);
      }
      if (receipt.backup) line(`Backups: ${receipt.backup}`);
      if (clack) clack.outro(clean(receipt.message), common); else line(receipt.message);
      if (receipt.next) {
        const directory = receipt.next.env.PI_CODING_AGENT_DIR;
        const command = process.platform === "win32" ? `$env:PI_CODING_AGENT_DIR='${directory.replaceAll("'", "''")}'; pi` :
          `PI_CODING_AGENT_DIR='${directory.replaceAll("'", "'\\''")}' pi`;
        line(`Start Pi:\n  ${command}`);
      }
    },
  };
}
