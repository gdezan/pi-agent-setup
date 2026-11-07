import {
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
  Image,
} from "@earendil-works/pi-tui";

export default function (pi) {
  let transform = (markdown) => markdown;
  pi.registerMarkdownTransformer((markdown, context) => transform(markdown, context));
  pi.on("session_start", async (_event, context) => {
    transform = (markdown) => markdown;
    if (!context.hasUI) return;
    if (pi.getSettings().markdown?.mermaid !== "off") {
      context.ui.notify(
        'Mermaid images need markdown.mermaid set to "off" in Pi settings. Restart Pi after changing it.',
        "warning",
      );
      return;
    }
    try {
      const { createTransformer } = await import("./diagram.mjs");
      transform = createTransformer({
        Image,
        getCapabilities,
        getCellDimensions,
        getPngDimensions,
        getTheme: () => context.ui.theme,
      });
    } catch (error) {
      context.ui.notify(
        `Mermaid images unavailable: ${error.message}. Reinstall this resource's runtime dependencies, then restart Pi. Source fences are preserved.`,
        "warning",
      );
    }
  });
}
