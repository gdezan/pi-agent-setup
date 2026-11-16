/** Cursor account quota uses the desktop login, not pi-cursor-sdk's API key. */
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Snapshot, Window } from "./types.ts";
import { clampPercent, finite, snapshot } from "./types.ts";

const runFile = promisify(execFile);
const TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 60_000;
const SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";
const CURSOR_KEYCHAIN_ERROR =
  "Cursor Keychain access unavailable; allow access and manually refresh to retry";
let keychainBlocked = false;

export function retryCursorKeychain(): void {
  keychainBlocked = false;
}

async function decryptToken(value: string, skipKeychain: boolean): Promise<string> {
  if (!value.startsWith(SAFE_STORAGE_PREFIX)) return value;
  if (process.platform !== "darwin")
    throw new Error("Encrypted Cursor desktop credentials are only supported on macOS");
  const encoded = value.slice(SAFE_STORAGE_PREFIX.length);
  const blob = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    blob.toString("base64") !== encoded ||
    blob.subarray(0, 3).toString() !== "v10" ||
    blob.length <= 3 ||
    (blob.length - 3) % 16 !== 0
  ) {
    throw new Error("Cursor desktop credentials use an unsupported encrypted format");
  }
  if (skipKeychain || keychainBlocked) throw new Error(CURSOR_KEYCHAIN_ERROR);
  let password: string;
  try {
    const result = await runFile(
      "security",
      ["find-generic-password", "-s", "Cursor Safe Storage", "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    password = result.stdout.replace(/\r?\n$/, "");
    if (!password) throw new Error("missing key");
  } catch {
    keychainBlocked = true;
    throw new Error(CURSOR_KEYCHAIN_ERROR);
  }
  try {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const cipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    return Buffer.concat([cipher.update(blob.subarray(3)), cipher.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt Cursor desktop credentials with the Keychain key");
  }
}

function credentialPath(): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Use dashboard percentages, not monetary used/limit: they have different semantics. */
export function parseCursorUsage(value: unknown): Snapshot {
  const root = record(value);
  const plan = record(record(root?.individualUsage)?.plan);
  if (!plan || plan.enabled === false)
    throw new Error("Cursor usage response contained no enabled plan quota");
  const resetAt = epochSeconds(root?.billingCycleEnd);
  const startAt = epochSeconds(root?.billingCycleStart);
  const windowSeconds =
    resetAt !== undefined && startAt !== undefined && resetAt > startAt
      ? resetAt - startAt
      : undefined;
  const windows: Window[] = [];
  for (const [key, label] of [
    ["autoPercentUsed", "Cursor"],
    ["apiPercentUsed", "Other"],
  ]) {
    const usedPercent = finite(plan[key]);
    if (usedPercent === undefined) continue;
    windows.push({ label, usedPercent: clampPercent(usedPercent), resetAt, windowSeconds });
  }
  const result = snapshot(windows);
  if (!result) throw new Error("Cursor usage response contained no recognized percentages");
  return result;
}

async function sessionCookie(path: string, skipKeychain: boolean): Promise<string> {
  // Isolate synchronous SQLite work and its experimental warnings from Pi's TUI.
  // Only stdout carries the token, captured in memory; child errors are never surfaced raw.
  let token: string;
  try {
    const { stdout } = await runFile(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
			import { DatabaseSync } from 'node:sqlite';
			const db = new DatabaseSync(process.argv[1], { readOnly: true });
			try {
				const row = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get('cursorAuth/accessToken');
				process.stdout.write(JSON.stringify(row?.value ?? null));
			} finally { db.close(); }
		`,
        path,
      ],
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "string" || !value.trim()) throw new Error("missing token");
    token = value;
  } catch {
    throw new Error(
      "Cursor desktop credentials are not configured or unreadable; open Cursor and sign in",
    );
  }
  token = await decryptToken(token, skipKeychain);
  let claims: Record<string, unknown> | undefined;
  try {
    const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
    claims = record(JSON.parse(payload));
  } catch {
    throw new Error("Cursor desktop credentials are invalid; open Cursor and sign in again");
  }
  const userId = typeof claims?.sub === "string" ? claims.sub.split("|").at(-1) : undefined;
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId) || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error("Cursor desktop credentials are invalid; open Cursor and sign in again");
  }
  const expires = finite(claims?.exp);
  if (expires !== undefined && expires <= Date.now() / 1000) {
    throw new Error("Cursor desktop login expired; open Cursor and sign in again");
  }
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`;
}

/** Read-only observer. Never refreshes or changes Cursor's credentials. */
export async function fetchCursorUsage(
  path = credentialPath(),
  skipKeychain = false,
): Promise<Snapshot> {
  const cookie = await sessionCookie(path, skipKeychain);
  const response = await fetch("https://cursor.com/api/usage-summary", {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json", cookie },
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new Error("Cursor desktop login was rejected; open Cursor and sign in again");
    }
    throw new Error(`Cursor usage request returned ${response.status}`);
  }
  return parseCursorUsage(await response.json());
}
