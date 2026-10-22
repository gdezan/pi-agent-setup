import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	DEFAULT_SESSION_AUTONAME_CONFIG,
	containsAssistantReply,
	createSessionNamingExcerpt,
	extractActiveBranchUserText,
	mergeSessionAutonameSettings,
	normalizeSessionNamingTitle,
	parseSessionAutonameConfig,
	parseSessionAutonameModel,
	resolveNamingModel,
	shouldAutoNameSession,
	type SessionAutoNameInput,
} from "../session-autoname.ts";

const autoNameInput: SessionAutoNameInput = {
	enabled: true,
	aborted: false,
	attempted: false,
	sessionName: undefined,
	hasAssistantReply: true,
	hasUserText: true,
};

test("extracts raw user text and ignores assistant and image content", () => {
	assert.equal(
		extractActiveBranchUserText([
			{ type: "message", message: { role: "user", content: "First" } },
			{ type: "message", message: { role: "assistant", content: "Ignore" } },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Second" }, { type: "image", data: "ignore" }],
				},
			},
		]),
		"First\n\nSecond",
	);
});

test("detects an assistant reply on the branch", () => {
	assert.equal(
		containsAssistantReply([
			{ type: "message", message: { role: "user", content: "First" } },
			{ type: "session_info" },
			{ type: "message", message: { role: "toolResult", content: "Ignore" } },
		]),
		false,
	);
	assert.equal(
		containsAssistantReply([
			{ type: "message", message: { role: "user", content: "First" } },
			{ type: "message", message: { role: "assistant", content: "Reply" } },
		]),
		true,
	);
});

test("auto names only the first settled reply of an unnamed, enabled session", () => {
	assert.equal(shouldAutoNameSession(autoNameInput), true);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, enabled: false }), false);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, aborted: true }), false);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, attempted: true }), false);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, sessionName: "Manual" }), false);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, hasAssistantReply: false }), false);
	assert.equal(shouldAutoNameSession({ ...autoNameInput, hasUserText: false }), false);
});

test("parses provider/model identifiers and rejects anything else", () => {
	assert.deepEqual(parseSessionAutonameModel("openai/gpt-6-luna"), { provider: "openai", id: "gpt-6-luna" });
	assert.equal(parseSessionAutonameModel("gpt-6-luna"), undefined);
	assert.equal(parseSessionAutonameModel("/gpt-6-luna"), undefined);
	assert.equal(parseSessionAutonameModel("openai/"), undefined);
	assert.equal(parseSessionAutonameModel("open ai/gpt-6-luna"), undefined);
	assert.equal(parseSessionAutonameModel(undefined), undefined);
});

test("parses autoname settings with per-field fallbacks", () => {
	assert.deepEqual(parseSessionAutonameConfig(undefined), DEFAULT_SESSION_AUTONAME_CONFIG);
	assert.deepEqual(parseSessionAutonameConfig({ enabled: false, model: "openai-codex/gpt-6-astra", thinkingLevel: "high" }), {
		enabled: false,
		model: { provider: "openai-codex", id: "gpt-6-astra" },
		thinkingLevel: "high",
	});
	assert.deepEqual(
		parseSessionAutonameConfig({ enabled: "yes", model: "not-a-model", thinkingLevel: "extreme" }),
		DEFAULT_SESSION_AUTONAME_CONFIG,
	);
});

test("resolves the configured naming model before the session model", () => {
	const configured = { provider: "openai", id: "gpt-6-luna" } as Model<any>;
	const session = { provider: "openai-codex", id: "gpt-6-astra" } as Model<any>;
	const config = DEFAULT_SESSION_AUTONAME_CONFIG;

	const registry = (models: Model<any>[], hasAuth: boolean) => ({
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: () => hasAuth,
	});

	assert.equal(resolveNamingModel(registry([configured], true), config, session), configured);
	assert.equal(resolveNamingModel(registry([configured], false), config, session), session);
	assert.equal(resolveNamingModel(registry([], true), config, session), session);
	assert.equal(resolveNamingModel(registry([], true), config, undefined), undefined);
});

test("merges one settings patch without dropping other keys", () => {
	assert.deepEqual(
		mergeSessionAutonameSettings(
			{ theme: "dark", sessionAutoname: { enabled: false, model: "openai/gpt-6-luna" } },
			{ thinkingLevel: "high" },
		),
		{ theme: "dark", sessionAutoname: { enabled: false, model: "openai/gpt-6-luna", thinkingLevel: "high" } },
	);
	assert.deepEqual(mergeSessionAutonameSettings({ theme: "dark" }, { model: "openai/gpt-6-luna" }), {
		theme: "dark",
		sessionAutoname: { model: "openai/gpt-6-luna" },
	});
});

test("keeps the beginning and end within the naming context limit", () => {
	const excerpt = createSessionNamingExcerpt(`${"a".repeat(2_500)}\n${"b".repeat(7_000)}`);

	assert.equal(Array.from(excerpt).length, 8_000);
	assert.match(excerpt, /earlier user context omitted/);
	assert.ok(excerpt.startsWith("a"));
	assert.ok(excerpt.endsWith("b"));
});

test("normalizes a title to the display-name constraints", () => {
	assert.equal(normalizeSessionNamingTitle("**Fix auth flow**\nExtra explanation"), "Fix auth flow");
	assert.equal(
		normalizeSessionNamingTitle("1. Add support for a very long session naming title that should be shortened"),
		"Add support for a very long session",
	);
	assert.equal(normalizeSessionNamingTitle("\n```\nRename sessions\n```"), "Rename sessions");
	assert.equal(normalizeSessionNamingTitle("!!!"), undefined);
	assert.ok(Array.from(normalizeSessionNamingTitle("é".repeat(80)) ?? "").length <= 60);
});
