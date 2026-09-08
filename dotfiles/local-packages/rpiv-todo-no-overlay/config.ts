import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface TodoConfig {
	guidance?: GuidanceFields;
}

const CONFIG_PATH = join(homedir(), ".config", "rpiv-todo", "config.json");

function loadConfigFile<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (error) {
		console.warn(`rpiv-todo: invalid JSON at ${path}, using defaults — ${(error as Error).message}`);
		return {} as T;
	}
}

export function loadConfig(): TodoConfig {
	return loadConfigFile<TodoConfig>(CONFIG_PATH);
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const guidance = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof guidance.promptSnippet === "string" && guidance.promptSnippet.length > 0) {
		result.promptSnippet = guidance.promptSnippet;
	}
	if (
		Array.isArray(guidance.promptGuidelines) &&
		guidance.promptGuidelines.length > 0 &&
		guidance.promptGuidelines.every((item) => typeof item === "string" && item.length > 0)
	) {
		result.promptGuidelines = guidance.promptGuidelines;
	}
	return result;
}
