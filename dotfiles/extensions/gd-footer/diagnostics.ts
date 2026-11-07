/**
 * Footer diagnostic sink.
 *
 * The footer owns the bottom line of a fullscreen alt-screen TUI. Writing to
 * the console from a render or registration callback splices raw, unstyled,
 * often multi-line text straight into the live frame, on top of the input
 * field, and the frame stays corrupted until something forces a full redraw.
 * So the footer never logs to the console.
 *
 * Problems go here instead: a bounded in-memory record for the footer to
 * surface as a marker, plus an appended JSONL file for the full stack.
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const LOG_FILE_NAME = "pi-footer-errors.jsonl";
/** Rotate once the log passes this size so a failing section cannot fill the disk. */
const MAX_LOG_BYTES = 512 * 1024;
/** Distinct problems kept in memory for the footer marker. */
const MAX_TRACKED = 20;

export interface FooterProblem {
  /** Stable identity, so a fault that repeats every frame is tracked once. */
  key: string;
  /** One display-safe line, e.g. `section "pi-footer:path" threw`. */
  summary: string;
  /** How many times this problem has been observed. */
  count: number;
  /** Most recent observation, for the log and for staleness checks. */
  lastSeen: number;
}

const TRACK_KEY = Symbol.for("pi.footer.diagnostics");
type DiagnosticsState = { problems: Map<string, FooterProblem> };

const state = ((globalThis as typeof globalThis & Record<symbol, DiagnosticsState | undefined>)[
  TRACK_KEY
] ??= {
  problems: new Map(),
});

export function logPath(): string {
  return join(getAgentDir(), "logs", LOG_FILE_NAME);
}

function appendLog(problem: FooterProblem, detail: unknown): void {
  try {
    const file = logPath();
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, "");
    } catch {
      // No log yet, so there is nothing to rotate.
    }
    appendFileSync(
      file,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        summary: problem.summary,
        count: problem.count,
        detail: detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail),
        stack: detail instanceof Error ? detail.stack : undefined,
      })}\n`,
    );
  } catch {
    // Diagnostics must never be the reason a render fails.
  }
}

/** Record a footer problem. Safe to call on every render; repeats are counted. */
export function report(key: string, summary: string, detail?: unknown): void {
  const existing = state.problems.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = Date.now();
    return;
  }
  const problem: FooterProblem = { key, summary, count: 1, lastSeen: Date.now() };
  state.problems.set(key, problem);
  // Keep the map bounded; drop the oldest observation rather than growing forever.
  while (state.problems.size > MAX_TRACKED) {
    const oldest = state.problems.keys().next();
    if (oldest.done) break;
    state.problems.delete(oldest.value);
  }
  appendLog(problem, detail);
}

/** Problems seen within the window, newest first. */
export function activeProblems(windowMs = 60_000): FooterProblem[] {
  const cutoff = Date.now() - windowMs;
  return [...state.problems.values()]
    .filter((problem) => problem.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export function clearProblems(): void {
  state.problems.clear();
}
