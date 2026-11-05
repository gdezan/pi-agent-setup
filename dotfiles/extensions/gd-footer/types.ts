import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Available detail levels for a responsive footer section. */
export type FooterSectionVariant = "full" | "compact" | "minimal";

/**
 * A section rendered in the footer. Each variant produces a single string
 * (no newlines) that is assembled left-to-right with pipe separators.
 */
export interface Section {
  /** Unique identifier. Used for unregister and debugging. */
  id: string;

  /** Which side of the footer the section appears on. */
  align: "left" | "right";

  /** Left-to-right display order within the aligned group. */
  order: number;

  /** Essential sections remain visible while auxiliary sections may be removed. */
  essential?: boolean;

  /** Detail levels supported by this section, from most to least detailed. */
  variants?: readonly FooterSectionVariant[];

  /**
   * Return a single-line styled string (no newlines, ANSI ok) for the requested
   * detail level. The footer handles fitting and final safety truncation.
   */
  render(ctx: ExtensionContext, theme: Theme, variant: FooterSectionVariant): string;

  /** Optional cleanup when the section is unregistered. */
  dispose?(): void;
}

/** Returned by registerSection so the caller can trigger re-renders. */
export interface SectionHandle {
  invalidate(): void;
  unregister(): void;
}
