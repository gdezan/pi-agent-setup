/**
 * Antigravity (Google's agentic CLI, `agy`) quota.
 *
 * Antigravity ships as a Gemini CLI sibling, so its OAuth token lives under
 * ~/.gemini/antigravity-cli/ rather than a directory of its own. Tokens are
 * ordinary Google OAuth refreshed at oauth2.googleapis.com with the client
 * credentials `agy` itself embeds; they are duplicated here so the extension
 * needs no external secret. The Gemini CLI client (public knowledge, also
 * used by `agy`) refreshes consumer-account tokens; Antigravity's own client
 * covers managed accounts.
 *
 * Ported from the scoutr bridge's usage/antigravity.ts, which sourced the
 * clients from an env secret instead.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Snapshot, Window } from "./types.ts";
import { clampPercent, finite, snapshot } from "./types.ts";
import { windowSecondsFor } from "./windows.ts";

const ANTIGRAVITY_TIMEOUT_MS = 10_000;
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** `agy` uses two OAuth clients — one per auth_method (consumer vs managed). */
const OAUTH_CLIENTS = [
	{ id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", secret: "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" },
	{ id: "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com", secret: "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" },
];
let workingClientIndex = 0;

/** This install talks to the `daily-` channel; the production host is the fallback. */
const QUOTA_HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";

// ── Record helpers ────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringField(recordValue: Record<string, unknown>, key: string): string | undefined {
	const value = recordValue[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resetAtFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.round(value > 10_000_000_000 ? value / 1000 : value);
	}
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value.trim());
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

// ── Token file ────────────────────────────────────────────────────────

function tokenPath(): string {
	return join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

interface AntigravityToken {
	access: string;
	refresh?: string;
	/** Epoch ms, parsed from the Go RFC3339 `expiry` field. */
	expires?: number;
}

async function readAntigravityToken(path: string): Promise<AntigravityToken | undefined> {
	let file: unknown;
	try {
		file = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		// A missing token file means the user has not signed in yet; any other
		// read failure is a real error worth surfacing.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const token = record(record(file)?.token);
	const access = stringField(token ?? {}, "access_token");
	if (!access) return undefined;
	const expiryRaw = stringField(token!, "expiry");
	const expiry = expiryRaw !== undefined ? Date.parse(expiryRaw) : Number.NaN;
	return {
		access,
		refresh: stringField(token!, "refresh_token"),
		expires: Number.isFinite(expiry) ? expiry : undefined,
	};
}

/**
 * Refresh via Google and merge the result back into the token file.
 *
 * Unlike Anthropic and OpenAI, Google does not rotate installed-app refresh
 * tokens, so the write-back here only advances the access token and expiry —
 * but it still matters, otherwise every poll would burn a fresh exchange.
 */
async function refreshAntigravityToken(path: string, token: AntigravityToken): Promise<AntigravityToken> {
	if (!token.refresh) {
		throw new Error("Antigravity OAuth token expired and no refresh token is stored; run `agy` to sign in");
	}

	const attempt = async (client: { id: string; secret: string }) =>
		fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: token.refresh!,
				client_id: client.id,
				client_secret: client.secret,
			}),
		});

	// Start from the client that worked last time, then fall through to the other.
	const order = [workingClientIndex, ...OAUTH_CLIENTS.keys()].filter(
		(index, position, all) => all.indexOf(index) === position,
	);

	let lastDetail = "";
	for (const index of order) {
		const response = await attempt(OAUTH_CLIENTS[index]!);
		if (response.ok) {
			const body = record(await response.json());
			const access = stringField(body ?? {}, "access_token");
			if (!access) throw new Error("Antigravity token refresh returned no access token");
			const expiresIn = finite(body!.expires_in) ?? 3600;
			workingClientIndex = index;

			const refresh = stringField(body!, "refresh_token") ?? token.refresh;
			const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			file.token = {
				...(record(file.token) ?? {}),
				access_token: access,
				refresh_token: refresh,
				expiry: new Date(Date.now() + expiresIn * 1000).toISOString(),
			};
			await writeFile(path, JSON.stringify(file), "utf8");

			return { access, refresh, expires: Date.now() + expiresIn * 1000 };
		}
		const detail = await response.text().catch(() => "");
		lastDetail = `${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
		void response.body?.cancel().catch(() => undefined);
	}

	throw new Error(`Antigravity token refresh failed (${lastDetail}); run \`agy\` to sign in`);
}

