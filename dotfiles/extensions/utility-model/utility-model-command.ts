import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseUtilityModelConfig,
	parseUtilityModelId,
	readUtilitySettings,
	saveUtilityModelConfig,
	UTILITY_THINKING_LEVELS,
} from "./utility-model-config.ts";
import { resolveUtilityModel } from "./utility-model-request.ts";

export function configureUtilityModel(args: readonly string[], ctx: ExtensionContext): void {
	try {
		const config = parseUtilityModelConfig(readUtilitySettings(ctx));
		const [modelArgument, thinkingArgument] = args;
		if (!modelArgument) {
			const available = resolveUtilityModel(ctx.modelRegistry, config);
			ctx.ui.notify(
				`Utility model ${config.model.provider}/${config.model.id} · thinking:${config.thinkingLevel} · ${available ? "credentials configured" : "model or credentials unavailable"} · used by AutoName and next-prompt`,
				available ? "info" : "warning",
			);
			return;
		}
		const model = parseUtilityModelId(modelArgument);
		const thinkingLevel = thinkingArgument === undefined
			? config.thinkingLevel
			: UTILITY_THINKING_LEVELS.find((level) => level === thinkingArgument);
		if (args.length > 2 || !model || !thinkingLevel) {
			ctx.ui.notify(`Utility model usage: /autoname model provider/modelId [${UTILITY_THINKING_LEVELS.join("|")}]`, "warning");
			return;
		}
		if (!resolveUtilityModel(ctx.modelRegistry, { model, thinkingLevel })) {
			ctx.ui.notify(`Utility model unavailable or missing credentials: ${model.provider}/${model.id}`, "warning");
			return;
		}
		saveUtilityModelConfig({ model, thinkingLevel });
		const effective = parseUtilityModelConfig(readUtilitySettings(ctx));
		const overridden = effective.model.provider !== model.provider || effective.model.id !== model.id || effective.thinkingLevel !== thinkingLevel;
		ctx.ui.notify(
			`Utility model saved for AutoName and next-prompt: ${model.provider}/${model.id} · thinking:${thinkingLevel}${overridden ? " · project settings override this choice here" : ""}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Utility model settings failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
