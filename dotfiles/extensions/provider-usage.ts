import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Footer } from "./pi-footer/footer.ts";
import { fetchAntigravityUsage } from "./provider-usage/antigravity.ts";
import { fetchClaudeUsage } from "./provider-usage/claude.ts";
import { fetchCursorUsage } from "./provider-usage/cursor.ts";
import { USAGE_POPUP_WIDTH, UsagePopup } from "./provider-usage/popup.ts";
import type { AuthEntry, Snapshot, Window } from "./provider-usage/types.ts";
import { countdown, windowSecondsFor } from "./provider-usage/windows.ts";

type ProviderSpec = {
	/** Unique id used for status/footer keys and command names. */
	id: string;
	/** Human label in notifications ("Codex", "xAI"). */
	name: string;
	/** model.provider values this adapter owns. */
	providers: readonly string[];
	/** auth.json top-level key; omit for adapters that read their own store (Claude, Antigravity). */
	authKey?: string;
	/** Fetch a fresh snapshot using stored credentials. */
	fetch: (auth: AuthEntry) => Promise<Snapshot>;
	/** Optional incremental update from response headers. */
	parseHeaders?: (headers: Record<string, string>) => Snapshot | undefined;
	/** Optional OAuth refresh when access is near expiry. */
	refreshAuth?: (auth: AuthEntry) => Promise<AuthEntry | undefined>;
};

// ── Constants ─────────────────────────────────────────────────────────

const STATUS_ID = "provider-usage";
const FOOTER_ID = "provider-usage";
const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const TOKEN_SKEW_MS = 5 * 60 * 1000;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const COPILOT_BILLING_URL = "https://api.github.com";
const COPILOT_BILLING_AUTH_KEY = "github-copilot-billing";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_DIR, "auth.json");

// ── Helpers ───────────────────────────────────────────────────────────

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function normalizeResetAt(value: unknown): number | undefined {
	const number = finite(value);
	if (number === undefined) return undefined;
	// Accept seconds or milliseconds epoch.
	return number > 10_000_000_000 ? Math.round(number / 1000) : Math.round(number);
}

function resetAtFromIso(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const direct = headers[name];
	if (direct !== undefined) return direct;
	const lower = name.toLowerCase();
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
	return entry?.[1];
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

async function readAuthFile(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(AUTH_FILE, "utf8")) as Record<string, unknown>;
}

async function writeAuthFile(auth: Record<string, unknown>): Promise<void> {
	await writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function readAuthEntry(authKey: string): Promise<AuthEntry> {
	const auth = await readAuthFile();
	const entry = auth[authKey];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error(`${authKey} credentials are not configured in Pi`);
	}
	return entry as AuthEntry;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = FETCH_TIMEOUT_MS): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ms);
	try {
		return await work(controller.signal);
	} finally {
		clearTimeout(timeout);
	}
}

function snapshot(windows: Array<Window | undefined>): Snapshot | undefined {
	const valid = windows.filter((window): window is Window => window !== undefined);
	if (valid.length === 0) return undefined;
	return { windows: valid, updatedAt: Date.now() };
}

function windowFromUsedPercent(
	label: string,
	usedPercent: number | undefined,
	opts: { windowSeconds?: number; resetAt?: number } = {},
): Window | undefined {
	if (usedPercent === undefined) return undefined;
	return {
		label,
		usedPercent: clampPercent(usedPercent),
		windowSeconds: opts.windowSeconds,
		resetAt: opts.resetAt,
	};
}

function windowFromAmount(
	label: string,
	amount: number | undefined,
	currency: string | undefined,
): Window | undefined {
	if (amount === undefined || currency === undefined) return undefined;
	return {
		label,
		usedPercent: 0,
		amount,
		currency,
	};
}

// ── Codex adapter ─────────────────────────────────────────────────────

function parseCodexWindow(value: unknown, fallbackLabel: string): Window | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const usedPercent = finite(record.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowSeconds = finite(record.limit_window_seconds);
	let label = fallbackLabel;
	if (windowSeconds === FIVE_HOURS) label = "5h";
	else if (windowSeconds === SEVEN_DAYS) label = "7d";
	return {
		label,
		usedPercent: clampPercent(usedPercent),
		windowSeconds,
		resetAt: normalizeResetAt(record.reset_at),
	};
}

