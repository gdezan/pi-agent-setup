/**
 * Floating usage overview, opened by bare `/usage`.
 *
 * One card per tracked provider, mirroring the scoutr usage screen: a bar per
 * quota window with the fill at used-percent and a light vertical guide (╂)
 * marking where usage "should" be by elapsed time — 20% into a 5h window after
 * one hour. Balance-style windows (DeepSeek wallet, Copilot credits without a
 * limit) render as an amount row instead of a bar. Failed providers are
 * omitted from the list and summarized in a small muted line.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Snapshot, Window } from "./types.ts";
import { clampPercent } from "./types.ts";
import { countdown, windowTimeProgress } from "./windows.ts";

export type UsagePopupRow = {
  name: string;
  snapshot?: Snapshot;
  error?: string;
};

export interface UsagePopupDeps {
  theme: Theme;
  /** Close the popup. */
  done: () => void;
  /** Schedule a TUI re-render (live data arrived, minute tick, refresh). */
  requestRender: () => void;
  /** Live provider state; read on every render. */
  getRows: () => UsagePopupRow[];
  /** Kick an all-provider refresh; the caller reports completion via requestRender. */
  refresh: () => void;
  isRefreshing: () => boolean;
}

const PREFERRED_INNER = 58;
export const USAGE_POPUP_WIDTH = PREFERRED_INNER + 2;
const MIN_INNER = 40;
const MAX_LABEL_WIDTH = 14;
const MIN_BAR_WIDTH = 8;
const TICK_MS = 30_000;

