import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  NEXT_PROMPT_MODES,
  parseUtilityModelConfig,
  readUtilitySettings,
  saveNextPromptSettings,
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

function nextPromptMode(settings: Record<string, unknown>, ctx: ExtensionContext) {
  const configured = NEXT_PROMPT_MODES.find((mode) => mode === settings.mode) ?? "auto";
  const display =
    configured === "auto" ? (ctx.mode === "rpc" ? "transcript" : "editor") : configured;
  const available = ctx.mode === "tui" || (ctx.mode === "rpc" && display === "transcript");
  return { configured, display, available };
}

export default function nextPrompt(pi: ExtensionAPI): void {
  let suggestion = "";
  let transcriptSuggestion: { text: string; replyId: string; sessionId: string } | undefined;
  let pending: AbortController | undefined;
  let redraw = () => {};
  let lastUsage = "No suggestion request completed in this session";
  const attemptedReplies = new Set<string>();
  let restoreEditor: (() => void) | undefined;

  const clearEditor = (): void => {
    pending?.abort();
    pending = undefined;
    if (suggestion) {
      suggestion = "";
      redraw();
    }
  };

  const clear = (): void => {
    transcriptSuggestion = undefined;
    clearEditor();
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
          clear: clearEditor,
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
    if (event.aborted || ctx.hasPendingMessages() || ctx.ui.getEditorText()) return;
    try {
      const settings = readUtilitySettings(ctx);
      const feature = utilitySettingsObject(settings.nextPrompt);
      const { display, available } = nextPromptMode(feature, ctx);
      if (feature.enabled === false || !available) return;
      const replyId = nextPromptReplyId(ctx);
      if (!replyId || attemptedReplies.has(replyId)) return;
      const context = buildNextPromptContext(ctx.sessionManager.buildSessionProjection().entries);
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
      const request = requestUtilityResponse(ctx, model, context, config.thinkingLevel, {
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
          const text = normalizeNextPromptSuggestion(
            response.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
          if (!text) return;
          if (display === "transcript") {
            transcriptSuggestion = { text, replyId, sessionId };
            ctx.ui.notify(`Next: ${text}`, "info");
          } else {
            suggestion = text;
            redraw();
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && pending === controller)
            lastUsage = "Next-prompt request failed or timed out; no suggestion shown";
        })
        .finally(() => {
          if (pending === controller) pending = undefined;
        });
      // Pi emits the external settled event after awaited handlers; hosts can drop later notices.
      if (display === "transcript") return request;
    } catch {
      // Optional suggestions must not interrupt the conversation.
    }
  });

  pi.registerCommand("use-next-prompt", {
    description: "Send the latest transcript suggestion as your next prompt",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /use-next-prompt", "warning");
        return;
      }
      const feature = utilitySettingsObject(readUtilitySettings(ctx).nextPrompt);
      const { display, available } = nextPromptMode(feature, ctx);
      const next = transcriptSuggestion;
      if (
        !next ||
        feature.enabled === false ||
        !available ||
        display !== "transcript" ||
        next.sessionId !== ctx.sessionManager.getSessionId() ||
        next.replyId !== nextPromptReplyId(ctx) ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages()
      ) {
        ctx.ui.notify("No next prompt available.", "info");
        return;
      }
      clear();
      pi.sendUserMessage(next.text);
    },
  });

  pi.registerCommand("next-prompt", {
    description: "Show suggestion status, enable/disable, or select auto/editor/transcript mode",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        const mode = NEXT_PROMPT_MODES.find((mode) => mode === action);
        if (action && action !== "on" && action !== "off" && !mode) {
          ctx.ui.notify(
            "Next-prompt usage: /next-prompt [on|off|auto|editor|transcript]",
            "warning",
          );
          return;
        }
        if (action) {
          clear();
          saveNextPromptSettings(mode ? { mode } : { enabled: action === "on" });
        }
        const feature = utilitySettingsObject(readUtilitySettings(ctx).nextPrompt);
        const enabled = feature.enabled !== false;
        const { configured, display, available } = nextPromptMode(feature, ctx);
        const overridden = action && (mode ? configured !== mode : enabled !== (action === "on"));
        ctx.ui.notify(
          `Next-prompt ${enabled ? "on" : "off"}${overridden ? " (overridden by project settings)" : ""} · ${configured === "auto" ? `auto (${display})` : configured}${available ? "" : " (unavailable here)"} · ${lastUsage}`,
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
