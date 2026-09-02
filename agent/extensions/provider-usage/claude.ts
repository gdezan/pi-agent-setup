/**
 * Claude Code subscription usage.
 *
 * Reads Claude Code's own OAuth store (~/.claude/.credentials.json) rather than
 * pi's auth.json — Claude Code is a separate login from any pi provider, and
 * this adapter only observes its quota. Ported from the scoutr bridge's
 * usage/claude.ts, narrowed to the record-poking style of this extension.
 *
 * Access tokens live ~60 minutes and `claude` only refreshes them while it is
 * running, so the token on disk is routinely expired by the time we ask. The
 * recovery ladder, cheapest first:
 *
 *   1. refresh proactively when `expiresAt` says the token is spent;
 *   2. on a 401 anyway, re-read the file — `claude` may have just rotated it;
 *   3. still 401 with an unchanged token: refresh and retry once.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Snapshot, Window } from "./types.ts";
import { clampPercent, finite, snapshot } from "./types.ts";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
const STATE_PATH = `${CLAUDE_DIR}.json`;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_BETA = "oauth-2025-04-20";
const CLAUDE_TIMEOUT_MS = 10_000;

/**
 * Anthropic buckets requests by user-agent: an unrecognized one lands in an
 * aggressively rate-limited pool that answers 429 almost immediately. Claude
 * Code records its own version in ~/.claude.json, so track that rather than
 * pinning a version string that silently ages out.
 */
const CLAUDE_FALLBACK_VERSION = "2.1.0";

/** Anthropic moved token exchange to platform.claude.com; console 404s but still works for some accounts. */
const CLAUDE_TOKEN_URLS = [
	"https://platform.claude.com/v1/oauth/token",
	"https://console.anthropic.com/v1/oauth/token",
];
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_SKEW_MS = 5 * 60 * 1000;