// ── Quota parsing ─────────────────────────────────────────────────────

/**
 * Flatten the quota summary into windows.
 *
 * Shape: `groups[]` are model families ("Gemini Models", "Claude and GPT
 * models") and each carries `buckets[]` per window. `remainingFraction` counts
 * down from 1.0, so it inverts into the used-percent the rest of the UI shows.
 */
export function parseAntigravityUsage(value: unknown): Snapshot {
	const root = record(value);
	const groups = (root?.groups ?? record(root?.response)?.groups) as unknown;
	if (!Array.isArray(groups)) throw new Error("Antigravity quota response contained no groups");

	const windows: Window[] = [];
	for (const group of groups) {
		const groupRecord = record(group);
		if (!groupRecord) continue;
		const groupName = stringField(groupRecord, "displayName") ?? "";
		const buckets = groupRecord.buckets;
		if (!Array.isArray(buckets)) continue;
		for (const bucket of buckets) {
			const bucketRecord = record(bucket);
			if (!bucketRecord) continue;
			const remaining = finite(bucketRecord.remainingFraction);
			if (remaining === undefined) continue;
			const resetAt = resetAtFrom(bucketRecord.resetTime);
			const name = windowName(bucketRecord);
			windows.push({
				label: groupName === "" ? name : `${shortGroup(groupName)} ${name}`,
				usedPercent: clampPercent((1 - remaining) * 100),
				// Drives the meter's elapsed-time guide; the group prefix is not a window.
				windowSeconds: windowSecondsFor(name, resetAt),
				resetAt,
			});
		}
	}

	const result = snapshot(windows);
	if (!result) throw new Error("Antigravity quota response contained no recognized windows");
	return result;
}

/** "Gemini Models" -> "Gemini", "Claude and GPT models" -> "Claude+GPT". */
function shortGroup(name: string): string {
	return name.replace(/\s*models?\s*$/i, "").replace(/\s+and\s+/gi, "+").trim() || name;
}

/**
 * The window part of a bar label, e.g. "wk" — the group prefix is added by the
 * caller, which also needs this part alone to resolve the window's span.
 *
 * The API's own `displayName` is prose ("Weekly Limit Remaining") and far too
 * long to sit beside Codex's "5h"/"7d", so the machine-readable `window` is
 * preferred and the prose is only a fallback.
 */
function windowName(bucket: Record<string, unknown>): string {
	if (bucket.window === "daily") return "day";
	if (bucket.window === "weekly") return "wk";
	if (bucket.window === "monthly") return "mo";
	const display = stringField(bucket, "displayName");
	if (display) return display.trim();
	return stringField(bucket, "bucketId") ?? "quota";
}

// ── Fetch ─────────────────────────────────────────────────────────────

async function requestQuota(host: string, access: string): Promise<Response> {
	return fetch(`${host}${QUOTA_PATH}`, {
		method: "POST",
		signal: AbortSignal.timeout(ANTIGRAVITY_TIMEOUT_MS),
		headers: {
			authorization: `Bearer ${access}`,
			"content-type": "application/json",
			accept: "application/json",
			"user-agent": "antigravity",
		},
		body: JSON.stringify({}),
	});
}

/** Fetch Antigravity subscription quota, refreshing the Google token when it has expired. */
export async function fetchAntigravityUsage(): Promise<Snapshot> {
	const path = tokenPath();
	let token = await readAntigravityToken(path);
	if (!token) throw new Error("Antigravity credentials are not configured; run `agy` to sign in");
	if (token.expires !== undefined && token.expires - TOKEN_SKEW_MS <= Date.now()) {
		token = await refreshAntigravityToken(path, token);
	}

	let lastStatus = 0;
	for (const host of QUOTA_HOSTS) {
		let response = await requestQuota(host, token.access);
		if (response.status === 401) {
			void response.body?.cancel().catch(() => undefined);
			token = await refreshAntigravityToken(path, token);
			response = await requestQuota(host, token.access);
		}
		if (response.ok) {
			return parseAntigravityUsage(await response.json());
		}
		lastStatus = response.status;
		void response.body?.cancel().catch(() => undefined);
		// 404 means this channel does not serve the RPC; anything else is a real failure.
		if (response.status !== 404) break;
	}
	throw new Error(`Antigravity quota request returned ${lastStatus}`);
}
