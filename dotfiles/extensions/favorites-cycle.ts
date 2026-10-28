import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readModelFavorites(): string[] {
	let state: unknown;
	try {
		state = JSON.parse(readFileSync(join(getAgentDir(), "model-picker-state.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!state || typeof state !== "object" || !("favorites" in state) || !Array.isArray(state.favorites) || state.favorites.some((key) => typeof key !== "string")) {
		throw new Error("Favorites cycle: invalid model-picker-state.json favorites");
	}
	return [...new Set(state.favorites)];
}

export default function favoritesCycle(pi: ExtensionAPI): void {
	let generation = 0;
	let restoreEditor: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		const session = ++generation;
		if (ctx.mode !== "tui") return;
		let queue = Promise.resolve();
		const previous = ctx.ui.getEditorComponent();
		const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data) => {
				const forward = keybindings.matches(data, "app.model.cycleForward");
				const backward = keybindings.matches(data, "app.model.cycleBackward");
				if (!forward && !backward) {
					handleInput(data);
					return;
				}
				queue = queue.then(async () => {
					if (session !== generation) return;
					const available = new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
					const favorites = readModelFavorites().map((key) => available.get(key)).filter((model) => model !== undefined);
					if (!favorites.length) {
						ctx.ui.notify("No available favorites. Select a model with /pick, then add it with /fav.", "warning");
						return;
					}
					const current = favorites.findIndex((model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id);
					const next = current < 0 ? (forward ? 0 : favorites.length - 1) : (current + (forward ? 1 : -1) + favorites.length) % favorites.length;
					if (!(await pi.setModel(favorites[next]))) ctx.ui.notify("Favorites cycle: selected model has no configured credentials.", "warning");
					if (session === generation) tui.requestRender();
				}).catch((error) => {
					if (session === generation) ctx.ui.notify(`Favorites cycle failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				});
			};
			return editor;
		};
		ctx.ui.setEditorComponent(factory);
		restoreEditor = () => {
			if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
		};
	});

	pi.on("session_shutdown", () => {
		generation++;
		restoreEditor?.();
		restoreEditor = undefined;
	});
}
