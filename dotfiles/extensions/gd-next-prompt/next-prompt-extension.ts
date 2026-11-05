import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseUtilityModelConfig,
  readUtilitySettings,
  saveNextPromptEnabled,
  utilitySettingsObject,
} from "../utility-model/utility-model-config.ts";
import {
  requestUtilityResponse,
  resolveUtilityModel,
} from "../utility-model/utility-model-request.ts";
import { buildNextPromptContext, normalizeNextPromptSuggestion } from "./next-prompt-context.ts";
import { attachNextPromptEditor } from "./next-prompt-editor.ts";

function nextPromptReplyId(ctx: ExtensionContext): string | undefined {
  const latest = ctx.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        (entry.message.role === "assistant" || entry.message.role === "user"),
    );
  return latest?.type === "message" && latest.message.role === "assistant" ? latest.id : undefined;
}

export default function nextPrompt(pi: ExtensionAPI): void {
  let suggestion = "";
  let pending: AbortController | undefined;
  let redraw = () => {};
  let lastUsage = "No suggestion request completed in this session";
  const attemptedReplies = new Set<string>();
  let restoreEditor: (() => void) | undefined;

  const clear = (): void => {
    pending?.abort();
    pending = undefined;
    if (suggestion) {
      suggestion = "";
      redraw();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    clear();
    attemptedReplies.clear();
    lastUsage = "No suggestion request completed in this session";
    if (ctx.mode !== "tui") return;
    const previous = ctx.ui.getEditorComponent();
    const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (
      tui,
      theme,
      keybindings,
    ) => {
      redraw = () => tui.requestRender();
      return attachNextPromptEditor(
        previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings),
        ctx,
        {
          getSuggestion: () => suggestion,
          isActive: () => Boolean(suggestion || pending),
          clear,
          redraw,
        },
      );
    };
    ctx.ui.setEditorComponent(factory);
    restoreEditor = () => {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    };
  });

  pi.on("input", () => clear());
  pi.on("before_agent_start", () => clear());
  pi.on("agent_start", () => clear());
  pi.on("session_before_switch", () => clear());
  pi.on("session_before_fork", () => clear());
  pi.on("session_before_tree", () => clear());
  pi.on("session_tree", () => clear());
  pi.on("ui_prompt_start", () => clear());
  pi.on("session_shutdown", () => {
    clear();
    restoreEditor?.();
    restoreEditor = undefined;
    redraw = () => {};
  });

  pi.on("agent_settled", (event, ctx) => {
    if (ctx.mode !== "tui" || event.aborted || ctx.hasPendingMessages() || ctx.ui.getEditorText())
      return;
    try {
      const settings = readUtilitySettings(ctx);
      if (utilitySettingsObject(settings.nextPrompt).enabled === false) return;
      const replyId = nextPromptReplyId(ctx);
      if (!replyId || attemptedReplies.has(replyId)) return;
      const context = buildNextPromptContext(ctx.sessionManager.getBranch());
      if (!context) return;
      const config = parseUtilityModelConfig(settings);
      const model = resolveUtilityModel(ctx.modelRegistry, config);
      if (!model) return;

      clear();
      attemptedReplies.add(replyId);
      const controller = new AbortController();
      pending = controller;
      const sessionId = ctx.sessionManager.getSessionId();
      const started = performance.now();
      void requestUtilityResponse(ctx, model, context, config.thinkingLevel, {
        signal: controller.signal,
        timeoutMs: 10_000,
        maxTokens: 512,
      })
        .then((response) => {
          if (
            controller.signal.aborted ||
            pending !== controller ||
            ctx.sessionManager.getSessionId() !== sessionId
          )
            return;
          const usage = response.usage;
          lastUsage = `${model.provider}/${model.id} · ${Math.round(performance.now() - started)} ms · input ${usage.input} · output incl. reasoning ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite} · cost $${usage.cost.total.toFixed(6)} · ${response.stopReason}`;
          if (
            response.stopReason !== "stop" ||
            !ctx.isIdle() ||
            ctx.hasPendingMessages() ||
            ctx.ui.getEditorText() ||
            nextPromptReplyId(ctx) !== replyId
          )
            return;
          suggestion =
            normalizeNextPromptSuggestion(
              response.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            ) ?? "";
          redraw();
        })
        .catch(() => {
          if (!controller.signal.aborted && pending === controller)
            lastUsage = "Next-prompt request failed or timed out; no suggestion shown";
        })
        .finally(() => {
          if (pending === controller) pending = undefined;
        });
    } catch {
      // Optional suggestions must not interrupt the conversation.
    }
  });

  pi.registerCommand("next-prompt", {
    description: "Show suggestion status and usage, or enable/disable suggestions with on/off",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (action && action !== "on" && action !== "off") {
          ctx.ui.notify("Next-prompt usage: /next-prompt [on|off]", "warning");
          return;
        }
        if (action) {
          clear();
          saveNextPromptEnabled(action === "on");
        }
        const enabled =
          utilitySettingsObject(readUtilitySettings(ctx).nextPrompt).enabled !== false;
        ctx.ui.notify(
          `Next-prompt ${enabled ? "on" : "off"}${action && enabled !== (action === "on") ? " (overridden by project settings)" : ""} · ${lastUsage}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Next-prompt settings failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
