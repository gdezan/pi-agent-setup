import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  fetchCursorUsage,
  parseCursorUsage,
  retryCursorKeychain,
} from "../gd-provider-usage/cursor.ts";
import { UsagePopup } from "../gd-provider-usage/popup.ts";

const usage = {
  billingCycleStart: "2026-09-26T21:19:26.000Z",
  billingCycleEnd: "2026-10-26T21:19:26.000Z",
  individualUsage: {
    plan: {
      enabled: true,
      used: 2000,
      limit: 2000,
      autoPercentUsed: 23.86190476190476,
      apiPercentUsed: 26,
      totalPercentUsed: 24.204,
    },
  },
};

test("Cursor desktop quota flows through refresh, footer and popup without credential writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-usage-test-"));
  const savedEnv = {
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  process.env.APPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  const path = join(
    home,
    ...(process.platform === "darwin" ? ["Library", "Application Support"] : []),
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
  let shutdown: (() => void) | undefined;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected request");
    };
    await assert.rejects(fetchCursorUsage(path), /credentials are not configured or unreadable/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(path), { code: "ENOENT" }, "missing store must not be created");
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const token = (exp: number) =>
      `header.${Buffer.from(JSON.stringify({ sub: "auth0|user_fixture", exp })).toString("base64url")}.signature`;
    const setToken = (value: string) =>
      db
        .prepare("INSERT OR REPLACE INTO ItemTable VALUES (?, ?)")
        .run("cursorAuth/accessToken", value);
    try {
      setToken(token(1));
      await assert.rejects(fetchCursorUsage(path), /login expired/);
      assert.equal(calls, 0);
      const validToken = token(Math.floor(Date.now() / 1000) + 3600);
      setToken(validToken);
      globalThis.fetch = async () => new Response("sensitive response body", { status: 401 });
      await assert.rejects(fetchCursorUsage(path), /login was rejected/);
    } finally {
      db.close();
    }
    const before = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://cursor.com/api/usage-summary");
      assert.equal(options?.method, "GET");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      assert.match(
        new Headers(options?.headers).get("cookie")!,
        /^WorkosCursorSessionToken=user_fixture%3A%3Aheader\./,
      );
      assert.equal(new Headers(options?.headers).get("authorization"), null);
      return Response.json(usage);
    };
    const snapshot = await fetchCursorUsage(path);
    assert.deepEqual(snapshot.windows, [
      {
        label: "Cursor",
        usedPercent: 23.86190476190476,
        resetAt: 1793049566,
        windowSeconds: 2592000,
      },
      { label: "Other", usedPercent: 26, resetAt: 1793049566, windowSeconds: 2592000 },
    ]);
    const { default: providerUsage } = await import("../gd-provider-usage/provider-usage.ts");
    const handlers = new Map<string, Function>();
    const commands = new Map<string, { handler: Function }>();
    let status = "";
    const ctx = {
      hasUI: true,
      model: { provider: "cursor" },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_id: string, text: string) => {
          status = text;
        },
        notify: () => {},
      },
    };
    providerUsage({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (name: string, command: { handler: Function }) =>
        commands.set(name, command),
    } as Parameters<typeof providerUsage>[0]);
    shutdown = () => handlers.get("session_shutdown")!({}, ctx);
    await commands.get("usage")!.handler("refresh", ctx);
    assert.match(status, /^Cursor:76%.*Other:74%/);
    let closes = 0;
    let refreshes = 0;
    const popup = new UsagePopup({
      theme: ctx.ui.theme as never,
      done: () => {
        closes++;
      },
      requestRender: () => {},
      getRows: () => [{ name: "Cursor", snapshot }],
      refresh: () => {
        refreshes++;
      },
      isRefreshing: () => false,
    });
    try {
      const lines = popup.render(60);
      assert.match(lines.join("\n"), /Cursor.*24%/);
      assert.match(lines.join("\n"), /Other.*26%/);
      popup.handleInput("r");
      popup.handleInput("\u001b");
      assert.equal(refreshes, 2);
      assert.equal(closes, 1);
    } finally {
      popup.dispose();
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      before,
    );
  } finally {
    shutdown?.();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "Cursor encrypted macOS credentials use Keychain without changing the database",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-encrypted-"));
    const oldPath = process.env.PATH;
    const previousFetch = globalThis.fetch;
    try {
      const password = "fixture-password";
      const token = `header.${Buffer.from(JSON.stringify({ sub: "auth0|fixture", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
      const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(token), cipher.final()]);
      const path = join(dir, "state.vscdb");
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
        "cursorAuth/accessToken",
        `cursor-safe-storage:v1:${encrypted.toString("base64")}`,
      );
      db.close();
      const before = await readFile(path);
      await writeFile(join(dir, "security"), `#!/bin/sh\nprintf '%s\\n' '${password}'\n`, {
        mode: 0o700,
      });
      process.env.PATH = `${dir}:${oldPath}`;
      globalThis.fetch = async (_url, options) => {
        assert.equal(
          new Headers(options?.headers).get("cookie"),
          `WorkosCursorSessionToken=fixture%3A%3A${token}`,
        );
        return Response.json(usage);
      };
      assert.equal((await fetchCursorUsage(path)).windows.length, 2);
      await writeFile(
        join(dir, "security"),
        `#!/bin/sh\nsleep 11\nprintf '%s\\n' '${password}'\n`,
        { mode: 0o700 },
      );
      assert.equal((await fetchCursorUsage(path)).windows.length, 2);
      await writeFile(
        join(dir, "security"),
        `#!/bin/sh\necho attempt >> '${dir}/attempts'\nexit 1\n`,
        { mode: 0o700 },
      );
      await assert.rejects(fetchCursorUsage(path), /Keychain access unavailable/);
      await assert.rejects(fetchCursorUsage(path), /Keychain access unavailable/);
      assert.equal(await readFile(join(dir, "attempts"), "utf8"), "attempt\n");
      retryCursorKeychain();
      await assert.rejects(fetchCursorUsage(path), /Keychain access unavailable/);
      assert.equal(await readFile(join(dir, "attempts"), "utf8"), "attempt\nattempt\n");
      assert.deepEqual(await readFile(path), before);
    } finally {
      process.env.PATH = oldPath;
      retryCursorKeychain();
      globalThis.fetch = previousFetch;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("Cursor quota rejects missing data and keeps independent model percentages", () => {
  for (const value of [
    null,
    {},
    { individualUsage: { plan: { used: 2000, limit: 2000 } } },
    { individualUsage: { plan: { enabled: false, apiPercentUsed: 26 } } },
  ]) {
    assert.throws(() => parseCursorUsage(value), /Cursor usage response/);
  }
  assert.deepEqual(
    parseCursorUsage({
      individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 105 } },
    }).windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "Cursor", usedPercent: 0 },
      { label: "Other", usedPercent: 100 },
    ],
  );
});
