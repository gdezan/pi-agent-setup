import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AskUserConfig = {
	collapseKey?: string | "off";
	promptSnippet?: string;
	promptGuidelines?: string[];
};

const ASK_USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(ASK_USER_AGENT_DIR, "ask-user-question.json");

/** Load the small optional configuration for overlay collapse and prompt guidance. */
export function loadAskUserConfig(): AskUserConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const value = parsed as Record<string, unknown>;
		return {
			collapseKey: typeof value.collapseKey === "string" ? value.collapseKey : undefined,
			promptSnippet: typeof value.promptSnippet === "string" ? value.promptSnippet : undefined,
			promptGuidelines: Array.isArray(value.promptGuidelines)
				? value.promptGuidelines.filter((item): item is string => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

/** Resolve the configured overlay toggle key; `off` disables the shortcut. */
export function resolveAskUserCollapseKey(config: AskUserConfig): string | "off" {
	if (config.collapseKey === "off") return "off";
	return config.collapseKey?.trim() || "ctrl+]";
}
