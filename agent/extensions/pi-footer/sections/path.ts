/**
 * Path + git branch + status section.
 *
 * Renders: ~/dev/project (main !2 ?1 ⇡1)  or  ~/dev/project  (no git)
 *
 * Status symbols (single `git status --porcelain -b` call, throttled):
 *   +n staged      !n unstaged     ?n untracked
 *   ⇡n ahead       ⇣n behind       $n stashed
 *   ✓ clean and in sync
 *
 * Watches .git/HEAD and .git/index for immediate branch/stage changes and
 * calls onInvalidate. Working-tree edits are picked up via a 2s throttle
 * checked on each render (file watching can't catch those).
 */

import { execSync } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { FooterSectionVariant, Section } from "../types.ts";

interface GitState {
	branch: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	stashed: number;
}

/** How long a cached git state is trusted before the next render re-queries. */
const STALE_MS = 2000;

function parseAheadBehind(header: string): { ahead: number; behind: number } {
	let ahead = 0;
	let behind = 0;
	const match = header.match(/\[(.+)\]/);
	if (!match) return { ahead, behind };
	for (const part of match[1].split(",")) {
		const aheadMatch = part.match(/ahead (\d+)/);
		if (aheadMatch) ahead = Number(aheadMatch[1]);
		const behindMatch = part.match(/behind (\d+)/);
		if (behindMatch) behind = Number(behindMatch[1]);
	}
	return { ahead, behind };
}

function getDetachedSha(cwd: string): string | null {
	try {
		const sha = execSync("git rev-parse --short HEAD 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 500,
		}).trim();
		return sha ? `:${sha}` : null;
	} catch {
		return null;
	}
}

function getStashCount(cwd: string): number {
	try {
		const out = execSync("git stash list --format=%gd 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 500,
		}).trim();
		return out ? out.split("\n").length : 0;
	} catch {
		return 0;
	}
}

function getGitState(cwd: string): GitState | null {
	let out: string;
	try {
		out = execSync("git status --porcelain=v1 -b --untracked-files=normal 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 1000,
			maxBuffer: 1024 * 1024,
		});
	} catch {
		return null;
	}

	const lines = out.split("\n");
	const header = lines[0] ?? "";
	if (!header.startsWith("## ")) return null;

	let branch: string | null = null;
	if (header.startsWith("## No commits yet on ")) {
		branch = header.slice("## No commits yet on ".length).split(/[. ]/)[0] || null;
	} else if (header.startsWith("## HEAD (no branch)")) {
		branch = getDetachedSha(cwd);
	} else {
		branch = header.slice(3).split(/[. ]/)[0] || null;
	}
	if (!branch) return null;

	const { ahead, behind } = parseAheadBehind(header);

	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		if (line.startsWith("??")) {
			untracked += 1;
		} else if (line.startsWith("!!")) {
			continue;
		} else {
			if (line[0] !== " " && line[0] !== "?") staged += 1;
			if (line[1] !== " " && line[1] !== "?") unstaged += 1;
		}
	}

	return { branch, ahead, behind, staged, unstaged, untracked, stashed: getStashCount(cwd) };
}

/** Styled status segments, e.g. ["!2", "?1", "⇡1"]. Clean state yields ["✓"]. */
function statusSegments(state: GitState, theme: Theme): string[] {
	const parts: string[] = [];
	if (state.staged > 0) parts.push(theme.fg("success", `+${state.staged}`));
	if (state.unstaged > 0) parts.push(theme.fg("warning", `!${state.unstaged}`));
	if (state.untracked > 0) parts.push(theme.fg("dim", `?${state.untracked}`));
	if (state.ahead > 0) parts.push(theme.fg("accent", `⇡${state.ahead}`));
	if (state.behind > 0) parts.push(theme.fg("warning", `⇣${state.behind}`));
	if (state.stashed > 0) parts.push(theme.fg("dim", `$${state.stashed}`));
	if (parts.length === 0 && state.ahead === 0 && state.behind === 0) {
		parts.push(theme.fg("success", "✓"));
	}
	return parts;
}

function fmtCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	if (cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function createPathSection() {
	let cwd = process.cwd();
	let git: GitState | null = null;
	let lastCheck = 0;
	let watchers: FSWatcher[] = [];
	/** External invalidate — set by the setup code after registration. */
	let onInvalidate: (() => void) | null = null;

	function refresh(force = false): void {
		const now = Date.now();
		if (!force && now - lastCheck < STALE_MS) return;
		lastCheck = now;
		git = getGitState(cwd);
	}

	function refreshAndNotify(): void {
		refresh(true);
		onInvalidate?.();
	}

	function setupWatcher(): void {
		cleanupWatcher();
		for (const rel of ["HEAD", "index"]) {
			const target = join(cwd, ".git", rel);
			if (!existsSync(target)) continue;
			try {
				watchers.push(watch(target, () => refreshAndNotify()));
			} catch {
				// .git may be unwatchable — ignore
			}
		}
	}

	function cleanupWatcher(): void {
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				// ignore close errors
			}
		}
		watchers = [];
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
			refreshAndNotify();
		},

		setInvalidate(fn: () => void): void {
			onInvalidate = fn;
		},

		render(_ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string {
			refresh();
			const resolved = resolve(cwd);
			if (variant === "compact") {
				const folder = basename(resolved) || resolved;
				if (!git) return theme.fg("warning", folder);
				const segs = statusSegments(git, theme);
				const suffix = segs.length > 0 ? ` ${segs.join(" ")}` : "";
				return theme.fg("warning", folder) + theme.fg("dim", `@${git.branch}`) + suffix;
			}

			const pathStr = fmtCwd(resolved);
			if (!git) return theme.fg("warning", pathStr);
			const segs = statusSegments(git, theme);
			const suffix = segs.length > 0 ? ` ${segs.join(" ")}` : "";
			return theme.fg("warning", pathStr) + theme.fg("dim", ` (${git.branch}`) + suffix + theme.fg("dim", ")");
		},

		dispose(): void {
			cleanupWatcher();
		},
	};

	return section;
}
