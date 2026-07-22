import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/**
 * A section rendered in the footer. Each section produces a single string
 * (no newlines) that is assembled left-to-right with pipe separators.
 */
export interface Section {
  /** Unique identifier. Used for unregister and debugging. */
  id: string;

  /** Which side of the footer the section appears on. */
  align: "left" | "right";

  /** Lower numbers = closer to the edge. Left: 0 is leftmost. Right: 0 is rightmost. */
  priority: number;

  /**
   * Return a single-line styled string (no newlines, ANSI ok).
   * The footer handles truncation if the total exceeds terminal width.
   */
  render(ctx: ExtensionContext, theme: Theme): string;

  /** Optional cleanup when the section is unregistered. */
  dispose?(): void;
}

/** Returned by registerSection so the caller can trigger re-renders. */
export interface SectionHandle {
  invalidate(): void;
  unregister(): void;
}
