import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("both OpenAI providers use legacy Codex OAuth and accept Codex response headers", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "provider-usage-test-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({
			openai: { type: "oauth", access: "new-chatgpt-token" },
			"openai-codex": { type: "oauth", access: "legacy-token", accountId: "legacy-account" },
		}));
		const { default: providerUsage } = await import("../provider-usage.ts");
		const handlers = new Map<string, Function>();
		const commands = new Map<string, { handler: Function }>();
		const statuses: Array<string | undefined> = [];
		const notices: string[] = [];
		const requests: Array<{ url: string; authorization: string | null; accountId: string | null }> = [];
		globalThis.fetch = async (url, options) => {
			requests.push({
				url: String(url),
				authorization: new Headers(options?.headers).get("authorization"),
				accountId: new Headers(options?.headers).get("chatgpt-account-id"),
			});
			return Response.json({ rate_limit: { primary_window: {
				used_percent: 20, limit_window_seconds: 18_000,
			} } });
		};
		const ctx = {
			hasUI: true,
			model: { provider: "openai" },
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_id: string, text: string | undefined) => statuses.push(text),
				notify: (text: string) => notices.push(text),
			},
		};
		providerUsage({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
		} as Parameters<typeof providerUsage>[0]);
		try {
			await commands.get("usage")!.handler("refresh", ctx);
			assert.deepEqual(requests, [{
				url: "https://chatgpt.com/backend-api/wham/usage",
				authorization: "Bearer legacy-token",
				accountId: "legacy-account",
			}]);
			assert.equal(statuses.at(-1), "5h:80%");
			assert.deepEqual(notices, ["Codex usage refreshed"]);
			handlers.get("after_provider_response")!({ headers: {
				"x-codex-primary-used-percent": "35",
				"x-codex-primary-window-minutes": "300",
			} }, ctx);
			assert.equal(statuses.at(-1), "5h:65%");
			ctx.model.provider = "openai-codex";
			await commands.get("usage")!.handler("refresh", ctx);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[1], requests[0]);
			assert.equal(statuses.at(-1), "5h:80%");
			handlers.get("after_provider_response")!({ headers: {
				"x-codex-primary-used-percent": "35",
				"x-codex-primary-window-minutes": "300",
			} }, ctx);
			assert.equal(statuses.at(-1), "5h:65%");

			for (const outcome of ["success", "failure"] as const) {
				await t.test(`a late fetch ${outcome} does not update a replaced session`, async () => {
					const fetchStarted = Promise.withResolvers<void>();
					const response = Promise.withResolvers<Response>();
					const savedFetch = globalThis.fetch;
					let stale = false;
					const guardedCtx = {
						model: ctx.model,
						ui: ctx.ui,
						get hasUI() {
							if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
							return ctx.hasUI;
						},
					};
					globalThis.fetch = () => {
						fetchStarted.resolve();
						return response.promise;
					};
					try {
						const pending = commands.get("usage")!.handler("refresh", guardedCtx);
						await fetchStarted.promise;
						stale = true;
						const statusCount = statuses.length;
						const noticeCount = notices.length;
						if (outcome === "success") {
							response.resolve(Response.json({ rate_limit: { primary_window: {
								used_percent: 50, limit_window_seconds: 18_000,
							} } }));
						} else {
							response.reject(new Error("Quota request failed"));
						}
						await assert.doesNotReject(pending);
						assert.equal(statuses.length, statusCount);
						assert.equal(notices.length, noticeCount);
					} finally {
						globalThis.fetch = savedFetch;
					}
				});
			}

			await writeFile(join(agentDir, "auth.json"), JSON.stringify({
				openai: { type: "oauth", access: "new-chatgpt-token" },
				"openai-codex": { type: "api_key", key: "api-key-not-a-chatgpt-token" },
			}));
			ctx.model.provider = "openai";
			await commands.get("usage")!.handler("refresh", ctx);
			assert.equal(requests.length, 2, "Neither API keys nor new OpenAI tokens may reach the Codex quota endpoint");
			assert.match(notices.at(-1)!, /OpenAI Codex OAuth is not configured/);
		} finally {
			handlers.get("session_shutdown")!({}, ctx);
		}
	} finally {
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