function parseCodexUsage(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const rateLimit = (value as { rate_limit?: unknown }).rate_limit;
	if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) return undefined;
	const bucket = rateLimit as Record<string, unknown>;
	return snapshot([
		parseCodexWindow(bucket.primary_window, "primary"),
		parseCodexWindow(bucket.secondary_window, "secondary"),
	]);
}

function parseCodexHeaders(headers: Record<string, string>): Snapshot | undefined {
	const parse = (which: "primary" | "secondary", fallbackLabel: string): Window | undefined => {
		const usedPercent = headerNumber(headers, `x-codex-${which}-used-percent`);
		if (usedPercent === undefined) return undefined;
		const minutes = headerNumber(headers, `x-codex-${which}-window-minutes`);
		const windowSeconds = minutes === undefined ? undefined : minutes * 60;
		let label = fallbackLabel;
		if (windowSeconds === FIVE_HOURS) label = "5h";
		else if (windowSeconds === SEVEN_DAYS) label = "7d";
		return {
			label,
			usedPercent: clampPercent(usedPercent),
			windowSeconds,
			resetAt: normalizeResetAt(headerNumber(headers, `x-codex-${which}-reset-at`)),
		};
	};
	return snapshot([parse("primary", "primary"), parse("secondary", "secondary")]);
}

