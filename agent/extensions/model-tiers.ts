import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { Footer } from "./pi-footer/footer.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type RoleId = "fast" | "daily" | "smart";

type ModelTierRole = {
  id: RoleId;
  label: string;
  icon?: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
};

type ModelTiersConfig = { roles: ModelTierRole[] };
type PickerItem = { value: string; label: string; description?: string; searchText?: string };

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "model-tiers.json");
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_CONFIG: ModelTiersConfig = {
  roles: [
    { id: "fast", label: "Fast", icon: "⚡", provider: "opencode-go", model: "deepseek-v4-flash", thinkingLevel: "high" },
    { id: "daily", label: "Daily", icon: "●", provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "high" },
    { id: "smart", label: "Smart", icon: "◆", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium" },
  ],
};

function writeJsonAtomic(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function loadConfig(): ModelTiersConfig {
  let raw: ModelTiersConfig = DEFAULT_CONFIG;
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ModelTiersConfig;
    } catch {
      raw = DEFAULT_CONFIG;
    }
  }
  const byId = new Map((raw.roles || []).map((role) => [role.id, role]));
  return { roles: DEFAULT_CONFIG.roles.map((fallback) => ({ ...fallback, ...(byId.get(fallback.id) || {}) })) };
}

function saveConfig(config: ModelTiersConfig) {
  writeJsonAtomic(CONFIG_PATH, config);
}

function modelKey(provider: string, model: string) {
  return `${provider}/${model}`;
}

function roleKey(role: ModelTierRole) {
  return modelKey(role.provider, role.model);
}

function roleDescription(role: ModelTierRole) {
  return `${roleKey(role)}${role.thinkingLevel ? ` · thinking:${role.thinkingLevel}` : ""}`;
}

function supportedThinkingLevels(model: Model<any> | undefined): ThinkingLevel[] {
  if (!model) return THINKING_LEVELS;
  if (!model.reasoning) return ["off"];
  const map = (model as Model<any> & { thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }).thinkingLevelMap;
  if (!map) return THINKING_LEVELS;
  return ["off", ...THINKING_LEVELS.filter((level) => level !== "off" && map[level] != null)];
}

function findRole(config: ModelTiersConfig, model: Model<any> | undefined) {
  if (!model) return undefined;
  return config.roles.find((role) => role.provider === model.provider && role.model === model.id);
}

function modelSearchText(item: PickerItem) {
  return `${item.label} ${item.value} ${item.description || ""} ${item.searchText || ""}`;
}

class LivePicker extends Container {
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private filtered: PickerItem[];
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
    private readonly title: string,
    private readonly items: PickerItem[],
    private readonly keybindings: any,
    private readonly theme: any,
    private readonly done: (value: string | undefined) => void,
  ) {
    super();
    this.filtered = items;
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
    this.addChild(new Text(theme.fg("dim", "Type to filter · Enter selects · Esc cancels"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.updateList();
  }

  handleInput(data: string) {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length) this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length) this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    this.searchInput.handleInput(data);
    this.filtered = this.searchInput.getValue()
      ? fuzzyFilter(this.items, this.searchInput.getValue(), modelSearchText)
      : this.items;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.updateList();
  }

  private selectCurrent() {
    const selected = this.filtered[this.selectedIndex];
    if (selected) this.done(selected.value);
  }

  private updateList() {
    this.listContainer.clear();
    const maxVisible = 12;
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filtered[i];
      if (!item) continue;
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      this.listContainer.addChild(new Text(`${prefix}${label}`, 0, 0));
    }

    if (!this.filtered.length) {
      this.listContainer.addChild(new Text(this.theme.fg("warning", "  No matching models"), 0, 0));
    } else {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(this.theme.fg("dim", `  ${this.selectedIndex + 1}/${this.filtered.length}`), 0, 0));
    }
  }
}

