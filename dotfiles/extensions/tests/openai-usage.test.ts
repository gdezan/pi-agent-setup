import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchOpenaiPlanPayload } from "../provider-usage/openai.ts";

const native = { type: "oauth", access: "native-token", clientId: "pi-app", scopes: ["chatgpt.tokens.use.direct"] };
const companion = { type: "oauth", access: "companion-token", accountId: "account" };
const plan = { rate_limit: { primary_window: { used_percent: 45, limit_window_seconds: 604800 } } };

test("OpenAI shared-plan observer validates registration and never changes CLI credentials", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "openai-usage-"));
	const path = join(dir, "auth.json");
	const original = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "cli-token", account_id: "account", refresh_token: "do-not-use" } });
	const savedFetch = globalThis.fetch;
	try {
		await writeFile(path, original);
		const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
		let apps: unknown = { items: [{ id: "pi-app", windows: [{ used_percent: 99 }] }] };
		let status = 200;
		globalThis.fetch = async (url, options) => {
			requests.push({ url: String(url), options });
			return Response.json(String(url).endsWith("/apps") ? apps : plan, { status });
		};
		assert.deepEqual(await fetchOpenaiPlanPayload(native, undefined, path), plan);
		assert.equal(requests.length, 2);
		for (const request of requests) {
			assert.equal(new Headers(request.options?.headers).get("authorization"), "Bearer cli-token");
			assert.equal(new Headers(request.options?.headers).get("chatgpt-account-id"), "account");
			assert.equal(request.options?.redirect, "error");
		}
		assert.equal(await readFile(path, "utf8"), original);
		requests.length = 0;
		await fetchOpenaiPlanPayload(native, companion, path);
		assert.equal(new Headers(requests[0].options?.headers).get("authorization"), "Bearer companion-token");

		for (const payload of [
			{ items: [{ id: "another-app" }] },
			{ items: [{ id: "pi-app" }, { id: "pi-app" }] },
			{ items: [{ id: "pi-app" }], next_cursor: "next-page" },
			{ items: [{ id: "pi-app" }, {}] },
		]) {
			await t.test("unverified registrations never supply plan usage", async () => {
				apps = payload;
				requests.length = 0;
				await assert.rejects(fetchOpenaiPlanPayload(native, companion, path), /not uniquely verified/);
				assert.equal(requests.length, 1);
			});
		}
		requests.length = 0;
		await assert.rejects(fetchOpenaiPlanPayload({ type: "api_key", key: "api-key" }, companion, path), /requires.*ChatGPT/);
		await assert.rejects(fetchOpenaiPlanPayload(native, { type: "api_key", key: "api-key" }, path), /Codex OAuth/);
		await assert.rejects(fetchOpenaiPlanPayload(native, { ...companion, expires: 1 }, path), /expired/);
		assert.equal(requests.length, 0);
		status = 401;
		await assert.rejects(fetchOpenaiPlanPayload(native, companion, path), /Codex OAuth was rejected/);
		assert.equal(await readFile(path, "utf8"), original);
	} finally {
		globalThis.fetch = savedFetch;
		await rm(dir, { recursive: true, force: true });
	}
});
