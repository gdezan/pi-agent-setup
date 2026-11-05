# Mermaid images

Renders Mermaid fences in ordinary Pi messages as inline Kitty graphics. This is a bundled local
resource, not an external Pi package. Rendering changes only the display; session files, copied
source and model context retain the original Mermaid.

## Enable

Requires Pi **1.5.0+**, Node.js **22.19+**, and a terminal supporting the Kitty graphics protocol.

1. Run toolkit setup and select `mermaid-images` in the local-extension checklist. Setup installs
   this extension's pinned runtime dependencies in its deployed directory, in both copy and link
   mode. Existing selections are remembered, so explicitly select this newly added resource.
2. Set the following in your Pi `settings.json`, preserving other Markdown settings:

   ```json
   { "markdown": { "mermaid": "off" } }
   ```

3. Restart Pi. No extra command is needed to render a completed Mermaid fence.

Pi's built-in Mermaid transformer runs before extension transformers. The extension warns and stays
inactive unless that renderer is disabled. It does not change settings itself. With the built-in
renderer disabled, terminals without Kitty graphics show source fences, not Pi's Unicode diagrams.
Deselecting this resource does not restore the built-in setting; set it to `"final"` or
`"streaming"` if you want Pi's renderer again.

The rasterizer uses a static system font: Helvetica Neue on macOS, Segoe UI on Windows, and DejaVu
Sans on Linux. Install `fonts-dejavu-core` on a minimal Debian/Ubuntu host. If a usable font or
native rasterizer is unavailable, source fences remain visible. Do not omit npm's optional
dependencies; resvg uses a platform-specific native package. Cross-platform visual appearance is not
yet verified.

## Behavior

- Recognizes top-level backtick or tilde fences whose first language word is `mermaid`, regardless
  of case. Multiple diagrams, including repeated diagrams, can appear in one message. Fences inside
  lists, blockquotes or other code blocks are left alone.
- Uses Pele **1.13.0** for synchronous SVG layout, resvg **2.6.2** for PNGs, and Pi's `Image`
  component for Kitty output. Syntax support follows Pele, not Mermaid.js exactly. Unsupported or
  invalid diagrams retain their source independently of successful diagrams in the same message.
- Uses the current Pi theme's text, accent and semantic colors. The canvas is transparent. Changing
  themes, width or terminal-cell dimensions invalidates the corresponding cached raster.
- Gives Pele the available pixel width and sizes labels relative to terminal-cell height. Simple
  `flowchart`/`graph` headers using LR or RL switch to TB or BT below 640 pixels. Other diagram
  types retain their direction and may shrink to fit; complex diagrams are not guaranteed readable
  at every width. Stored directions never change.
- Leaves streaming content and thinking blocks as source. Unclosed fences, very narrow content
  areas, non-Kitty terminals and render failures also keep source.
- Disables Mermaid links and external images. Each diagram is limited to 20,000 source characters,
  256 edges, 1 MB of SVG and 4 million layout pixels before 2x rasterization. There are bounded
  64-entry raster and placement caches. A failed diagram is cached until its render inputs change.
  Cached PNGs can be reused, but a layout change recreates the placement so returning to a previous
  width retransmits the image.

### Image layout constraint

Pi currently exposes a string-based Markdown transformer rather than an inline image component hook.
The extension reserves image rows with ANSI-only paragraphs, adds the normal one-cell prose margin,
and sends Kitty a column constraint without a row constraint to preserve the raster's aspect ratio.
Pi's image metadata still records the reserved height.

This depends on Pi 1.5's Markdown and image behavior. A terminal that does not report cell
dimensions can leave excess whitespace. Partial-scroll cropping is not yet visually verified. Source
is always preserved if rendering is unavailable.

## Verification

From the repository root:

```sh
npm ci --prefix dotfiles/extensions/gd-mermaid-images --ignore-scripts --legacy-peer-deps
npm run test:mermaid
```

`test:mermaid` runs the multiple-fence/theme/fallback workflows, then the real Markdown component
and a disposable Pi PTY probe. The latter requires Python 3 and `pi` on PATH, or `PI_CLI` set to its
executable path. It makes no model requests and does not change global settings.

The Markdown proof checks linear and branching flowcharts and a sequence diagram at 30, 52, 80 and
120 columns. It verifies PNG glyph pixels, transparency, image metadata, prose alignment, row
reservation and stable redraws. The PTY proof runs regular and fullscreen Pi at 100 → 52 → 100
columns, decodes the transmitted PNGs, verifies responsive direction and restoration, and checks
that session JSONL still contains the Mermaid source. Separate renderer workflows also exercise
class, state, entity, pie, timeline and Gantt diagrams. Protocol output is not proof of emulator
appearance.

Proof output reports an artifact directory containing PNGs, source Markdown, generated sessions,
ANSI captures and `pty-result.json`. To inspect an actual terminal, use those paths:

```sh
PI_CODING_AGENT_DIR=/absolute/artifact/directory/agent-fullscreen \
pi --offline --no-approve --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-themes --no-mcp \
  -e "$PWD/dotfiles/extensions/gd-mermaid-images/index.js" \
  --session /absolute/artifact/directory/session-branching.jsonl
```

Choose `session-linear.jsonl`, `session-branching.jsonl`, `session-sequence.jsonl` or
`session-multiple.jsonl` (a flowchart and sequence in one message). Compare wide, narrow and
restored layouts after each has settled, including label readability, decision labels, sequence
notes and activation bars. In Herdr, `herdr-app shot /tmp/mermaid.png` captures terminal images
without macOS Screen Recording permission. This is a Herdr check, not a standalone Ghostty or
physical Kitty check.

The installed copy passed native fullscreen Herdr inspection at 190 → 45 → 190 columns for the
linear flowchart, branching flowchart, sequence and two-diagram message. Labels, decision branches,
notes and activation bars remained legible; prose did not overlap images, and the diagrams restored
without blank regions or stale fragments. Contact sheets and captures are retained under
`visual/herdr-production-*-contact.png` and `visual/herdr-*.png` in the reported artifact directory.
This is macOS Herdr evidence, not standalone Ghostty, physical Kitty or cross-platform acceptance.

`PI_MERMAID_EXTENSION=/absolute/deployed/path/index.js` makes the PTY proof exercise an installed
copy instead of the checkout. `PI_MERMAID_PACKAGE=/absolute/deployed/toolkit/path` tests package
auto-discovery instead of explicit `-e` loading. `PI_MERMAID_THEME=light` checks another built-in
theme. `PI_TUI_MODULE=/absolute/path/to/pi-tui/dist/index.js` selects a TUI build for the Markdown
proof.

Sources:
[Pi Markdown transformers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Pele API](https://pele.run/api), [Pele compatibility](https://pele.run/compatibility),
[Kitty image protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).
