/**
 * Runtime check for the footer layout engine against its failure modes.
 *
 * Run: node --experimental-strip-types footer.render-check.ts
 *
 * The point is the terminal, not the return value: a live alt-screen TUI owns fd 1,
 * so any byte these paths write outside the TUI's own render lands unframed on the
 * screen. This check captures fd 1 and fd 2 for the whole run and fails if a single
 * byte escapes, which is the failure reported as a multi-line error pasted over the
 * input box.
 */

import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Footer } from "./footer.ts";
import type { Section } from "./types.ts";

const CAPTURED: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);

function capture(stream: NodeJS.WriteStream): void {
  (stream as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    CAPTURED.push(String(chunk));
    return true;
  };
}
capture(process.stdout);
capture(process.stderr);

// A realistic theme: real SGR sequences, because visibleWidth() has to measure
// through them. A pass-through stub theme hides any bug in the escape handling.
const SGR: Record<string, [number, number, number]> = {
  dim: [102, 102, 102],
  muted: [128, 128, 128],
  accent: [138, 190, 183],
  warning: [255, 165, 0],
  success: [126, 200, 126],
  error: [255, 90, 90],
  selectedBg: [60, 60, 60],
};
const theme = {
  fg: (color: string, text: string) =>
    `\x1b[38;2;${(SGR[color] ?? SGR.muted).join(";")}m${text}\x1b[39m`,
  bg: (color: string, text: string) =>
    `\x1b[48;2;${(SGR[color] ?? SGR.muted).join(";")}m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as never;
const ctx = {} as never;
const WIDTH = 80;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function section(over: Partial<Section> & Pick<Section, "id">): Section {
  return { align: "left", order: 10, render: () => "", ...over } as Section;
}

let failures = 0;

function check(name: string, run: () => void): void {
  const before = CAPTURED.length;
  try {
    run();
    const leaked = CAPTURED.slice(before);
    if (leaked.length > 0) {
      failures += 1;
      realWrite(
        "FAIL " +
          name +
          ": wrote to the terminal: " +
          JSON.stringify(leaked.join("").slice(0, 300)) +
          "\n",
      );
    } else {
      realWrite("ok   " + name + "\n");
    }
  } catch (error) {
    failures += 1;
    realWrite(
      "FAIL " + name + ": " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
  }
}

check("a throwing section stays on one line and is recorded", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(
    section({
      id: "check:thrower",
      render: () => {
        throw new Error("provider-usage exploded");
      },
    }),
  );
  const lines = Footer.render(ctx, theme, WIDTH);
  assert.equal(lines.length, 1, "footer must stay a single row");
  assert.ok(
    !stripAnsi(lines.join("|")).includes("exploded"),
    "message must not be dumped into the footer body",
  );
  assert.ok(
    stripAnsi(lines[0]).includes("footer fault"),
    "a visible single-line marker must replace the failed section",
  );
  const d = Footer.getDiagnostics();
  assert.equal(d.length, 1);
  assert.ok(d[0].summary.includes("check:thrower"), d[0].summary);
  assert.ok(!d[0].summary.includes("    at "), "no stack frames may reach the summary");
  h.unregister();
});

check("a section returning newlines cannot add footer rows", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(
    section({ id: "check:multiline", render: () => "top\nbottom\rmore" }),
  );
  const lines = Footer.render(ctx, theme, WIDTH);
  assert.equal(lines.length, 1, "footer must stay a single row");
  assert.ok(!/[\r\n]/.test(lines[0]), "no control newlines may reach the terminal");
  assert.ok(stripAnsi(lines[0]).includes("top bottom more"), stripAnsi(lines[0]));
  h.unregister();
});

check("a re-registered section id is recorded, not printed", () => {
  Footer.clearDiagnostics();
  const a = Footer.registerSection(section({ id: "check:dup", render: () => "a" }));
  const b = Footer.registerSection(section({ id: "check:dup", render: () => "b" }));
  const d = Footer.getDiagnostics();
  assert.equal(d.length, 1, JSON.stringify(d));
  assert.ok(d[0].summary.includes("check:dup"), d[0].summary);
  b.unregister();
  a.unregister();
});

check("repeated throws collapse to one diagnostic", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(
    section({
      id: "check:repeat",
      render: () => {
        throw new Error("same every frame");
      },
    }),
  );
  for (let i = 0; i < 25; i += 1) Footer.render(ctx, theme, WIDTH);
  assert.equal(Footer.getDiagnostics().length, 1, "a per-frame failure must not flood the list");
  h.unregister();
});

check("a clean render records nothing and stays on one line", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(section({ id: "check:clean", render: () => "left", order: 1 }));
  const lines = Footer.render(ctx, theme, WIDTH);
  assert.equal(lines.length, 1);
  assert.ok(stripAnsi(lines[0]).startsWith("left"), lines[0]);
  assert.equal(Footer.getDiagnostics().length, 0);
  h.unregister();
});

check("ANSI styling survives the render and is measured as zero width", () => {
  Footer.clearDiagnostics();
  const styled = theme.fg("accent", "space-bunny-free");
  const h = Footer.registerSection(
    section({ id: "check:ansi", render: () => styled, align: "right", order: 1 }),
  );
  const [line] = Footer.render(ctx, theme, 80);
  assert.ok(line.includes("\x1b["), "escape introducer must survive toSingleLine");
  assert.ok(stripAnsi(line).includes("space-bunny-free"), stripAnsi(line));
  // visibleWidth must agree with the eye, or the layout truncates a line that fits.
  assert.equal(
    visibleWidth(line),
    stripAnsi(line).length,
    "styled width disagrees with visible width",
  );
  h.unregister();
});

check("styling does not make the layout truncate a line that fits", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(
    section({
      id: "check:fit",
      render: () => theme.fg("accent", "y".repeat(60)),
      align: "left",
      order: 1,
    }),
  );
  for (const width of [61, 62, 63, 80]) {
    const [line] = Footer.render(ctx, theme, width);
    const shown = stripAnsi(line).length;
    assert.ok(shown <= width, "rendered " + shown + " visible chars into width " + width);
    // A 60-char section plus one separator-free pad fits anything at or above 60.
    if (width >= 60) {
      assert.equal(
        stripAnsi(line).replace(/ +$/, "").length,
        60,
        "truncated at width " + width + ": " + JSON.stringify(stripAnsi(line)),
      );
    }
  }
  h.unregister();
});

check("footer output never exceeds the terminal width", () => {
  Footer.clearDiagnostics();
  const h = Footer.registerSection(section({ id: "check:wide", render: () => "x".repeat(400) }));
  for (const width of [20, 40, 80, 120]) {
    for (const line of Footer.render(ctx, theme, width)) {
      const w = stripAnsi(line).length;
      assert.ok(w <= width, "line of " + w + " exceeds width " + width);
    }
  }
  h.unregister();
});

realWrite(failures === 0 ? "\nall checks passed\n" : "\n" + failures + " check(s) failed\n");
process.exit(failures === 0 ? 0 : 1);
