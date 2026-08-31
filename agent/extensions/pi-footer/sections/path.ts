/**
 * Path + git branch section.
 *
 * Renders: ~/dev/project (main)  or  ~/dev/project  (no git)
 *
 * Watches .git/HEAD for branch changes and calls onInvalidate.
 */

import { execSync } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { FooterSectionVariant, Section } from "../types.ts";

function getGitBranch(cwd: string): string | null {
	try {
		const branch = execSync("git branch --show-current 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 500,
		}).trim();
		return branch || null;
	} catch {
		return null;
	}
}

function fmtCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	if (cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function createPathSection() {
	let cwd = process.cwd();
	let branch: string | null = null;
	let watcher: FSWatcher | null = null;
	/** External invalidate — set by the setup code after registration. */
	let onInvalidate: (() => void) | null = null;

	function refreshBranch(): void {
		branch = getGitBranch(cwd);
		onInvalidate?.();
	}

	function setupWatcher(): void {
		cleanupWatcher();
		const headPath = join(cwd, ".git", "HEAD");
		if (existsSync(headPath)) {
			try {
				watcher = watch(headPath, () => refreshBranch());
			} catch {
				// .git may be unwatchable — ignore
			}
		}
	}

	function cleanupWatcher(): void {
		watcher?.close();
		watcher = null;
	}

	const section: Section & {
		setCwd(newCwd: string): void;
		setInvalidate(fn: () => void): void;
	} = {
		id: "pi-footer:path",
		align: "left",
		order: 10,
		essential: true,
		variants: ["full", "compact"],

		setCwd(newCwd: string): void {
			cwd = newCwd;
			setupWatcher();
			refreshBranch();
		},

		setInvalidate(fn: () => void): void {
			onInvalidate = fn;
		},

		render(_ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string {
			const resolved = resolve(cwd);
			if (variant === "compact") {
				const folder = basename(resolved) || resolved;
				const branchSuffix = branch ? theme.fg("dim", `@${branch}`) : "";
				return theme.fg("warning", folder) + branchSuffix;
			}

			const pathStr = fmtCwd(resolved);
			const branchStr = branch ? theme.fg("dim", ` (${branch})`) : "";
			return theme.fg("warning", pathStr) + branchStr;
		},

		dispose(): void {
			cleanupWatcher();
		},
	};

	return section;
}