// ── Record helpers ────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringField(recordValue: Record<string, unknown>, key: string): string | undefined {
	const value = recordValue[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── Response parsing ──────────────────────────────────────────────────

function claudeResetAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.round(value > 10_000_000_000 ? value / 1000 : value);
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return claudeResetAt(Number(trimmed));
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function claudeWindowSeconds(label: string): number | undefined {
	if (label === "5h") return 5 * 60 * 60;
	if (label === "7d" || label.startsWith("7d ")) return 7 * 24 * 60 * 60;
	return undefined;
}

function claudeWindow(
	value: unknown,
	label: string,
	percentKey: "utilization" | "percent" = "utilization",
): Window | undefined {
	const recordValue = record(value);
	if (!recordValue) return undefined;
	const usedPercent = finite(recordValue[percentKey]) ?? finite(recordValue.used_percentage);
	if (usedPercent === undefined) return undefined;
	return {
		label,
		usedPercent: clampPercent(usedPercent),
		windowSeconds: claudeWindowSeconds(label),
		resetAt: claudeResetAt(recordValue.resets_at),
	};
}

function scopedClaudeLabel(limit: Record<string, unknown>): string {
	const scope = record(limit.scope);
	const model = record(scope?.model);
	const displayName = stringField(model ?? {}, "display_name") ?? stringField(model ?? {}, "displayName");
	return displayName && displayName.trim() !== "" ? `7d ${displayName.trim()}` : "7d scoped";
}

/** The `limits[]` shape supersedes the legacy five_hour/seven_day keys; both may appear. */
function windowsFromClaudeLimits(root: Record<string, unknown>): Window[] {
	const limits = root.limits;
	if (!Array.isArray(limits)) return [];
	const windows: Window[] = [];
	for (const limit of limits) {
		const recordValue = record(limit);
		if (!recordValue || typeof recordValue.kind !== "string") continue;
		const label =
			recordValue.kind === "session"
				? "5h"
				: recordValue.kind === "weekly_all"
					? "7d"
					: recordValue.kind === "weekly_scoped"
						? scopedClaudeLabel(recordValue)
						: undefined;
		if (!label) continue;
		const window = claudeWindow(recordValue, label, "percent");
		if (window) windows.push(window);
	}
	return windows;
}

/** Convert Claude Code's OAuth usage response into the shared quota-window model. */
export function parseClaudeUsage(value: unknown): Snapshot {
	const root = record(value);
	if (!root) throw new Error("Claude usage response was not an object");

	const legacyWindows = [
		claudeWindow(root.five_hour, "5h"),
		claudeWindow(root.seven_day, "7d"),
		claudeWindow(root.seven_day_opus, "7d Opus"),
		claudeWindow(root.seven_day_sonnet, "7d Sonnet"),
	];
	const windowsByLabel = new Map<string, Window>();
	for (const window of legacyWindows) {
		if (window && !windowsByLabel.has(window.label)) windowsByLabel.set(window.label, window);
	}
	for (const window of windowsFromClaudeLimits(root)) windowsByLabel.set(window.label, window);
	const preferredOrder = ["5h", "7d", "7d Opus", "7d Sonnet"];
	const windows = [
		...preferredOrder.flatMap((label) => (windowsByLabel.has(label) ? [windowsByLabel.get(label)!] : [])),
		...[...windowsByLabel.values()].filter((window) => !preferredOrder.includes(window.label)),
	];

	const result = snapshot(windows);
	if (!result) throw new Error("Claude usage response contained no recognized windows");
	return result;
}

// ── Credentials ───────────────────────────────────────────────────────

interface ClaudeCredentials {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

async function readClaudeCredentials(path: string): Promise<ClaudeCredentials | undefined> {
	let file: unknown;
	try {
		file = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		// A missing credential file means the user has not signed in yet; any
		// other read failure is a real error worth surfacing.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const oauth = record(record(file)?.claudeAiOauth);
	const accessToken = stringField(oauth ?? {}, "accessToken");
	if (!accessToken) return undefined;
	return {
		accessToken,
		refreshToken: stringField(oauth!, "refreshToken"),
		expiresAt: finite(oauth!.expiresAt),
	};
}

/**
 * Exchange the refresh token and merge the result back into the credential file.
 *
 * Anthropic rotates the refresh token, so persisting is what keeps `claude`'s
 * own login alive — dropping the rotated token would leave the file one
 * rotation behind and eventually force a re-login.
 */
async function refreshClaudeCredentials(path: string, credentials: ClaudeCredentials): Promise<ClaudeCredentials> {
	if (!credentials.refreshToken) {
		throw new Error("Claude Code OAuth token expired and no refresh token is stored; run `claude` to sign in");
	}
	const payload = {
		grant_type: "refresh_token",
		client_id: CLAUDE_CLIENT_ID,
		refresh_token: credentials.refreshToken,
	};

	let lastError: Error | undefined;
	for (const url of CLAUDE_TOKEN_URLS) {
		const response = await fetch(url, {
			method: "POST",
			signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (response.status === 404) {
			// Endpoint moved (Anthropic did exactly this); try the next candidate.
			void response.body?.cancel().catch(() => undefined);
			lastError = new Error(`Claude token refresh returned 404 from ${url}`);
			continue;
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			// 400/401 means the stored refresh token is spent or revoked. No amount
			// of retrying recovers it, so say what actually fixes it.
			if (response.status === 400 || response.status === 401) {
				throw new Error("Claude refresh token is no longer valid; run `claude` and sign in again");
			}
			throw new Error(`Claude token refresh returned ${response.status}`);
		}

		const body = record(await response.json());
		const access = stringField(body ?? {}, "access_token");
		if (!access) throw new Error("Claude token refresh returned no access token");
		const expiresIn = finite(body!.expires_in) ?? 3600;
		const refreshed: ClaudeCredentials = {
			accessToken: access,
			refreshToken: stringField(body!, "refresh_token") ?? credentials.refreshToken,
			expiresAt: Date.now() + expiresIn * 1000,
		};

		const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		const stored = record(file.claudeAiOauth) ?? {};
		file.claudeAiOauth = {
			...stored,
			accessToken: refreshed.accessToken,
			...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
			expiresAt: refreshed.expiresAt,
		};
		await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");

		return refreshed;
	}

	throw lastError ?? new Error("Claude token refresh had no endpoint to try");
}

/** Claude Code records the version it last onboarded with; it is the closest thing to "installed version". */
async function claudeUserAgent(statePath: string): Promise<string> {
	try {
		const state = record(JSON.parse(await readFile(statePath, "utf8")));
		const version = stringField(state ?? {}, "lastOnboardingVersion");
		if (version && /^\d+\.\d+/.test(version)) return `claude-code/${version}`;
	} catch {
		// Fall through to the pinned version; a plausible UA still beats none.
	}
	return `claude-code/${CLAUDE_FALLBACK_VERSION}`;
}

// ── Fetch ─────────────────────────────────────────────────────────────

async function claudeUsageError(response: Response): Promise<Error> {
	let detail: string | undefined;
	try {
		const body = record(await response.json());
		detail = stringField(record(body?.error) ?? {}, "message");
	} catch {
		// The status still gives the user a searchable failure when the body is not JSON.
	}
	return new Error(`Claude usage request returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function requestClaudeUsage(accessToken: string, userAgent: string): Promise<Response> {
	return fetch(CLAUDE_USAGE_URL, {
		signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
		headers: {
			authorization: `Bearer ${accessToken}`,
			"anthropic-beta": CLAUDE_USAGE_BETA,
			"content-type": "application/json",
			"user-agent": userAgent,
		},
	});
}

/** Fetch Claude Code subscription usage from Claude Code's own OAuth store. */
export async function fetchClaudeUsage(): Promise<Snapshot> {
	let credentials = await readClaudeCredentials(CREDENTIALS_PATH);
	if (!credentials) throw new Error("Claude Code OAuth credentials are not configured; run `claude` to sign in");

	if (credentials.expiresAt !== undefined && credentials.expiresAt - TOKEN_SKEW_MS <= Date.now()) {
		credentials = await refreshClaudeCredentials(CREDENTIALS_PATH, credentials);
	}

	const userAgent = await claudeUserAgent(STATE_PATH);
	let response = await requestClaudeUsage(credentials.accessToken, userAgent);

	if (response.status === 401) {
		void response.body?.cancel().catch(() => undefined);
		// `claude` may have rotated the token on disk while we held the old one.
		const onDisk = await readClaudeCredentials(CREDENTIALS_PATH);
		credentials =
			onDisk && onDisk.accessToken !== credentials.accessToken
				? onDisk
				: await refreshClaudeCredentials(CREDENTIALS_PATH, credentials);
		response = await requestClaudeUsage(credentials.accessToken, userAgent);
	}

	if (!response.ok) throw await claudeUsageError(response);
	return parseClaudeUsage(await response.json());
}
