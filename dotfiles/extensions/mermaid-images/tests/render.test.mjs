/* oxlint-disable no-control-regex -- Kitty frames contain terminal escape bytes. */
import assert from "node:assert/strict";
import test from "node:test";
import * as tui from "@earendil-works/pi-tui";
import { createTransformer } from "../diagram.mjs";
import { fixtures } from "./fixtures.mjs";

const context = {
  availableWidth: 100,
  isStreaming: false,
  messageType: "assistant",
  messageId: "one",
};
const dark = {
  colors: Object.fromEntries(
    Object.entries({
      text: "#d2d4d9",
      userMessageBg: "#17191d",
      accent: "#8eabc5",
      border: "#52606e",
      muted: "#a0a0a0",
      error: "#ff6666",
      success: "#66cc88",
      warning: "#ddbb66",
    }).map(([key, value]) => [key, tui.parseColor(value)]),
  ),
};
const light = {
  colors: {
    ...dark.colors,
    text: tui.parseColor("#202020"),
    userMessageBg: tui.parseColor("#ffffff"),
  },
};
function images(markdown) {
  return [
    ...markdown.matchAll(
      /\x1b_Ga=T[^;]*;[A-Za-z0-9+/=]*\x1b\\(?:\x1b_Gm=[01];[A-Za-z0-9+/=]*\x1b\\)*/g,
    ),
  ].map(([image]) => ({
    id: image.match(/,i=(\d+)/)[1],
    png: Buffer.from(
      [...image.matchAll(/;([A-Za-z0-9+/=]*)\x1b\\/g)].map((match) => match[1]).join(""),
      "base64",
    ),
  }));
}
function renderer(getTheme = () => dark) {
  tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  return createTransformer({ ...tui, getTheme });
}

test("renders arbitrary multiple fences with independent, stable placements and preserves other Markdown", () => {
  const render = renderer();
  const fence = "```mermaid\nflowchart LR\n  start[Start here] --> finish[Finished]\n```";
  const document = `Before.\n\n${fence}\n\nBetween.\n\n${fixtures[2].fence}\n\n${fence}\n\nAfter.`;
  const output = render(document, context);
  const rendered = images(output);
  assert.equal(rendered.length, 3);
  assert.equal(new Set(rendered.map((image) => image.id)).size, 3);
  assert.equal(render(document, context), output);
  const next = images(render(document, { ...context, messageId: "two" }));
  assert.ok(next.every((image) => !rendered.some((previous) => previous.id === image.id)));
  for (const prose of ["Before.", "Between.", "After."]) assert.ok(output.includes(prose));
  assert.ok(!output.includes("```mermaid"));
});

test("renders class, state, entity, pie, timeline and gantt diagrams alongside a source-preserving failure", () => {
  const sources = [
    "classDiagram\nRenderer --> Terminal : displays\nclass Renderer {\n+render(source) String\n}",
    "stateDiagram-v2\n[*] --> Rendering\nRendering --> Ready : success\nReady --> [*]",
    "erDiagram\nMESSAGE ||--o{ DIAGRAM : contains\nMESSAGE {\nstring id PK\n}\nDIAGRAM {\nstring source\n}",
    'pie title Results\n"Rendered" : 80\n"Source fallback" : 20',
    "timeline\ntitle Rendering\nSource : Parse\nImage : Rasterize : Display",
    "gantt\ndateFormat YYYY-MM-DD\nsection Rendering\nParse :parse, 2026-11-01, 1d\nRasterize :after parse, 1d",
  ];
  const invalid = "```mermaid\nnot a diagram\n```";
  const markdown = [...sources.map((source) => `~~~MERMAID\n${source}\n~~~`), invalid].join("\n\n");
  const output = renderer()(markdown, context);
  assert.equal(images(output).length, sources.length);
  assert.ok(output.includes(invalid));
});

test("returning to a previous width sends a fresh placement with the same raster", () => {
  const render = renderer();
  const wide = { ...context, availableWidth: 120 };
  const first = images(render(fixtures[0].sample, wide))[0];
  render(fixtures[0].sample, { ...context, availableWidth: 52 });
  const restoredOutput = render(fixtures[0].sample, wide);
  const restored = images(restoredOutput)[0];
  assert.notEqual(
    restored.id,
    first.id,
    "A resized terminal may discard the earlier image placement",
  );
  assert.deepEqual(restored.png, first.png);
  assert.equal(
    render(fixtures[0].sample, wide),
    restoredOutput,
    "The new placement must remain stable on unchanged redraws",
  );
});

test("theme changes invalidate raster colors without changing source or terminal width", () => {
  let theme = dark;
  const render = renderer(() => theme);
  const before = images(render(fixtures[0].sample, context))[0].png;
  theme = light;
  const after = images(render(fixtures[0].sample, context))[0].png;
  assert.notDeepEqual(before, after);
});

test("leaves invalid, nested, streaming, thinking and unsupported-terminal fences intact", () => {
  const render = renderer();
  const invalid = "```mermaid\nnot a diagram\n```";
  const nested =
    "````markdown\n" +
    fixtures[0].fence +
    "\n````\n\n> " +
    fixtures[0].fence.replaceAll("\n", "\n> ");
  assert.equal(render(invalid, context), invalid);
  assert.equal(render(nested, context), nested);
  assert.equal(render(fixtures[0].fence.slice(0, -3), context), fixtures[0].fence.slice(0, -3));
  assert.equal(render(fixtures[0].sample, { ...context, isStreaming: true }), fixtures[0].sample);
  assert.equal(
    render(fixtures[0].sample, { ...context, messageType: "assistant-thinking" }),
    fixtures[0].sample,
  );
  tui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  assert.equal(render(fixtures[0].sample, context), fixtures[0].sample);
});
