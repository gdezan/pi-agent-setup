import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { LoadedProjectConfig, OptimizerConfig, OptimizerEntry, OptimizerMode } from "./types.ts";

export const PROMPT_CACHE_CONFIG_FILE = "prompt-cache.json";

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
	mode: "off",
	entries: [],
};

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result.length > 0 && result.length <= maxLength ? result : undefined;
}

function parseMode(value: unknown): OptimizerMode {
	return value === "preview" || value === "live" || value === "off" ? value : "preview";
}

/** Parse the intentionally small project-local optimizer schema. */
export function parseOptimizerConfig(value: unknown): { config: OptimizerConfig; diagnostics: string[] } {
	const diagnostics: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { config: DEFAULT_OPTIMIZER_CONFIG, diagnostics: ["config-root-not-object"] };
	}
	const root = value as Record<string, unknown>;
	const optimizerValue = root.optimizer;
	if (optimizerValue === undefined) return { config: DEFAULT_OPTIMIZER_CONFIG, diagnostics };
	if (!optimizerValue || typeof optimizerValue !== "object" || Array.isArray(optimizerValue)) {
		return { config: DEFAULT_OPTIMIZER_CONFIG, diagnostics: ["optimizer-not-object"] };
	}

	const optimizer = optimizerValue as Record<string, unknown>;
	const mode = parseMode(optimizer.mode);
	if (optimizer.mode !== undefined && optimizer.mode !== mode) diagnostics.push("invalid-optimizer-mode-defaulted-to-preview");
	const entries: OptimizerEntry[] = [];
	const rawEntries = optimizer.entries;
	if (rawEntries !== undefined && !Array.isArray(rawEntries)) diagnostics.push("optimizer-entries-not-array");
	if (Array.isArray(rawEntries)) {
		for (const [index, rawEntry] of rawEntries.entries()) {
			if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
				diagnostics.push(`optimizer-entry-${index}-not-object`);
				continue;
			}
			const record = rawEntry as Record<string, unknown>;
			const provider = nonEmptyString(record.provider, 120);
			const model = nonEmptyString(record.model, 200);
			const promptCacheKey = nonEmptyString(record.promptCacheKey, 256);
			if (!provider || !model || !promptCacheKey) {
				diagnostics.push(`optimizer-entry-${index}-invalid`);
				continue;
			}
			if (entries.some((entry) => entry.provider === provider && entry.model === model)) {
				diagnostics.push(`optimizer-entry-${index}-duplicate`);
				continue;
			}
			entries.push({ provider, model, promptCacheKey });
		}
	}
	return { config: { mode, entries }, diagnostics };
}

export function projectPromptCacheConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, PROMPT_CACHE_CONFIG_FILE);
}

/** Load config only after Pi has established project trust. */
export async function loadProjectConfig(cwd: string, trusted: boolean): Promise<LoadedProjectConfig> {
	const path = projectPromptCacheConfigPath(cwd);
	if (!trusted) {
		return {
			trusted: false,
			path,
			optimizer: DEFAULT_OPTIMIZER_CONFIG,
			diagnostics: ["project-not-trusted-config-not-read"],
		};
	}

	try {
		const raw = await readFile(path, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { trusted: true, path, optimizer: DEFAULT_OPTIMIZER_CONFIG, diagnostics: ["config-malformed-json"] };
		}
		const result = parseOptimizerConfig(parsed);
		return { trusted: true, path, optimizer: result.config, diagnostics: result.diagnostics };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { trusted: true, path, optimizer: DEFAULT_OPTIMIZER_CONFIG, diagnostics: [] };
		}
		return { trusted: true, path, optimizer: DEFAULT_OPTIMIZER_CONFIG, diagnostics: ["config-unavailable"] };
	}
}

export function findOptimizerEntry(
	config: OptimizerConfig,
	provider: string | undefined,
	model: string | undefined,
): OptimizerEntry | undefined {
	if (!provider || !model) return undefined;
	return config.entries.find((entry) => entry.provider === provider && entry.model === model);
}
