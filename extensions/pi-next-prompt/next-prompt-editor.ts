import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  renderFakeCursor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const nextPromptGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type NextPromptEditorControls = {
  getSuggestion(): string;
  isActive(): boolean;
  clear(): void;
  redraw(): void;
};

export function attachNextPromptEditor(
  editor: EditorComponent & { isShowingAutocomplete?(): boolean },
  ctx: ExtensionContext,
  controls: NextPromptEditorControls,
): EditorComponent {
  const handleInput = editor.handleInput.bind(editor);
  const setText = editor.setText.bind(editor);
  const render = editor.render.bind(editor);

  editor.setText = (text) => {
    if (text !== editor.getText()) controls.clear();
    setText(text);
  };
  editor.handleInput = (data) => {
    if (controls.isActive() && matchesKey(data, Key.escape)) {
      controls.clear();
      return;
    }
    const suggestion = controls.getSuggestion();
    if (
      suggestion &&
      !editor.getText() &&
      !editor.isShowingAutocomplete?.() &&
      (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
    ) {
      controls.clear();
      setText(suggestion);
      controls.redraw();
      return;
    }
    const previousText = editor.getText();
    handleInput(data);
    if (editor.getText() !== previousText) controls.clear();
  };
  editor.render = (width) => {
    const lines = render(width);
    const suggestion = controls.getSuggestion();
    if (!suggestion || editor.getText() || editor.isShowingAutocomplete?.()) return lines;
    const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    if (row < 0) return lines;
    const prefix = lines[row].slice(0, lines[row].indexOf(CURSOR_MARKER) + CURSOR_MARKER.length);
    const available = Math.max(0, width - visibleWidth(prefix));
    // Truncation may add ANSI resets; segment visible text, not escape sequences.
    const ghost = stripTerminalSequences(
      truncateToWidth(suggestion, Math.max(0, available - 1), "…"),
    );
    const first = nextPromptGraphemes.segment(ghost)[Symbol.iterator]().next().value?.segment;
    if (!first) return lines;
    lines[row] =
      prefix +
      ctx.ui.theme.fg("dim", renderFakeCursor(first) + ghost.slice(first.length)) +
      " ".repeat(available - visibleWidth(ghost));
    return lines;
  };
  return editor;
}