async function fetchCodexUsage(auth: AuthEntry): Promise<Snapshot> {
	const access = stringField(auth, "access");
	const accountId = stringField(auth, "accountId");
	if (!access) throw new Error("OpenAI Codex OAuth is not configured in Pi");

	const snapshotValue = await withTimeout(async (signal) => {
		const response = await fetch(CODEX_USAGE_URL, {
			signal,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${access}`,
				...(accountId ? { "chatgpt-account-id": accountId } : {}),
			},
		});
		if (!response.ok) throw new Error(`Codex usage request returned ${response.status}`);
		return parseCodexUsage(await response.json());
	});
	if (!snapshotValue) throw new Error("Codex usage response contained no recognized windows");
	return snapshotValue;
}

// ── xAI adapter ───────────────────────────────────────────────────────

function parseXaiUsage(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	const config =
		root.config && typeof root.config === "object" && !Array.isArray(root.config)
			? (root.config as Record<string, unknown>)
			: root;

	const period =
		config.currentPeriod && typeof config.currentPeriod === "object" && !Array.isArray(config.currentPeriod)
			? (config.currentPeriod as Record<string, unknown>)
			: undefined;
	const periodType = typeof period?.type === "string" ? period.type : "";

	let usedPercent = finite(config.creditUsagePercent);
	if (usedPercent === undefined) {
		const monthlyLimit = centsVal(config.monthlyLimit);
		const used = centsVal(config.used);
		if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
			usedPercent = clampPercent((used / monthlyLimit) * 100);
		}
	}
	if (usedPercent === undefined) {
		const products = config.productUsage;
		if (Array.isArray(products)) {
			for (const product of products) {
				if (!product || typeof product !== "object" || Array.isArray(product)) continue;
				const pct = finite((product as Record<string, unknown>).usagePercent);
				if (pct !== undefined) {
					usedPercent = pct;
					break;
				}
			}
		}
	}
	// Endpoint omits creditUsagePercent at a fresh period start; treat as 0% used
	// when a typed period is present (matches grok-cli / official credits config).
	if (usedPercent === undefined && periodType.length > 0) usedPercent = 0;
	if (usedPercent === undefined) return undefined;

	const label = periodType.includes("WEEKLY")
		? "wk"
		: periodType.includes("MONTHLY")
			? "mo"
			: periodType.includes("DAILY")
				? "day"
				: "plan";

	const resetAt =
		resetAtFromIso(period?.end) ??
		resetAtFromIso(config.billingPeriodEnd) ??
		resetAtFromIso(config.resetAt) ??
		resetAtFromIso(config.reset_at);

	const startAt = resetAtFromIso(period?.start) ?? resetAtFromIso(config.billingPeriodStart);
	const windowSeconds =
		startAt !== undefined && resetAt !== undefined && resetAt > startAt ? resetAt - startAt : undefined;

	return snapshot([windowFromUsedPercent(label, usedPercent, { windowSeconds, resetAt })]);
}

function centsVal(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return finite((value as Record<string, unknown>).val);
}

async function refreshXaiAuth(auth: AuthEntry): Promise<AuthEntry | undefined> {
	const expires = finite(auth.expires);
	if (expires !== undefined && expires - TOKEN_SKEW_MS > Date.now()) return undefined;
	const refresh = stringField(auth, "refresh");
	if (!refresh) return undefined;

	const body = await withTimeout(async (signal) => {
		const response = await fetch(XAI_TOKEN_URL, {
			method: "POST",
			signal,
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: XAI_CLIENT_ID,
				refresh_token: refresh,
			}),
		});
		if (!response.ok) throw new Error(`xAI token refresh returned ${response.status}`);
		return (await response.json()) as Record<string, unknown>;
	});

	const access = stringField(body, "access_token");
	if (!access) throw new Error("xAI token refresh returned no access token");
	const nextRefresh = stringField(body, "refresh_token") ?? refresh;
	const expiresIn = finite(body.expires_in) ?? 3600;
	const next: AuthEntry = {
		...auth,
		type: "oauth",
		access,
		refresh: nextRefresh,
		expires: Date.now() + expiresIn * 1000 - TOKEN_SKEW_MS,
	};

	try {
		const file = await readAuthFile();
		file.xai = next;
		await writeAuthFile(file);
	} catch {
		// Best-effort persistence; the in-memory token still works for this fetch.
	}
	return next;
}

async function fetchXaiUsage(auth: AuthEntry): Promise<Snapshot> {
	let current = auth;
	const refreshed = await refreshXaiAuth(current).catch(() => undefined);
	if (refreshed) current = refreshed;

	const access = stringField(current, "access");
	if (!access) throw new Error("xAI OAuth is not configured in Pi");

	const headers: Record<string, string> = {
		accept: "application/json",
		authorization: `Bearer ${access}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
	};

	const snapshotValue = await withTimeout(async (signal) => {
		// Identity first (optional but matches the official CLI contract); ignore failures.
		try {
			const identityResponse = await fetch(XAI_USER_URL, { signal, headers, redirect: "error" });
			if (identityResponse.ok) {
				const identity = (await identityResponse.json()) as Record<string, unknown>;
				const userId = stringField(identity, "userId");
				if (userId) headers["x-userid"] = userId;
			} else {
				void identityResponse.body?.cancel().catch(() => undefined);
			}
		} catch {
			// Billing often works with bearer alone.
		}

		const response = await fetch(XAI_BILLING_URL, { signal, headers, redirect: "error" });
		if (!response.ok) throw new Error(`xAI usage request returned ${response.status}`);
		return parseXaiUsage(await response.json());
	});
	if (!snapshotValue) throw new Error("xAI usage response contained no recognized windows");
	return snapshotValue;
}

// ── DeepSeek adapter ──────────────────────────────────────────────────

function parseDeepseekBalance(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	const infos = root.balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) return undefined;

	const windows: Window[] = [];
	for (const info of infos) {
		if (!info || typeof info !== "object" || Array.isArray(info)) continue;
		const record = info as Record<string, unknown>;
		const currency = stringField(record, "currency")?.toUpperCase();
		const totalBalance = parseFloat(stringField(record, "total_balance") ?? "");
		if (!Number.isFinite(totalBalance)) continue;
		windows.push({
			label: currency ?? "???",
			usedPercent: 0,
			amount: totalBalance,
			currency,
		});
	}

	if (windows.length === 0) return undefined;
	return { windows, updatedAt: Date.now() };
}

async function fetchDeepseekBalance(auth: AuthEntry): Promise<Snapshot> {
	const key = stringField(auth, "key");
	if (!key) throw new Error("DeepSeek API key is not configured in Pi");

	const snapshotValue = await withTimeout(async (signal) => {
		const response = await fetch(DEEPSEEK_BALANCE_URL, {
			signal,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${key}`,
			},
		});
		if (!response.ok) throw new Error(`DeepSeek balance request returned ${response.status}`);
		return parseDeepseekBalance(await response.json());
	});
	if (!snapshotValue) throw new Error("DeepSeek balance response contained no recognized data");
	return snapshotValue;
}

// ── OpenCode Go adapter ───────────────────────────────────────────────

const OPENCODE_GO_WINDOWS = [
	{ key: "rolling", label: "5h" },
	{ key: "weekly", label: "wk" },
	{ key: "monthly", label: "mo" },
] as const;

function parseOpencodeGoUsage(value: unknown): Snapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	const usage = root.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const buckets = usage as Record<string, unknown>;
	const windows: Window[] = [];
	for (const { key, label } of OPENCODE_GO_WINDOWS) {
		const bucket = buckets[key];
		if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
		const record = bucket as Record<string, unknown>;
		const percent = finite(record.percent);
		if (percent === undefined) continue;
		const resetAt = resetAtFromIso(record.resetsAt);
		windows.push({
			label,
			usedPercent: clampPercent(percent),
			windowSeconds: windowSecondsFor(label, resetAt),
			resetAt,
		});
	}
	return snapshot(windows);
}

async function fetchOpencodeGoUsage(auth: AuthEntry): Promise<Snapshot> {
	const key = stringField(auth, "key");
	if (!key) throw new Error("OpenCode Go API key is not configured in Pi");
	const snapshotValue = await withTimeout(async (signal) => {
		const response = await fetch(OPENCODE_GO_USAGE_URL, {
			signal,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${key}`,
				// opencode.ai sits behind a WAF that 403s unrecognized clients before
				// auth is ever considered — without a client-shaped user-agent even the
				// documented /models endpoint is refused.
				"user-agent": "opencode/1.0",
			},
		});
		if (!response.ok) throw new Error(`OpenCode Go usage request returned ${response.status}`);
		return parseOpencodeGoUsage(await response.json());
	});
	if (!snapshotValue) throw new Error("OpenCode Go usage response contained no recognized windows");
	return snapshotValue;
}

// ── GitHub Copilot adapter ────────────────────────────────────────────

function parseCopilotBilling(value: unknown, maxCredits?: number): Snapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	const items = root.usageItems;
	if (!Array.isArray(items)) return undefined;

	let consumedCredits = 0;
	let billedCredits = 0;
	for (const item of items) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		consumedCredits += finite(record.grossQuantity) ?? 0;
		billedCredits += finite(record.netQuantity) ?? 0;
	}

	const displayCredits = consumedCredits > 0 ? consumedCredits : billedCredits;

	const timePeriod = root.timePeriod;
	const periodLabel =
		timePeriod && typeof timePeriod === "object" && !Array.isArray(timePeriod)
			? `${(timePeriod as Record<string, unknown>).year ?? ""}-${String((timePeriod as Record<string, unknown>).month ?? "").padStart(2, "0")}`
			: undefined;

	return {
		windows: [{
			label: periodLabel ?? "credits",
			usedPercent: 0,
			amount: displayCredits,
			limitAmount: maxCredits && maxCredits > 0 ? maxCredits : undefined,
			currency: "cr",
		}],
		updatedAt: Date.now(),
	};
}

