import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UtilityModelConfig, UtilityThinkingLevel } from "./utility-model-config.ts";

export function resolveUtilityModel(
  registry: Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">,
  config: UtilityModelConfig,
): Model<Api> | undefined {
  const model = registry.find(config.model.provider, config.model.id);
  return model && registry.hasConfiguredAuth(model) ? model : undefined;
}

export async function requestUtilityResponse(
  ctx: ExtensionContext,
  model: Model<Api>,
  context: Context,
  thinkingLevel: UtilityThinkingLevel,
  limits: { signal: AbortSignal; timeoutMs: number; maxTokens: number },
): Promise<AssistantMessage> {
  const signal = AbortSignal.any([limits.signal, AbortSignal.timeout(limits.timeoutMs)]);
  signal.throwIfAborted();
  const response = ctx.modelRegistry
    .streamSimple(model, context, {
      ...limits,
      signal,
      maxRetries: 0,
      cacheRetention: "none",
      ...(model.reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    })
    .result();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const answer = await Promise.race([response, cancelled]);
    signal.throwIfAborted();
    return answer;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
