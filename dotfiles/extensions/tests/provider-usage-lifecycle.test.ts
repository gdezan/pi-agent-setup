import assert from "node:assert/strict";
import test from "node:test";
import {
	createExtensionRuntime,
	ExtensionRunner,
	SessionManager,
	type ExtensionAPI,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import providerUsage from "../provider-usage.ts";

for (const lifecycle of ["replacement", "reload", "restart"] as const) {
	test(`provider usage stops polling after session ${lifecycle}`, (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const clearIntervalSpy = t.mock.method(globalThis, "clearInterval");
		const handlers = new Map<string, Function>();
		const runner = new ExtensionRunner(
			[], createExtensionRuntime(), process.cwd(), SessionManager.inMemory(), {} as ModelRegistry,
		);
		const ui = runner.getUIContext();
		runner.setUIContext(ui, "tui");
		const ctx = runner.createContext();
		providerUsage({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerCommand: () => {},
		} as ExtensionAPI);
		try {
			handlers.get("session_start")!({}, ctx);
			if (lifecycle === "restart") {
				handlers.get("session_start")!({}, ctx);
				assert.equal(clearIntervalSpy.mock.callCount(), 1, "starting again must clear the previous timer");
			}
			if (lifecycle === "reload") handlers.get("session_shutdown")!({}, ctx);
			runner.invalidate();
			assert.throws(() => ctx.model, /This extension ctx is stale after session replacement or reload/);
			assert.doesNotThrow(() => t.mock.timers.tick(60_000), "an invalidated context must not crash the timer");
			const expectedClears = lifecycle === "restart" ? 2 : 1;
			assert.equal(clearIntervalSpy.mock.callCount(), expectedClears, "the obsolete timer must be cleared");
			assert.doesNotThrow(() => t.mock.timers.tick(120_000));
			assert.equal(clearIntervalSpy.mock.callCount(), expectedClears, "each timer must be cleared only once");
		} finally {
			// Teardown must not use the runner's deliberately invalidated context.
			handlers.get("session_shutdown")!({}, { hasUI: true, ui });
		}
	});
}