async function fetchCopilotUsage(auth: AuthEntry): Promise<Snapshot> {
	const token = stringField(auth, "token");
	const username = stringField(auth, "username");
	const maxCredits = finite(auth.maxCredits);
	if (!token || !username) throw new Error("GitHub Copilot billing token not set. Use /usage set-copilot-token <ghp_...>");

	const snapshotValue = await withTimeout(async (signal) => {
		const url = `${COPILOT_BILLING_URL}/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage`;
		const response = await fetch(url, {
			signal,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2026-03-10",
			},
		});
		if (!response.ok) throw new Error(`Copilot billing request returned ${response.status}`);
		return parseCopilotBilling(await response.json(), maxCredits);
	});
	if (!snapshotValue) throw new Error("Copilot billing response contained no usage data");
	return snapshotValue;
}

// ── Provider registry ─────────────────────────────────────────────────

const PROVIDERS: ProviderSpec[] = [
	// Quota belongs to the desktop account, which should match the SDK key's account.
	{
		id: "cursor",
		name: "Cursor",
		providers: ["cursor"],
		fetch: () => fetchCursorUsage(),
	},
	{
		id: "codex",
		name: "Codex",
		// Treat OpenAI as Codex for usage only; its new OAuth token cannot read this endpoint.
		providers: ["openai-codex", "openai"],
		authKey: "openai-codex",
		fetch: fetchCodexUsage,
		parseHeaders: parseCodexHeaders,
	},
	// Display-only observer: Claude Code is a separate login, so it never
	// matches ctx.model — the popup shows it, the footer cannot.
	{
		id: "claude",
		name: "Claude",
		providers: [],
		fetch: () => fetchClaudeUsage(),
	},
	{
		id: "opencode-go",
		name: "OpenCode Go",
		providers: ["opencode-go"],
		authKey: "opencode-go",
		fetch: fetchOpencodeGoUsage,
	},
	{
		id: "xai",
		name: "xAI",
		providers: ["xai", "xai-auth"],
		authKey: "xai",
		fetch: fetchXaiUsage,
		refreshAuth: refreshXaiAuth,
	},
	{
		id: "copilot",
		name: "Copilot",
		providers: ["github-copilot"],
		authKey: COPILOT_BILLING_AUTH_KEY,
		fetch: fetchCopilotUsage,
	},
	// Display-only observer: Antigravity is a separate login, so it never
	// matches ctx.model — the popup shows it, the footer cannot.
	{
		id: "antigravity",
		name: "Antigravity",
		providers: [],
		fetch: () => fetchAntigravityUsage(),
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		providers: ["deepseek"],
		authKey: "deepseek",
		fetch: fetchDeepseekBalance,
	},
];