type WindowLayout = {
  labelWidth: number;
  barWidth: number;
  percentWidth: number;
  amountWidth: number;
  resetWidth: number;
};
/** Thresholds mirror the footer: used ≥ 90% errors, ≥ 75% warns. */
function usedColor(theme: Theme, usedPercent: number): (text: string) => string {
  if (usedPercent >= 90) return (text) => theme.fg("error", text);
  if (usedPercent >= 75) return (text) => theme.fg("warning", text);
  return (text) => theme.fg("success", text);
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** A bar with the fill at used-percent and the elapsed-time guide overlaid. */
function renderBar(
  theme: Theme,
  usedPercent: number,
  timeProgress: number | undefined,
  width: number,
): string {
  const clamped = clampPercent(usedPercent);
  const filled = Math.round((clamped / 100) * width);
  const color = usedColor(theme, clamped);
  const markerIndex =
    timeProgress === undefined
      ? undefined
      : Math.min(width - 1, Math.max(0, Math.round(timeProgress * width)));
  let out = "";
  for (let i = 0; i < width; i++) {
    if (i === markerIndex) out += theme.fg("dim", "╂");
    else if (i < filled) out += color("━");
    else out += theme.fg("dim", "─");
  }
  return out;
}

function updatedLabel(updatedAt: number): string {
  if (updatedAt <= 0) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
  if (minutes === 0) return "updated now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

function compactFailure(error: string | undefined): string {
  if (!error) return "unavailable";
  if (/\b(?:not configured|not set)\b/i.test(error)) return "not configured";
  return error;
}

function creditAmountText(window: Window): string {
  if (window.amount === undefined || window.limitAmount === undefined || window.limitAmount <= 0)
    return "";
  return `${window.amount.toFixed(0)}cr/${window.limitAmount.toFixed(0)}cr`;
}

function displayedUsedPercent(window: Window): number {
  if (window.amount !== undefined && window.limitAmount !== undefined && window.limitAmount > 0) {
    return (window.amount / window.limitAmount) * 100;
  }
  return window.usedPercent;
}

export class UsagePopup implements Component {
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private readonly getRows: () => UsagePopupRow[];
  private readonly refresh: () => void;
  private readonly isRefreshing: () => boolean;
  private tick: ReturnType<typeof setInterval> | undefined;

  constructor(deps: UsagePopupDeps) {
    this.theme = deps.theme;
    this.done = deps.done;
    this.requestRender = deps.requestRender;
    this.getRows = deps.getRows;
    this.refresh = deps.refresh;
    this.isRefreshing = deps.isRefreshing;
    // Keep countdowns and the elapsed-time guide honest while the popup is open.
    this.tick = setInterval(deps.requestRender, TICK_MS);
    this.tick.unref?.();
    deps.refresh();
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }
    if (data === "r" && !this.isRefreshing()) {
      this.refresh();
      this.requestRender();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Two border cells sit outside the content area; fill the overlay width.
    const inner = Math.min(PREFERRED_INNER, Math.max(MIN_INNER, width - 2));
    const rows = this.getRows();
    const visibleRows = rows.filter((row) => row.error === undefined);
    const failedRows = rows.filter((row) => row.error !== undefined);

    // Longest window label drives the label column across all providers.
    let labelWidth = 4;
    for (const row of visibleRows) {
      for (const window of row.snapshot?.windows ?? []) {
        labelWidth = Math.max(labelWidth, visibleWidth(window.label));
      }
    }
    labelWidth = Math.min(labelWidth, MAX_LABEL_WIDTH);

    const windows = visibleRows.flatMap((row) => row.snapshot?.windows ?? []);
    const percentWidth = Math.max(
      3,
      ...windows.map(
        (window) => `${Math.round(clampPercent(displayedUsedPercent(window)))}%`.length,
      ),
    );
    const amountWidth = Math.max(
      0,
      ...windows.map((window) => visibleWidth(creditAmountText(window))),
    );
    const resetWidth = Math.max(
      0,
      ...windows.map((window) => visibleWidth(countdown(window.resetAt))),
    );
    const fixedWidth =
      labelWidth +
      1 +
      1 +
      1 +
      percentWidth +
      (amountWidth > 0 ? amountWidth + 1 : 0) +
      (resetWidth > 0 ? resetWidth + 1 : 0);
    const barWidth = Math.max(MIN_BAR_WIDTH, inner - 4 - fixedWidth);
    const layout: WindowLayout = { labelWidth, barWidth, percentWidth, amountWidth, resetWidth };

    const lines: string[] = [];
    const border = (text: string) => this.theme.fg("border", text);
    // Keep one padding cell on each side of content inside the borders.
    const row = (content: string) =>
      border("│") + padEnd(` ${truncateToWidth(content, inner - 2)}`, inner) + border("│");

    const title =
      this.theme.fg("accent", "Provider usage") +
      (this.isRefreshing() ? this.theme.fg("dim", "  ↻ refreshing") : "");
    lines.push(border(`╭${"─".repeat(inner)}╮`));
    lines.push(row(title));
    lines.push(row(""));

    for (const providerRow of visibleRows) {
      const hasWindows = (providerRow.snapshot?.windows.length ?? 0) > 0;
      const updated = this.theme.fg("dim", updatedLabel(providerRow.snapshot?.updatedAt ?? 0));
      // Budget inside row(): one left pad, header, two gaps, updated, one right pad.
      const headerText = padEnd(
        this.theme.fg("accent", providerRow.name),
        Math.max(10, inner - 4 - visibleWidth(updated)),
      );
      lines.push(row(headerText + "  " + updated));

      if (hasWindows) {
        for (const window of providerRow.snapshot!.windows) {
          lines.push(row("  " + this.windowLine(window, layout)));
        }
      } else {
        lines.push(row(`  ${this.theme.fg("dim", "no data")}`));
      }

      lines.push(row(""));
    }

    if (failedRows.length > 0) {
      const hidden = failedRows
        .map(({ name, error }) => `${name} (${compactFailure(error)})`)
        .join(", ");
      lines.push(row(this.theme.fg("dim", `hidden: ${hidden}`)));
    }

    lines.push(row(this.theme.fg("dim", "esc close · r refresh")));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private windowLine(window: Window, layout: WindowLayout): string {
    const theme = this.theme;
    const label = padEnd(this.theme.fg("dim", window.label), layout.labelWidth + 1);

    // Wallet rows (DeepSeek balance): amount only, error color when negative.
    if (window.amount !== undefined && window.limitAmount === undefined) {
      const negative = window.amount < 0;
      const symbol = window.currency === "CNY" ? "¥" : window.currency === "USD" ? "$" : "";
      const text =
        window.currency === "cr"
          ? `${window.amount.toFixed(0)} cr${negative ? " in debt" : ""}`
          : `${symbol}${Math.abs(window.amount).toFixed(2)}${negative ? " in debt" : ""}`;
      return label + " " + theme.fg(negative ? "error" : "success", text);
    }

    // Credit plans with a declared allowance (Copilot): bar of used/limit.
    const usedPercent = displayedUsedPercent(window);
    const pct = `${Math.round(clampPercent(usedPercent))}%`;
    const amountText = creditAmountText(window);
    const reset = countdown(window.resetAt);
    const timeProgress = windowTimeProgress(window, Math.floor(Date.now() / 1000));
    const color = usedColor(theme, clampPercent(usedPercent));
    const value =
      padStart(color(pct), layout.percentWidth) +
      (layout.amountWidth > 0 ? ` ${padEnd(amountText, layout.amountWidth)}` : "");
    const resetColumn =
      layout.resetWidth > 0 ? ` ${theme.fg("dim", padEnd(reset, layout.resetWidth))}` : "";

    const bar = renderBar(theme, usedPercent, timeProgress, layout.barWidth);
    return `${label} ${bar} ${value}${resetColumn}`;
  }
}
