import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { Footer } from "./pi-footer/footer.ts";

const MARKER = "[prewalk-instruction]";
const MAX_TODO_ITEMS = 12;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type ModelItem = { provider: string; id: string; model: Model<any> };

function modelLabel(model: Model<any>) {
  return `${model.provider}/${model.id}`;
}

function modelSearchText(item: ModelItem) {
  const name = item.model.name ? ` ${item.model.name}` : "";
  return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

class LiveModelPicker extends Container {
  private searchInput = new Input();
  private listContainer = new Container();
  private filtered: ModelItem[];
  private selectedIndex = 0;
  private focusedValue = false;

  get focused() {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.searchInput.focused = value;
  }

  constructor(
    private readonly items: ModelItem[],
    private readonly current: Model<any> | undefined,
    private readonly keybindings: any,
    private readonly done: (value: string | undefined) => void,
  ) {
    super();
    this.filtered = items;
    this.addChild(new Text("Select prewalk executor", 0, 0));
    this.addChild(new Text("Type to filter · Enter selects · Esc cancels", 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.updateList();
  }

  handleInput(keyData: string) {
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filtered.length) this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      if (this.filtered.length) this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.filter(this.searchInput.getValue());
  }

  private filter(query: string) {
    this.filtered = query ? fuzzyFilter(this.items, query, modelSearchText) : this.items;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.updateList();
  }

  private selectCurrent() {
    const selected = this.filtered[this.selectedIndex];
    if (selected) this.done(modelLabel(selected.model));
  }

  private updateList() {
    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filtered[i];
      if (!item) continue;
      const selected = i === this.selectedIndex;
      const current = this.current?.provider === item.provider && this.current?.id === item.id;
      this.listContainer.addChild(new Text(`${selected ? "→" : " "} ${item.id} [${item.provider}]${current ? " ✓" : ""}`, 0, 0));
    }
    if (!this.filtered.length) this.listContainer.addChild(new Text("  No matching models", 0, 0));
    else {
      const item = this.filtered[this.selectedIndex];
      if (item) {
        this.listContainer.addChild(new Spacer(1));
        this.listContainer.addChild(new Text(`  Model Name: ${item.model.name || item.id}`, 0, 0));
        this.listContainer.addChild(new Text(`  (${this.selectedIndex + 1}/${this.filtered.length})`, 0, 0));
      }
    }
  }
}

export default function prewalk(pi: ExtensionAPI) {
  pi.registerEntryRenderer("prewalk-status", (entry, _options, theme) => {
    const data = entry.data as { phase: "handoff" | "restored"; guide: string; executor: string };
    const text = data.phase === "handoff"
      ? `⇢ Prewalk handoff: ${data.guide} → ${data.executor}`
      : `⇠ Prewalk restored: ${data.executor} → ${data.guide}`;
    return new Text(theme.fg(data.phase === "handoff" ? "accent" : "success", text), 0, 0);
  });

  // ── Footer section ─────────────────────────────────────────────

  Footer.registerSection({
    id: "prewalk",
    align: "right",
    priority: 5, // rightmost position
    render: (_ctx, theme) => {
      if (!armed && !swapped && !handoffActive) return "";
      if (handoffActive) {
        return theme.fg("success", `⚡ ${target}`);
      }
      if (swapped) {
        return theme.fg("warning", `→ ${target}`);
      }
      // armed
      if (target) {
        const levelHint = executorThinkingLevel ? `@${executorThinkingLevel}` : "";
        return theme.fg("warning", `🔍 ${target}${levelHint}`);
      }
      return theme.fg("warning", "🔍 prewalk");
    },
  });

  pi.registerFlag("prewalk", {
    description: "Use a frontier model to explore, then hand off after the first edit",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("prewalk-into", {
    description: "Executor model as provider/model (for example google/gemini-2.5-flash)",
    type: "string",
  });

  let enabled = false;
  let armed = false;
  let swapped = false;
  let handoffActive = false;
  let todoSeen = false;
  let target = "";
  let guideModel = "";
  let guideThinkingLevel: ThinkingLevel | undefined;
  let executorThinkingLevel: ThinkingLevel | undefined;

  const reset = () => {
    armed = false;
    swapped = false;
    handoffActive = false;
    todoSeen = false;
    target = "";
    guideModel = "";
    guideThinkingLevel = undefined;
    executorThinkingLevel = undefined;
  };

  const arm = (ctx: ExtensionContext, model?: string, level?: ThinkingLevel) => {
    if (armed || swapped || handoffActive) {
      ctx.ui.notify("Prewalk is already active", "info");
      return;
    }
    enabled = true;
    armed = true;
    swapped = false;
    handoffActive = false;
    target = model?.trim() || String(pi.getFlag("prewalk-into") || "");
    guideModel = `${ctx.model.provider}/${ctx.model.id}`;
    guideThinkingLevel = pi.getThinkingLevel();

    executorThinkingLevel = level;

    const levelHint = executorThinkingLevel ? `@${executorThinkingLevel}` : "";
    ctx.ui.setStatus("prewalk", target ? `Waiting for todo + edit → ${target}${levelHint}` : "Waiting for todo + edit");
    ctx.ui.notify(
      target
        ? `Prewalk armed → ${target}${levelHint}; waiting for todo + first edit`
        : "Prewalk armed; set an executor with --prewalk-into provider/model",
      "info",
    );
    Footer.invalidate();
  };

  const restoreGuideModel = async (ctx: ExtensionContext) => {
    const slash = guideModel.indexOf("/");
    const original = slash > 0
      ? ctx.modelRegistry.find(guideModel.slice(0, slash), guideModel.slice(slash + 1))
      : undefined;
    const ok = Boolean(original && await pi.setModel(original));
    if (ok && guideThinkingLevel) {
      pi.setThinkingLevel(guideThinkingLevel as ThinkingLevel);
    }
    return ok;
  };

  const rearm = (ctx: ExtensionContext, model = target, level = executorThinkingLevel) => {
    if (!enabled) return;
    reset();
    arm(ctx, model, level);
  };

  const disarm = async (ctx: ExtensionContext) => {
    const wasActive = armed || swapped || handoffActive;
    const shouldRestore = handoffActive && guideModel;
    enabled = false;
    const restored = shouldRestore ? await restoreGuideModel(ctx) : false;
    reset();
    ctx.ui.setStatus("prewalk", undefined);
    Footer.invalidate();
    if (!wasActive) ctx.ui.notify("Prewalk was not armed", "info");
    else if (shouldRestore && restored) ctx.ui.notify("Prewalk disarmed; restored guide model", "info");
    else if (shouldRestore) ctx.ui.notify("Prewalk disarmed; could not restore guide model", "warning");
    else ctx.ui.notify("Prewalk disarmed", "info");
  };

  pi.registerCommand("prewalk", {
    description: "Explore deeply, create a small todo plan, then hand off after the first edit",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (["off", "disarm", "disable", "cancel"].includes(raw.toLowerCase())) {
        await disarm(ctx);
        return;
      }
      const parts = raw ? raw.split(/\s+/) : [];
      let task = raw;
      let model = "";
      let level: ThinkingLevel | undefined;

      // An explicit provider/model keeps the non-interactive command form.
      const explicit = parts[0]?.match(/^([^/]+)\/(.+)$/);
      if (explicit) {
        model = explicit[0];
        parts.shift();
        task = parts.join(" ");
      }

      if (!model) model = String(pi.getFlag("prewalk-into") || "");

      if (!model) {
        const available = ctx.modelRegistry
          .getAvailable()
          .filter((candidate) => ctx.modelRegistry.hasConfiguredAuth(candidate))
          .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
        const items = available.map((candidate) => ({
          provider: candidate.provider,
          id: candidate.id,
          model: candidate,
        }));
        const choice = ctx.mode === "tui"
          ? await ctx.ui.custom<string | undefined>(
              (_tui, _theme, keybindings, done) => new LiveModelPicker(items, ctx.model, keybindings, done),
            )
          : await ctx.ui.select("Select prewalk executor", items.map((item) => modelLabel(item.model)));
        if (!choice) return;
        model = choice;

        const selectedLevel = await ctx.ui.select(
          "Select prewalk thinking level",
          [...THINKING_LEVELS],
        );
        if (!selectedLevel) return;
        level = selectedLevel as ThinkingLevel;
      }

      arm(ctx, model, level);
      if (task) await pi.sendUserMessage(task);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("prewalk")) arm(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled || !armed || swapped) return;
    return {
      message: {
        customType: "prewalk",
        display: false,
        content: `${MARKER}\nYou are the guide in a prewalk handoff. Explore the task deeply using the repository and tools. Before acting, use the todo tool to create a concise checklist with no more than ${MAX_TODO_ITEMS} concrete items; include a validation step for every implementation item. Then begin execution. Do not write a prose plan file. Make the first valid edit as soon as your approach is grounded.`,
      },
    };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!enabled || !armed || swapped) return;

    for (const result of event.toolResults) {
      if (!result.isError && result.toolName === "todo") todoSeen = true;
    }
    const action = event.toolResults.find((result) =>
      !result.isError && (result.toolName === "edit" || result.toolName === "write"),
    );
    // Keep the frontier model in place until it has committed the requested
    // checklist. A turn may contain the todo and edit together.
    if (!action || !todoSeen) return;

    swapped = true;
    armed = false;
    const slash = target.indexOf("/");
    if (slash < 1) {
      ctx.ui.notify("Prewalk: first edit landed; no valid executor model configured", "warning");
      rearm(ctx);
      return;
    }
    const model = ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1));
    if (!model || !(await pi.setModel(model))) {
      ctx.ui.notify(`Prewalk: could not select executor ${target}`, "error");
      rearm(ctx);
      return;
    }
    // Apply executor thinking level if one was configured
    if (executorThinkingLevel) {
      pi.setThinkingLevel(executorThinkingLevel as ThinkingLevel);
    }

    handoffActive = true;
    const levelHint = executorThinkingLevel ? `@${executorThinkingLevel}` : "";
    ctx.ui.setStatus("prewalk", `Executor: ${target}${levelHint}`);
    pi.appendEntry("prewalk-status", { phase: "handoff", guide: guideModel, executor: target });
    ctx.ui.notify(`Prewalk handoff active → ${target}${levelHint}`, "info");
    Footer.invalidate();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled || !handoffActive) return;
    const completedGuide = guideModel;
    const completedExecutor = target;
    const completedLevel = executorThinkingLevel;
    const restored = await restoreGuideModel(ctx);
    if (!enabled) return;
    handoffActive = false;
    ctx.ui.setStatus("prewalk", undefined);
    if (restored) {
      pi.appendEntry("prewalk-status", { phase: "restored", guide: completedGuide, executor: completedExecutor });
      ctx.ui.notify(`Prewalk complete; restored guide model → ${completedGuide}`, "info");
    } else {
      ctx.ui.notify(`Prewalk complete; could not restore guide model ${completedGuide}`, "warning");
    }
    // Handoff is a single cycle, not the end of prewalk. Keep the extension
    // armed for the next user task until they explicitly run `/prewalk off`.
    rearm(ctx, completedExecutor, completedLevel);
    Footer.invalidate();
  });

  pi.on("context", async (event) => {
    if (!swapped) return;
    return {
      messages: event.messages.filter((message) =>
        !(message.role === "custom" && typeof message.content === "string" && message.content.includes(MARKER)),
      ),
    };
  });
}
