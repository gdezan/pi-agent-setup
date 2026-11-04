/* oxlint-disable no-control-regex -- Kitty frames contain terminal escape bytes. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { createTransformer } from "./diagram.mjs";
import { fixtures } from "./tests/fixtures.mjs";

const moduleUrl = process.env.PI_TUI_MODULE
  ? pathToFileURL(process.env.PI_TUI_MODULE).href
  : import.meta.resolve("@earendil-works/pi-tui");
const tui = await import(moduleUrl);
const { Markdown, setCapabilities, getPngDimensions } = tui;
const { getKittyImagePlacementRows } = await import(new URL("./terminal-image.js", moduleUrl));
const identity = (text) => text;
const theme = Object.fromEntries(
  [
    "heading",
    "link",
    "linkUrl",
    "code",
    "codeBlock",
    "codeBlockBorder",
    "quote",
    "quoteBorder",
    "hr",
    "listBullet",
    "bold",
    "italic",
    "strikethrough",
    "underline",
  ].map((name) => [name, identity]),
);
const { getThemeByName } = await import(
  new URL(
    "./modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  )
);
const diagramTheme = getThemeByName("dark");
const labelColor = tui.colorToRgb(diagramTheme.colors.text);
const artifactDirectory = join(tmpdir(), "pi-mermaid-images");
await mkdir(artifactDirectory, { recursive: true });
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
const transform = createTransformer({ ...tui, getTheme: () => diagramTheme });
const evidence = [];

async function writeSession(name, sample) {
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id: `mermaid-${name}`, timestamp, cwd: process.cwd() },
    {
      type: "message",
      id: "11111111",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: `Show the ${name} Mermaid diagram.`,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: sample }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(
    join(artifactDirectory, `session-${name}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

for (const fixture of fixtures) {
  const rendered = transform(fixture.sample, {
    availableWidth: 120,
    isStreaming: false,
    messageType: "assistant",
    messageId: fixture.name,
  });
  const diagramData = [...rendered.matchAll(/\x1b_G[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g)]
    .map((match) => match[1])
    .join("");
  assert.ok(diagramData, `${fixture.name}: must render through the production transformer`);
  await writeFile(
    join(artifactDirectory, `${fixture.name}.png`),
    Buffer.from(diagramData, "base64"),
  );
  const { widthPx, heightPx } = getPngDimensions(diagramData);
  const pixels = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"><image width="${widthPx}" height="${heightPx}" href="data:image/png;base64,${diagramData}"/></svg>`,
  ).render().pixels;
  let labelPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4);
    if (
      red === Math.round(labelColor.r) &&
      green === Math.round(labelColor.g) &&
      blue === Math.round(labelColor.b) &&
      alpha > 0
    )
      labelPixels++;
  }
  assert.ok(
    labelPixels > 50,
    `${fixture.name}: rasterized diagram must retain visible label glyphs`,
  );
  assert.equal(pixels[3], 0, "Diagram canvas must be transparent");
  await writeFile(join(artifactDirectory, `${fixture.name}.md`), fixture.sample + "\n");
  await writeSession(fixture.name, fixture.sample);

  for (const width of [30, 52, 80, 120, 30, 120]) {
    for (const messageType of ["user", "assistant"]) {
      const markdown = new Markdown(fixture.sample, 1, 0, theme, undefined, {
        transform: (text, availableWidth) =>
          transform(text, { availableWidth, isStreaming: false, messageType }),
      });
      const lines = markdown.render(width);
      const imageLine = lines.findIndex((line) => line.includes("\x1b_G"));
      assert.ok(imageLine >= 0, `${fixture.name}: Kitty image must survive Markdown parsing`);
      const reservedRows = getKittyImagePlacementRows(lines[imageLine]);
      assert.ok(reservedRows > 0, "Pi must retain image-height metadata");
      const header = lines[imageLine].match(/\x1b_G([^;]+);/)[1];
      assert.ok(!/(?:^|,)r=/.test(header), "Kitty must preserve proportions using columns only");
      assert.equal(
        lines[imageLine].indexOf("\x1b_G"),
        1,
        "Image must align with Markdown's one-column prose margin",
      );
      const payload = [...lines[imageLine].matchAll(/\x1b_G[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g)]
        .map((match) => match[1])
        .join("");
      const dimensions = getPngDimensions(payload);
      assert.ok(dimensions, "Kitty payload must contain a valid PNG");
      await writeFile(
        join(artifactDirectory, `${fixture.name}-${width}.png`),
        Buffer.from(payload, "base64"),
      );
      const afterLine = lines.findIndex((line) => line.trim() === "After the diagram.");
      assert.ok(
        afterLine >= imageLine + reservedRows,
        "Following prose must not overlap the image",
      );
      assert.ok(lines.some((line) => line.trim() === "Before the diagram."));
      assert.ok(!lines.some((line) => line.includes("```mermaid")));
      assert.ok(
        lines.every((line) => !line.includes("\n")),
        "Each TUI line must occupy one terminal row",
      );
      assert.deepEqual(markdown.render(width), lines, "Unchanged redraw must be stable");
      evidence.push({
        fixture: fixture.name,
        width,
        messageType,
        imageLine,
        reservedRows,
        afterLine,
        dimensions,
      });
      await writeFile(
        join(artifactDirectory, `${fixture.name}-${width}-${messageType}.ansi`),
        lines.join("\n"),
      );
    }
  }
  if (fixture.source.startsWith("flowchart")) {
    const narrow = evidence.find(
      (entry) => entry.fixture === fixture.name && entry.width === 52,
    ).dimensions;
    const wide = evidence.find(
      (entry) => entry.fixture === fixture.name && entry.width === 120,
    ).dimensions;
    assert.ok(
      narrow.heightPx / narrow.widthPx > (2 * wide.heightPx) / wide.widthPx,
      "Narrow flowcharts must reflow vertically",
    );
  }
  assert.equal(
    transform(fixture.sample, { availableWidth: 80, isStreaming: true, messageType: "assistant" }),
    fixture.sample,
  );
  assert.equal(
    transform(fixture.sample, {
      availableWidth: 80,
      isStreaming: false,
      messageType: "assistant-thinking",
    }),
    fixture.sample,
  );
}
assert.equal(
  transform("Unrelated text", { availableWidth: 80, isStreaming: false, messageType: "assistant" }),
  "Unrelated text",
);
setCapabilities({ images: null, trueColor: true, hyperlinks: false });
for (const fixture of fixtures) {
  assert.equal(
    transform(fixture.sample, { availableWidth: 80, isStreaming: false, messageType: "assistant" }),
    fixture.sample,
  );
}
await writeSession("multiple", `${fixtures[0].sample}\n\n${fixtures[2].sample}`);
console.log(
  JSON.stringify(
    { tuiModule: moduleUrl, artifacts: artifactDirectory, evidence, result: "PASS" },
    null,
    2,
  ),
);