function findProvider(model: { provider?: string } | undefined): ProviderSpec | undefined {
	const provider = model?.provider;
	if (!provider) return undefined;
	return PROVIDERS.find((entry) => entry.providers.includes(provider));
}

// ── Rendering ─────────────────────────────────────────────────────────

/** The footer joins the countdown straight onto the percentage, so it carries the separator space. */
function footerCountdown(resetAt: number | undefined): string {
	const text = countdown(resetAt);
	return text ? ` ${text}` : "";
}

function renderWindow(ctx: ExtensionContext, window: Window): string {
	if (window.amount !== undefined && window.currency) {
		if (window.currency === "cr") {
			const used = window.amount;
			if (window.limitAmount && window.limitAmount > 0) {
				const ratio = used / window.limitAmount;
				const color = ratio >= 0.9 ? "error" : ratio >= 0.75 ? "warning" : "success";
				const formatted = `${used.toFixed(0)}cr/${window.limitAmount.toFixed(0)}cr`;
				return `${ctx.ui.theme.fg("dim", `${window.label}:`)}${ctx.ui.theme.fg(color, formatted)}`;
			}
			const formatted = `${used.toFixed(0)} cr`;
			return `${ctx.ui.theme.fg("dim", `${window.label}:`)}${ctx.ui.theme.fg("success", formatted)}`;
		}
		const symbol = window.currency === "CNY" ? "¥" : "$";
		const formatted = `${symbol}${window.amount.toFixed(2)}`;
		return `${ctx.ui.theme.fg("dim", `${window.label}:`)}${ctx.ui.theme.fg("success", formatted)}`;
	}
	const left = Math.round(100 - window.usedPercent);
	const color = left <= 10 ? "error" : left <= 25 ? "warning" : "success";
	return `${ctx.ui.theme.fg("dim", `${window.label}:`)}${ctx.ui.theme.fg(color, `${left}%`)}${ctx.ui.theme.fg("dim", footerCountdown(window.resetAt))}`;
}

function renderSnapshot(ctx: ExtensionContext, value: Snapshot): string {
	return value.windows.map((window) => renderWindow(ctx, window)).join(" ");
}

