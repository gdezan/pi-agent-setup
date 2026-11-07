/**
 * Working-directory section.
 *
 * Renders: ~/dev/project  (full)  or  project  (compact)
 */

import { basename, resolve } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { FooterSectionVariant, Section } from "../types.ts";

function fmtCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  if (cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export function createPathSection() {
  let cwd = process.cwd();

  const section: Section & { setCwd(newCwd: string): void } = {
    id: "pi-footer:path",
    align: "left",
    order: 10,
    essential: true,
    variants: ["full", "compact"],

    setCwd(newCwd: string): void {
      cwd = newCwd;
    },

    render(_ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string {
      const resolved = resolve(cwd);
      const label = variant === "compact" ? basename(resolved) || resolved : fmtCwd(resolved);
      return theme.fg("warning", label);
    },
  };

  return section;
}
