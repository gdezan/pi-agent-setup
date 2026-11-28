import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const UTILITY_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type UtilityThinkingLevel = (typeof UTILITY_THINKING_LEVELS)[number];
export type UtilityModelConfig = {
  model: { provider: string; id: string };
  thinkingLevel: UtilityThinkingLevel;
};

export const DEFAULT_UTILITY_MODEL_CONFIG: UtilityModelConfig = {
  model: { provider: "openai", id: "gpt-6-luna" },
  thinkingLevel: "low",
};

export function utilitySettingsObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseUtilityModelId(value: unknown): UtilityModelConfig["model"] | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();
  if (!provider || !id || /\s/u.test(`${provider}${id}`)) return undefined;
  return { provider, id };
}

export function parseUtilityModelConfig(settings: Record<string, unknown>): UtilityModelConfig {
  const current = utilitySettingsObject(settings.utilityModel);
  const legacy = utilitySettingsObject(settings.sessionAutoname);
  return {
    model:
      parseUtilityModelId(current.model) ??
      parseUtilityModelId(legacy.model) ??
      DEFAULT_UTILITY_MODEL_CONFIG.model,
    thinkingLevel:
      UTILITY_THINKING_LEVELS.find((level) => level === current.thinkingLevel) ??
      UTILITY_THINKING_LEVELS.find((level) => level === legacy.thinkingLevel) ??
      DEFAULT_UTILITY_MODEL_CONFIG.thinkingLevel,
  };
}

function readUtilitySettingsFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Utility settings must contain a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

export function readUtilitySettings(
  ctx?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  path = join(getAgentDir(), "settings.json"),
): Record<string, unknown> {
  const settings = readUtilitySettingsFile(path);
  if (!ctx?.isProjectTrusted()) return settings;
  const project = readUtilitySettingsFile(join(ctx.cwd, ".pi", "settings.json"));
  for (const key of ["utilityModel", "sessionAutoname", "nextPrompt"]) {
    if (key in project)
      settings[key] = {
        ...utilitySettingsObject(settings[key]),
        ...utilitySettingsObject(project[key]),
      };
  }
  return settings;
}

export function mergeUtilityModelSettings(
  settings: Record<string, unknown>,
  config: UtilityModelConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...settings,
    utilityModel: {
      ...utilitySettingsObject(settings.utilityModel),
      model: `${config.model.provider}/${config.model.id}`,
      thinkingLevel: config.thinkingLevel,
    },
  };
  if ("sessionAutoname" in settings) {
    const {
      model: _model,
      thinkingLevel: _thinking,
      ...feature
    } = utilitySettingsObject(settings.sessionAutoname);
    result.sessionAutoname = feature;
  }
  return result;
}

function writeUtilitySettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function saveUtilityModelConfig(
  config: UtilityModelConfig,
  path = join(getAgentDir(), "settings.json"),
): void {
  writeUtilitySettings(path, mergeUtilityModelSettings(readUtilitySettingsFile(path), config));
}

export const NEXT_PROMPT_MODES = ["auto", "editor", "transcript"] as const;
export type NextPromptMode = (typeof NEXT_PROMPT_MODES)[number];

export function saveNextPromptSettings(
  update: { enabled?: boolean; mode?: NextPromptMode },
  path = join(getAgentDir(), "settings.json"),
): void {
  const settings = readUtilitySettingsFile(path);
  writeUtilitySettings(path, {
    ...settings,
    nextPrompt: { ...utilitySettingsObject(settings.nextPrompt), ...update },
  });
}