async function selectItem(ctx: ExtensionContext, title: string, items: PickerItem[]) {
  if (ctx.mode !== "tui") {
    const labels = items.map((item) => `${item.label}${item.description ? ` — ${item.description}` : ""}`);
    const choice = await ctx.ui.select(title, labels);
    const index = choice ? labels.indexOf(choice) : -1;
    return index >= 0 ? items[index]?.value : undefined;
  }

  return ctx.ui.custom<string | undefined>(
    (_tui, theme, keybindings, done) => new LivePicker(title, items, keybindings, theme, done),
  );
}

export default function modelTiers(pi: ExtensionAPI) {
  let config = loadConfig();
  let cycleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let cycleQueue = Promise.resolve();
  let currentRoleIndex = -1;

  Footer.registerSection({
    id: "model-tier",
    align: "right",
    priority: 25,
    render: (ctx, theme) => {
      const role = findRole(config, ctx.model);
      if (!role) return "";
      const icon = role.icon ? `${role.icon} ` : "";
      return theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${icon}${role.label.toUpperCase()} `)));
    },
  });

  function updateStatus(ctx: ExtensionContext) {
    const role = findRole(config, ctx.model);
    const level = pi.getThinkingLevel();
    const text = role
      ? `${role.icon ? `${role.icon} ` : ""}${role.label.toUpperCase()} · ${role.model} · ${level}`
      : `model:${ctx.model?.id || "none"} · ${level}`;
    ctx.ui.setStatus("model-tier", ctx.ui.theme.fg(role ? "accent" : "dim", text));
    Footer.invalidate();
  }

  function showCycleTrack(ctx: ExtensionContext, activeRole: RoleId) {
    if (cycleTimer) clearTimeout(cycleTimer);
    const track = config.roles.map((role) => role.id === activeRole ? `● ${role.label}` : `○ ${role.label}`).join("  ");
    ctx.ui.setWidget("model-tier-cycle", [ctx.ui.theme.fg("accent", track)]);
    cycleTimer = setTimeout(() => ctx.ui.setWidget("model-tier-cycle", undefined), 1400);
  }

  async function applyRole(ctx: ExtensionContext, role: ModelTierRole) {
    const model = ctx.modelRegistry.find(role.provider, role.model);
    if (!model) {
      ctx.ui.notify(`Model tier ${role.label}: ${roleKey(role)} was not found`, "warning");
      return false;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`Model tier ${role.label}: no auth for ${roleKey(role)}`, "warning");
      return false;
    }
    if (!(await pi.setModel(model))) return false;
    if (role.thinkingLevel) pi.setThinkingLevel(role.thinkingLevel);
    updateStatus(ctx);
    showCycleTrack(ctx, role.id);
    return true;
  }

  async function cycleRole(ctx: ExtensionContext, direction: "forward" | "backward") {
    if (disposed) return;
    config = loadConfig();
    const available = config.roles
      .map((role) => ({ role, model: ctx.modelRegistry.find(role.provider, role.model) }))
      .filter((entry): entry is { role: ModelTierRole; model: Model<any> } => Boolean(entry.model && ctx.modelRegistry.hasConfiguredAuth(entry.model)));
    if (available.length === 0) return;

    // If tracked index is stale, sync it from the current model
    if (currentRoleIndex < 0 || currentRoleIndex >= available.length) {
      currentRoleIndex = available.findIndex(
        (entry) => entry.model.provider === ctx.model?.provider && entry.model.id === ctx.model?.id,
      );
    }

    const step = direction === "forward" ? 1 : -1;
    const nextIndex = (currentRoleIndex + step + available.length) % available.length;
    currentRoleIndex = nextIndex;

    const next = available[nextIndex];
    if (next) await applyRole(ctx, next.role);
  }

  class TierEditor extends CustomEditor {
    constructor(
      tui: any,
      theme: any,
      private readonly tierKeybindings: any,
      private readonly ctx: ExtensionContext,
    ) {
      super(tui, theme, tierKeybindings);
    }

    handleInput(data: string) {
      if (this.ctx.mode === "tui" && this.keyMatches(data, "app.model.cycleForward")) {
        cycleQueue = cycleQueue.then(() => cycleRole(this.ctx, "forward")).catch(() => undefined);
        return;
      }
      if (this.ctx.mode === "tui" && this.keyMatches(data, "app.model.cycleBackward")) {
        cycleQueue = cycleQueue.then(() => cycleRole(this.ctx, "backward")).catch(() => undefined);
        return;
      }
      super.handleInput(data);
    }

    private keyMatches(data: string, action: string) {
      return this.tierKeybindings.matches(data, action);
    }
  }

  pi.registerCommand("model-tier", {
    description: "Select Fast, Daily, or Smart model tier",
    handler: async (_args, ctx) => {
      config = loadConfig();
      const active = findRole(config, ctx.model)?.id;
      const value = await selectItem(ctx, "Select model tier", config.roles.map((role) => ({
        value: role.id,
        label: `${role.icon ? `${role.icon} ` : ""}${role.label}${role.id === active ? " (active)" : ""}`,
        description: roleDescription(role),
      })));
      const role = config.roles.find((candidate) => candidate.id === value);
      if (role) await applyRole(ctx, role);
    },
  });

  pi.registerCommand("model-tiers", {
    description: "Configure Fast, Daily, and Smart model tiers",
    handler: async (_args, ctx) => {
      config = loadConfig();
      const roleId = await selectItem(ctx, "Configure which tier?", config.roles.map((role) => ({
        value: role.id,
        label: `${role.icon ? `${role.icon} ` : ""}${role.label}`,
        description: roleDescription(role),
      })));
      const roleIndex = config.roles.findIndex((role) => role.id === roleId);
      if (roleIndex < 0) return;

      const available = ctx.modelRegistry.getAvailable().sort((a, b) => modelKey(a.provider, a.id).localeCompare(modelKey(b.provider, b.id)));
      const selectedModel = await selectItem(ctx, `Model for ${config.roles[roleIndex].label}`, available.map((model) => ({
        value: modelKey(model.provider, model.id),
        label: `${model.id} [${model.provider}]${model.provider === config.roles[roleIndex].provider && model.id === config.roles[roleIndex].model ? " (current)" : ""}`,
        description: model.name || modelKey(model.provider, model.id),
      })));
      if (!selectedModel) return;

      const slash = selectedModel.indexOf("/");
      const selectedProvider = selectedModel.slice(0, slash);
      const selectedId = selectedModel.slice(slash + 1);
      const selectedModelDefinition = ctx.modelRegistry.find(selectedProvider, selectedId);
      const levels = supportedThinkingLevels(selectedModelDefinition);
      const thinkingLevel = await selectItem(ctx, `Thinking for ${config.roles[roleIndex].label}`, levels.map((level) => ({
        value: level,
        label: `${level}${level === config.roles[roleIndex].thinkingLevel ? " (current)" : ""}`,
        description: `Use ${level} thinking for this tier`,
      })));
      if (!thinkingLevel) return;

      config.roles[roleIndex] = {
        ...config.roles[roleIndex],
        provider: selectedModel.slice(0, slash),
        model: selectedModel.slice(slash + 1),
        thinkingLevel: thinkingLevel as ThinkingLevel,
      };
      saveConfig(config);
      updateStatus(ctx);
      ctx.ui.notify(`Saved ${config.roles[roleIndex].label}. Ctrl+P now uses the updated tier cycle.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    cycleQueue = Promise.resolve();
    currentRoleIndex = -1;
    config = loadConfig();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new TierEditor(tui, theme, keybindings, ctx));
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    config = loadConfig();
    currentRoleIndex = -1;
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    if (cycleTimer) clearTimeout(cycleTimer);
    cycleTimer = undefined;
    ctx.ui.setWidget("model-tier-cycle", undefined);
    Footer.unregisterSection("model-tier");
  });
}
