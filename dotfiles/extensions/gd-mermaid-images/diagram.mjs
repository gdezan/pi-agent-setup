import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { Marked, colorToHex, mixColors } from "@earendil-works/pi-tui";
import { render } from "pele";
import { resolvePeleSvg } from "./svg.mjs";

const fontFamily =
  process.platform === "darwin"
    ? "Helvetica Neue"
    : process.platform === "win32"
      ? "Segoe UI"
      : "DejaVu Sans";
const font = { defaultFontFamily: fontFamily, sansSerifFamily: fontFamily };
let fontReady;

function paletteFor(theme) {
  const { colors } = theme;
  const foreground = colors.text;
  const background = colors.userMessageBg;
  const mix = (color, amount) => colorToHex(mixColors(background, color, amount));
  const palette = {
    "--pele-fg": colorToHex(foreground),
    "--pele-bg": colorToHex(background),
    "--pele-surface": mix(foreground, 0.06),
    "--pele-surface-alt": mix(foreground, 0.12),
    "--pele-accent": mix(colors.accent, 0.2),
    "--pele-line": colorToHex(colors.accent),
    "--pele-border": mix(foreground, 0.45),
    "--pele-muted": mix(foreground, 0.75),
    "--pele-critical": colorToHex(colors.error),
    "--pele-error": colorToHex(colors.error),
    "--pele-font": `${fontFamily},sans-serif`,
  };
  for (const [index, color] of [
    colors.accent,
    colors.success,
    colors.warning,
    colors.error,
    colors.muted,
    foreground,
  ].entries()) {
    palette[`--pele-series-${index + 1}`] = colorToHex(color);
  }
  return palette;
}

function renderPng(source, maxWidth, fontSize, palette) {
  if (fontReady === undefined) {
    fontReady = Boolean(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><text y="20" font-family="${fontFamily}">Mm</text></svg>`,
        { font },
      ).innerBBox()?.width,
    );
  }
  if (!fontReady) throw new Error(`No usable ${fontFamily} font`);
  const diagramSource =
    maxWidth < 640
      ? source.replace(
          /^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/,
          (_match, prefix, direction) => prefix + (direction === "RL" ? "BT" : "TB"),
        )
      : source;
  const result = render(diagramSource, {
    responsive: false,
    autoDirection: false,
    maxWidth,
    fontFamily,
    fontSize,
    padding: 2,
    images: false,
    links: false,
    limit: 20_000,
    maxEdges: 256,
    outputLimit: 1_000_000,
  });
  if (
    !Number.isFinite(result.width * result.height) ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.width * result.height > 4_000_000
  ) {
    throw new Error("Diagram exceeds raster limits");
  }
  return new Resvg(resolvePeleSvg(result.svg, palette), { font, fitTo: { mode: "zoom", value: 2 } })
    .render()
    .asPng();
}

function closedFence(raw) {
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})/);
  const closing = raw
    .trimEnd()
    .split("\n")
    .at(-1)
    ?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return (
    opening && closing && opening[1][0] === closing[1][0] && closing[1].length >= opening[1].length
  );
}

function cacheEntry(cache, key, create) {
  if (!cache.has(key)) {
    let value;
    try {
      value = create();
    } catch {
      value = null;
    }
    cache.set(key, value);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export function createTransformer({
  Image,
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
  getTheme,
}) {
  const parser = new Marked();
  const rasters = new Map();
  const placements = new Map();
  return (markdown, { availableWidth, isStreaming, messageType, messageId }) => {
    if (
      isStreaming ||
      messageType === "assistant-thinking" ||
      getCapabilities().images !== "kitty" ||
      availableWidth < 12
    )
      return markdown;
    const theme = getTheme();
    if (!theme) return markdown;
    const palette = paletteFor(theme);
    const cell = getCellDimensions();
    const columns = Math.max(1, availableWidth - 2);
    const geometry = `${columns}:${cell.widthPx}:${cell.heightPx}:${JSON.stringify(palette)}`;
    const owner =
      messageId ?? createHash("sha256").update(`${messageType}:${markdown}`).digest("hex");
    let changed = false;
    let position = 0;
    const output = parser
      .lexer(markdown)
      .map((token) => {
        const index = position++;
        if (
          token.type !== "code" ||
          token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() !== "mermaid" ||
          !closedFence(token.raw)
        )
          return token.raw;
        const key = createHash("sha256").update(`${geometry}:${token.text}`).digest("hex");
        const raster = cacheEntry(rasters, key, () => {
          const png = renderPng(
            token.text,
            columns * cell.widthPx,
            Math.round(cell.heightPx * 0.85),
            palette,
          );
          const data = png.toString("base64");
          const dimensions = getPngDimensions(data);
          return { data, dimensions };
        });
        if (!raster) return token.raw;
        const placementKey = `${owner}:${index}`;
        let placement = placements.get(placementKey);
        if (placement?.rasterKey !== key) {
          // A layout change needs a fresh placement, even when the PNG is already cached.
          placements.delete(placementKey);
          placement = cacheEntry(placements, placementKey, () => ({
            rasterKey: key,
            image: new Image(
              raster.data,
              "image/png",
              { fallbackColor: (text) => text },
              {
                maxWidthCells: Math.ceil(raster.dimensions.widthPx / 2 / cell.widthPx),
                maxHeightCells: Math.ceil(raster.dimensions.heightPx / 2 / cell.heightPx),
              },
            ),
          }));
        }
        if (!placement) return token.raw;
        const lines = placement.image.render(availableWidth);
        // Kitty preserves the raster aspect with columns alone; Pi's metadata still reserves its rows.
        const imageLine = " " + lines[0].replace(/,r=\d+(?=[,;])/, "");
        // Markdown collapses blank lines, so reserve image height in an ANSI-only paragraph.
        const reservation =
          lines.length > 1
            ? `\n\n${Array(lines.length - 1)
                .fill("\x1b[0m")
                .join("\n")}`
            : "";
        changed = true;
        return `${imageLine}${reservation}\n\n`;
      })
      .join("");
    return changed ? output : markdown;
  };
}
