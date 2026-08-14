/**
 * Mid-prompt skill completion & inline expansion.
 *
 * Skills can be referenced anywhere in a prompt, not just at the start:
 *
 *   "i want to use the $gril<Tab> skill"   ->  "i want to use the $grilling skill"
 *   "review this /code-rev<Tab> please"    ->  "review this /code-review please"
 *
 * - `$name` opens the autocomplete popup automatically (like `@` for files);
 *   `/name` mid-prompt completes on Tab (line-start `/` keeps the built-in
 *   `/skill:name` completion).
 * - On submit, `$skillname` and `/skillname` tokens that exactly match a
 *   loaded skill are expanded inline to the skill's SKILL.md content, using
 *   the same `<skill>` block format as the built-in `/skill:name` expansion.
 *   A `/` token must be preceded by whitespace or line start, so paths like
 *   `foo/bar` are never touched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

const MAX_SUGGESTIONS = 20;

type SkillInfo = {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
};

// Trailing punctuation that may follow a skill reference mid-sentence
// ("use $grilling." or "(/grilling)") and must not block the match.
const TRAILING_PUNCT = /[.,;!?)\]}>"'’]+$/;

function cleanName(raw: string): string {
	return raw.replace(TRAILING_PUNCT, "");
}

/**
 * Extract the token (including its trigger character) ending at the cursor.
 * Matches `$name` after any non-word boundary, and `/name` after whitespace.
 * Returns undefined for a line-start `/` so the built-in slash completion
 * (which offers `/skill:name`) keeps working.
 */
export function extractToken(textBeforeCursor: string): string | undefined {
	if (textBeforeCursor.startsWith("/")) return undefined;
	const dollar = textBeforeCursor.match(/(?<=^|[^\w$])\$([^\s$]*)$/);
	if (dollar) return `$${dollar[1]}`;
	const slash = textBeforeCursor.match(/(?<=^|\s)\/([^\s]*)$/);
	if (slash) return `/${slash[1]}`;
	return undefined;
}

function skillBlock(skill: SkillInfo, body: string): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

const bodyCache = new Map<string, string | undefined>();

function readSkillBody(skill: SkillInfo): string | undefined {
	if (bodyCache.has(skill.filePath)) return bodyCache.get(skill.filePath);
	let body: string | undefined;
	try {
		if (existsSync(skill.filePath)) {
			body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
		}
	} catch {
		body = undefined;
	}
	bodyCache.set(skill.filePath, body);
	return body;
}

/**
 * Collect loaded skills from pi.getCommands() (name, description, SKILL.md path).
 * Dedupes by name; first occurrence wins.
 */
export function getSkills(pi: ExtensionAPI): SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	for (const command of pi.getCommands()) {
		if (command.source !== "skill") continue;
		const name = command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
		if (!name || byName.has(name)) continue;
		const path = command.sourceInfo.path.endsWith("SKILL.md")
			? command.sourceInfo.path
			: join(command.sourceInfo.path, "SKILL.md");
		byName.set(name, {
			name,
			description: command.description ?? "",
			filePath: path,
			baseDir: command.sourceInfo.baseDir ?? dirname(path),
		});
	}
	return [...byName.values()];
}

/**
 * Replace `$name` (any boundary) and `/name` (whitespace/line-start boundary)
 * tokens whose cleaned name exactly matches a skill with the skill's content.
 * Trailing punctuation after the name is preserved.
 */
export function expandTokens(text: string, skills: Map<string, SkillInfo>): string {
	if (skills.size === 0) return text;
	return text.replace(/(^|[^\w$])\$([^\s$]+)|(^|\s)\/([^\s]+)/g, (match, dollarBoundary, dollarName, slashBoundary, slashName) => {
		const isDollar = dollarName !== undefined;
		const boundary = isDollar ? dollarBoundary : slashBoundary;
		const rawName = isDollar ? dollarName : slashName;
		const cleaned = cleanName(rawName);
		if (!cleaned) return match;
		const skill = skills.get(cleaned);
		if (!skill) return match;
		const body = readSkillBody(skill);
		if (body === undefined) return match;
		const trailing = rawName.slice(cleaned.length);
		return `${boundary}${skillBlock(skill, body)}${trailing}`;
	});
}

function filterSkills(skills: SkillInfo[], query: string): AutocompleteItem[] {
	return fuzzyFilter(skills, query, (skill) => skill.name)
		.slice(0, MAX_SUGGESTIONS)
		.map((skill) => ({
			value: skill.name,
			label: skill.name,
			description: skill.description || undefined,
		}));
}

function createSkillAutocompleteProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
): AutocompleteProvider {
	// Prefix of the suggestions this provider last returned; lets applyCompletion
	// distinguish our `$`/`/` tokens from built-in file-path prefixes like `/etc/...`.
	let lastPrefix: string | undefined;

	return {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractToken(textBeforeCursor);
			if (token === undefined) {
				lastPrefix = undefined;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const skills = getSkills(pi);
			if (options.signal.aborted || skills.length === 0) {
				lastPrefix = undefined;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const items = filterSkills(skills, cleanName(token.slice(1)));
			if (items.length === 0) {
				lastPrefix = undefined;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			lastPrefix = token;
			return { items, prefix: token };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix !== lastPrefix || (!prefix.startsWith("$") && !prefix.startsWith("/"))) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}${prefix[0]}${item.value}${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + 1 + item.value.length,
			};
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			if (extractToken(textBeforeCursor) !== undefined) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		const skills = new Map(getSkills(pi).map((skill) => [skill.name, skill]));
		const expanded = expandTokens(event.text, skills);
		if (expanded === event.text) return;
		return { action: "transform", text: expanded };
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
	});
}