// ── Extension ─────────────────────────────────────────────────────────

export default function providerUsage(pi: ExtensionAPI): void {
	const snapshots = new Map<string, Snapshot>();
	/** Last fetch failure per provider id, summarized by the popup when hidden. */
	const errors = new Map<string, string>();
	let activeContext: ExtensionContext | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	const inFlight = new Map<string, Promise<void>>();

	const stopRefreshTimer = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		activeContext = undefined;
	};

	const footerHandle = Footer.registerSection({
		id: FOOTER_ID,
		align: "left",
		order: 30,
		essential: true,
		render: (ctx, _theme) => {
			const provider = findProvider(ctx.model);
			if (!provider) return "";
			const value = snapshots.get(provider.id);
			if (!value) return "";
			return renderSnapshot(ctx, value);
		},
	});

	const clearUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_ID, undefined);
		Footer.invalidate();
	};

	const render = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const provider = findProvider(ctx.model);
		if (!provider) {
			clearUi(ctx);
			return;
		}
		const value = snapshots.get(provider.id);
		if (!value) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${provider.name} usage: --`));
			Footer.invalidate();
			return;
		}
		ctx.ui.setStatus(STATUS_ID, renderSnapshot(ctx, value));
		Footer.invalidate();
	};

	const refreshProvider = async (provider: ProviderSpec, ctx: ExtensionContext, notify = false) => {
		activeContext = ctx;

		const existing = inFlight.get(provider.id);
		if (existing) return existing;

		const run = (async () => {
			try {
				const auth = provider.authKey !== undefined ? await readAuthEntry(provider.authKey) : {};
				const value = await provider.fetch(auth);
				snapshots.set(provider.id, value);
				errors.delete(provider.id);
				try {
					render(ctx);
				} catch {
					return;
				}
				if (notify) ctx.ui.notify(`${provider.name} usage refreshed`, "info");
			} catch (error) {
				errors.set(provider.id, error instanceof Error ? error.message : String(error));
				try {
					render(ctx);
				} catch {
					return;
				}
				if (notify) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${provider.name} usage unavailable: ${message}`, "warning");
				}
			} finally {
				inFlight.delete(provider.id);
			}
		})();

		inFlight.set(provider.id, run);
		return run;
	};

	const refresh = (ctx: ExtensionContext, notify = false) => {
		const provider = findProvider(ctx.model);
		if (!provider) return Promise.resolve();
		return refreshProvider(provider, ctx, notify);
	};

	/** Fetch every tracked provider in parallel; failures land in `errors` for the popup. */
	const refreshAll = (ctx: ExtensionContext) => {
		activeContext = ctx;
		return Promise.all(PROVIDERS.map((provider) => refreshProvider(provider, ctx)));
	};

	const updateModelVisibility = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (findProvider(ctx.model)) {
			render(ctx);
			void refresh(ctx);
		} else {
			clearUi(ctx);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		stopRefreshTimer();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		activeContext = ctx;
		updateModelVisibility(ctx);
		refreshTimer = setInterval(() => {
			try {
				if (activeContext && findProvider(activeContext.model)) void refresh(activeContext);
			} catch {
				// Session replacement can invalidate the context before shutdown cleanup runs.
				stopRefreshTimer();
			}
		}, REFRESH_MS);
		refreshTimer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		activeContext = ctx;
		updateModelVisibility(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (findProvider(ctx.model)) void refresh(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const provider = findProvider(ctx.model);
		if (!provider?.parseHeaders) return;
		const update = provider.parseHeaders(event.headers ?? {});
		if (!update) return;
		const previous = snapshots.get(provider.id);
		const mergedWindows = update.windows.map((window) => {
			const prior = previous?.windows.find((entry) => entry.label === window.label);
			return prior ? { ...prior, ...window } : window;
		});
		// Keep any previous windows that the headers did not mention.
		if (previous) {
			for (const prior of previous.windows) {
				if (!mergedWindows.some((window) => window.label === prior.label)) {
					mergedWindows.push(prior);
				}
			}
		}
		snapshots.set(provider.id, { windows: mergedWindows, updatedAt: update.updatedAt });
		render(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopRefreshTimer();
		clearUi(ctx);
		footerHandle.unregister();
	});

	// ── /usage subcommands ───────────────────────────────────────────────

	type Subcommand = {
		name: string;
		aliases: string[];
		description: string;
		argumentHint?: string;
		handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	};

	const SUBCOMMANDS: Subcommand[] = [
		{
			name: "refresh",
			aliases: ["r", "reload"],
			description: "Refresh the provider usage footer",
			handler: async (_args, ctx) => refresh(ctx, true),
		},
		{
			name: "status",
			aliases: ["s", "show"],
			description: "Show the current provider usage values",
			handler: async (_args, ctx) => {
				const provider = findProvider(ctx.model);
				if (!provider) {
					const names = PROVIDERS.map((entry) => entry.name).join(" or ");
					ctx.ui.notify(`Usage is only available when a ${names} model is selected.`, "warning");
					return;
				}
				await refresh(ctx);
				const value = snapshots.get(provider.id);
				if (!value) {
					ctx.ui.notify(
						`${provider.name} usage is unavailable. Run /login and select ${provider.name}.`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(renderSnapshot(ctx, value), "info");
			},
		},
		{
			name: "set-copilot-token",
			aliases: ["copilot-token", "token"],
			description: "Set a GitHub PAT with plan:read scope for Copilot billing usage",
			argumentHint: "<ghp_...> [maxCredits]",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const token = parts[0];
				const maxCreditsArg = parts[1];
				if (!token) {
					ctx.ui.notify("Usage: /usage set-copilot-token <ghp_...> [maxCredits]", "warning");
					return;
				}
				const maxCredits = maxCreditsArg === undefined ? undefined : Number(maxCreditsArg);
				if (maxCreditsArg !== undefined && (maxCredits === undefined || !Number.isFinite(maxCredits) || maxCredits <= 0)) {
					ctx.ui.notify("maxCredits must be a positive number.", "error");
					return;
				}
				try {
					const response = await fetch("https://api.github.com/user", {
						headers: {
							accept: "application/vnd.github+json",
							authorization: `Bearer ${token}`,
							"X-GitHub-Api-Version": "2026-03-10",
						},
						signal: AbortSignal.timeout(10_000),
					});
					if (!response.ok) {
						ctx.ui.notify(`GitHub API returned ${response.status}. Is the token valid?`, "error");
						return;
					}
					const user = (await response.json()) as Record<string, unknown>;
					const username = stringField(user, "login");
					if (!username) {
						ctx.ui.notify("Could not determine GitHub username from token.", "error");
						return;
					}
					const auth = await readAuthFile();
					const existing = auth[COPILOT_BILLING_AUTH_KEY];
					const previousMax =
						existing && typeof existing === "object" && !Array.isArray(existing)
							? finite((existing as Record<string, unknown>).maxCredits)
							: undefined;
					auth[COPILOT_BILLING_AUTH_KEY] = {
						token,
						username,
						...(maxCredits !== undefined ? { maxCredits } : previousMax !== undefined ? { maxCredits: previousMax } : {}),
					};
					await writeAuthFile(auth);
					ctx.ui.notify(
						maxCredits !== undefined
							? `Copilot billing token set for @${username} (${maxCredits.toFixed(0)}cr/mo).`
							: `Copilot billing token set for @${username}.`,
						"info",
					);
					if (findProvider(ctx.model)?.id === "copilot") void refresh(ctx, true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to set Copilot token: ${message}`, "error");
				}
			},
		},
		{
			name: "set-copilot-max",
			aliases: ["copilot-max", "max"],
			description: "Set the monthly Copilot credit allowance used for footer display",
			argumentHint: "<credits>",
			handler: async (args, ctx) => {
				const maxCredits = Number(args.trim());
				if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
					ctx.ui.notify("Usage: /usage set-copilot-max <positive number>", "warning");
					return;
				}
				try {
					const auth = await readAuthFile();
					const existing = auth[COPILOT_BILLING_AUTH_KEY];
					if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
						auth[COPILOT_BILLING_AUTH_KEY] = { maxCredits };
					} else {
						auth[COPILOT_BILLING_AUTH_KEY] = {
							...(existing as Record<string, unknown>),
							maxCredits,
						};
					}
					await writeAuthFile(auth);
					ctx.ui.notify(`Copilot monthly max set to ${maxCredits.toFixed(0)}cr.`, "info");
					if (findProvider(ctx.model)?.id === "copilot") void refresh(ctx, true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to set Copilot max: ${message}`, "error");
				}
			},
		},
		{
			name: "unset-copilot-token",
			aliases: ["remove-copilot-token", "clear-copilot", "clear"],
			description: "Remove the stored Copilot billing token",
			handler: async (_args, ctx) => {
				try {
					const auth = await readAuthFile();
					delete auth[COPILOT_BILLING_AUTH_KEY];
					await writeAuthFile(auth);
					snapshots.delete("copilot");
					errors.delete("copilot");
					ctx.ui.notify("Copilot billing token removed.", "info");
					updateModelVisibility(ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to remove Copilot token: ${message}`, "error");
				}
			},
		},
	];

	function findSubcommand(name: string): Subcommand | undefined {
		const normalized = name.toLowerCase();
		return SUBCOMMANDS.find((cmd) => cmd.name === normalized || cmd.aliases.includes(normalized));
	}

	// Simple fuzzy scorer: rewards prefix/substring matches and character-in-order matches.
	function fuzzyScore(query: string, target: string): number {
		const ql = query.toLowerCase();
		const tl = target.toLowerCase();
		if (tl.startsWith(ql)) return 1000 + ql.length / tl.length;
		if (tl.includes(ql)) return 500 + ql.length / tl.length;

		let ti = 0;
		let matched = 0;
		for (const ch of ql) {
			const idx = tl.indexOf(ch, ti);
			if (idx === -1) return 0;
			ti = idx + 1;
			matched++;
		}
		if (matched !== ql.length) return 0;

		const gaps = ti - ql.length;
		return 100 * (ql.length / tl.length) - gaps * 2;
	}

	function subcommandCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
		const query = prefix.trim().toLowerCase();
		const scored = SUBCOMMANDS.map((cmd) => {
			const names = [cmd.name, ...cmd.aliases];
			let best = -Infinity;
			for (const name of names) {
				const score = query === "" ? 1 : fuzzyScore(query, name);
				if (score > best) best = score;
			}
			return { cmd, score: best };
		})
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);

		return scored.map(({ cmd }) => ({
			value: cmd.name,
			label: cmd.name,
			description: cmd.argumentHint ? `${cmd.argumentHint} — ${cmd.description}` : cmd.description,
		}));
	}

	/** Open the all-providers overview as a floating overlay. */
	const openPopup = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			// No TUI (print/RPC mode): fall back to the plain text status.
			const status = SUBCOMMANDS.find((cmd) => cmd.name === "status");
			if (status) await status.handler("", ctx);
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			return new UsagePopup({
				theme,
				done,
				requestRender: () => tui.requestRender(),
				getRows: () => PROVIDERS.map((provider) => ({
					name: provider.name,
					snapshot: snapshots.get(provider.id),
					error: errors.get(provider.id),
				})),
				refresh: () => {
					void refreshAll(ctx).then(() => tui.requestRender());
				},
				isRefreshing: () => inFlight.size > 0,
			});
		}, { overlay: true, overlayOptions: { anchor: "center", width: USAGE_POPUP_WIDTH } });
	};

	pi.registerCommand("usage", {
		description: "All-providers usage popup; subcommands: refresh, status, set-copilot-token, set-copilot-max, unset-copilot-token",
		getArgumentCompletions: subcommandCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await openPopup(ctx);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const subName = parts[0] ?? "";
			const rest = trimmed.slice(subName.length).trimStart();
			const cmd = findSubcommand(subName);
			if (!cmd) {
				ctx.ui.notify(
					`Unknown usage subcommand: ${subName}. Available: ${SUBCOMMANDS.map((c) => c.name).join(", ")}.`,
					"warning",
				);
				return;
			}
			await cmd.handler(rest, ctx);
		},
	});
}
