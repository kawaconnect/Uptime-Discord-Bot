/**
 * Security regressions: admin gating, URL checks, HTML escaping, mention
 * presets, secret-setting encryption, debug endpoint auth and the Kuma
 * Authorization header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { PermissionFlagsBits } from "discord.js";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  ADMIN_USER_IDS: "",
});
delete process.env.SETTINGS_ENCRYPTION_KEY;
delete process.env.DEBUG_TOKEN;

const { loadEnv, resetEnvForTests } = await import("../src/util/env.js");
const withAdmins = (ids: string) => { process.env.ADMIN_USER_IDS = ids; resetEnvForTests(); loadEnv(); };
withAdmins("");

const dbPath = join(mkdtempSync(join(tmpdir(), "bot-sec-")), "bot.db");
const db = await import("../src/db/index.js");
db.initDb(dbPath);

const { isAdmin, ADMINS_ONLY } = await import("../src/util/admin.js");
const { checkSecureUrl } = await import("../src/util/url.js");
const { escapeHtml } = await import("../src/util/html.js");
const { mentionsFor } = await import("../src/util/mentions.js");
const secrets = await import("../src/db/secrets.js");
const { buildWebServer } = await import("../src/web/server.js");
const { kumaSocketOptions, kuma } = await import("../src/services/kuma.js");
const status = await import("../src/commands/status.js");
const { handleSgSetupCommand } = await import("../src/commands/sg-setup.js");

type Reply = { content?: string; ephemeral?: boolean };
function fakeInteraction(userId: string, opts: { sub?: string; strings?: Record<string, string> } = {}) {
  const replies: Reply[] = [];
  const i: any = {
    user: { id: userId, tag: `u${userId}` },
    deferred: false, replied: false,
    options: {
      getSubcommand: () => opts.sub ?? "",
      getString: (n: string) => opts.strings?.[n] ?? null,
    },
    reply: async (m: any) => { i.replied = true; replies.push(typeof m === "string" ? { content: m } : m); },
    deferReply: async () => { i.deferred = true; },
    editReply: async (m: any) => { replies.push(typeof m === "string" ? { content: m } : m); },
  };
  return { i, replies };
}

// ---------------------------------------------------------------------------
test("isAdmin denies everyone when ADMIN_USER_IDS is empty", () => {
  withAdmins("");
  assert.equal(isAdmin("123"), false);
  withAdmins("111, 222");
  assert.equal(isAdmin("111"), true);
  assert.equal(isAdmin("222"), true);
  assert.equal(isAdmin("333"), false);
});

test("/pause and /resume: Manage Server by default and ADMIN_USER_IDS enforced", async () => {
  const want = String(PermissionFlagsBits.ManageGuild);
  assert.equal(status.pauseCommand.toJSON().default_member_permissions, want);
  assert.equal(status.resumeCommand.toJSON().default_member_permissions, want);

  withAdmins("111");
  let paused = 0;
  const orig = kuma.pauseMonitor.bind(kuma);
  (kuma as any).pauseMonitor = async () => { paused++; return { ok: true }; };
  (kuma as any).resumeMonitor = async () => { paused++; return { ok: true }; };
  try {
    for (const handler of [status.handlePauseCommand, status.handleResumeCommand]) {
      const { i, replies } = fakeInteraction("999", { strings: { name: "1" } });
      await handler(i);
      assert.deepEqual(replies, [{ content: ADMINS_ONLY, ephemeral: true }]);
    }
    withAdmins("");
    const { i, replies } = fakeInteraction("111", { strings: { name: "1" } });
    await status.handlePauseCommand(i);
    assert.equal(replies[0].content, ADMINS_ONLY, "empty list denies");
    assert.equal(paused, 0);
  } finally {
    (kuma as any).pauseMonitor = orig;
  }
});

test("/sg-setup: empty admin list denies; connect requires https", async () => {
  withAdmins("");
  let r = fakeInteraction("111", { sub: "show" });
  await handleSgSetupCommand(r.i);
  assert.equal(r.replies[0].content, ADMINS_ONLY);

  withAdmins("111");
  r = fakeInteraction("111", { sub: "connect", strings: { url: "http://example.com/wp-json/sgbackup/v1/health", api_key: "k" } });
  await handleSgSetupCommand(r.i);
  assert.match(r.replies[0].content ?? "", /https/);
  assert.equal(db.getSetting("SG_HEALTH_URL"), undefined, "nothing saved");

  r = fakeInteraction("111", { sub: "tickets", strings: { url: "http://help.example.com", token: "t" } });
  await handleSgSetupCommand(r.i);
  assert.match(r.replies[0].content ?? "", /https/);
  assert.equal(db.getSetting("ZAMMAD_API_TOKEN"), undefined, "nothing saved");
});

test("checkSecureUrl", () => {
  assert.equal(checkSecureUrl("https://example.com/x").ok, true);
  assert.equal(checkSecureUrl("http://example.com/x").ok, false);
  assert.equal(checkSecureUrl("ftp://example.com/x").ok, false);
  assert.equal(checkSecureUrl("not a url").ok, false);
  assert.equal(checkSecureUrl("http://localhost:8080/x").ok, true);
  assert.equal(checkSecureUrl("http://127.0.0.1/x").ok, true);
  assert.equal(checkSecureUrl("http://sgt-kp-s.test/x").ok, true);
  assert.equal(checkSecureUrl("http://zammad.default.svc.cluster.local").ok, false);
  assert.equal(checkSecureUrl("http://zammad.default.svc.cluster.local", { allowClusterHttp: true }).ok, true);
  assert.equal(checkSecureUrl("http://evil.example/?x=.svc", { allowClusterHttp: true }).ok, false);
});

test("escapeHtml and mention presets", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
  assert.deepEqual(mentionsFor("@everyone"), { parse: ["everyone"] });
  assert.deepEqual(mentionsFor(""), { parse: [] });
  assert.deepEqual(mentionsFor(undefined), { parse: [] });
  assert.deepEqual(mentionsFor("<@&123> @here"), { parse: [] });
});

test("secret settings: plaintext without a key, encrypted with one, migrated on read", () => {
  const raw = new Database(dbPath);
  const rawGet = (k: string) => (raw.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  try {
    secrets.configureSettingsKey(undefined);
    db.setSetting("SG_HEALTH_API_KEY", "old-plain-key");
    assert.equal(rawGet("SG_HEALTH_API_KEY"), "old-plain-key", "no key: stored as before");
    db.setSetting("SG_ALERT_CHANNEL_ID", "chan");

    secrets.configureSettingsKey("test-encryption-key");
    assert.equal(db.getSetting("SG_HEALTH_API_KEY"), "old-plain-key", "legacy plaintext still readable");
    assert.match(rawGet("SG_HEALTH_API_KEY")!, /^enc:v1:/, "migrated on read");
    assert.equal(db.getSetting("SG_HEALTH_API_KEY"), "old-plain-key");

    db.setSetting("ZAMMAD_API_TOKEN", "zammad-token");
    assert.match(rawGet("ZAMMAD_API_TOKEN")!, /^enc:v1:/);
    assert.ok(!rawGet("ZAMMAD_API_TOKEN")!.includes("zammad-token"));
    assert.equal(db.getSetting("ZAMMAD_API_TOKEN"), "zammad-token");
    assert.equal(rawGet("SG_ALERT_CHANNEL_ID"), "chan", "non-secret settings untouched");

    secrets.configureSettingsKey("another-key");
    assert.equal(db.getSetting("ZAMMAD_API_TOKEN"), undefined, "wrong key: treated as unset");
    secrets.configureSettingsKey(undefined);
    assert.equal(db.getSetting("ZAMMAD_API_TOKEN"), undefined, "no key: encrypted value treated as unset");
    secrets.configureSettingsKey("test-encryption-key");
    assert.equal(db.getSetting("ZAMMAD_API_TOKEN"), "zammad-token");
  } finally {
    raw.close();
    db.deleteSetting("SG_HEALTH_API_KEY");
    db.deleteSetting("ZAMMAD_API_TOKEN");
    secrets.configureSettingsKey(undefined);
  }
});

test("debug endpoints: absent without DEBUG_TOKEN, bearer-protected with it; probes open", async () => {
  const closed = buildWebServer(undefined);
  assert.equal((await closed.inject({ url: "/healthz" })).statusCode, 200);
  assert.equal((await closed.inject({ url: "/readyz" })).statusCode, 503); // Kuma not connected, but reachable
  for (const p of ["/debug/status", "/debug/siteguard", "/debug/smtp"]) {
    assert.equal((await closed.inject({ url: p })).statusCode, 404, p);
  }
  await closed.close();

  const open = buildWebServer("s3cret-token");
  assert.equal((await open.inject({ url: "/healthz" })).statusCode, 200);
  for (const p of ["/debug/status", "/debug/siteguard", "/debug/smtp"]) {
    assert.equal((await open.inject({ url: p })).statusCode, 401, p);
    assert.equal((await open.inject({ url: p, headers: { authorization: "Bearer wrong" } })).statusCode, 401, p);
    assert.equal((await open.inject({ url: p, headers: { authorization: "s3cret-token" } })).statusCode, 401, p);
    assert.equal((await open.inject({ url: p, headers: { authorization: "Bearer s3cret-token" } })).statusCode, 200, p);
  }
  await open.close();
});

test("Kuma: KUMA_AUTH_HEADER is sent on the websocket upgrade (and on polling if forced)", async () => {
  assert.equal(kumaSocketOptions(undefined).extraHeaders, undefined);
  assert.equal(kumaSocketOptions("  ").extraHeaders, undefined);
  assert.deepEqual(kumaSocketOptions("Bearer abc").extraHeaders, { Authorization: "Bearer abc" });
  assert.deepEqual(kumaSocketOptions("Bearer abc").transports, ["websocket"], "websocket only through Authentik");
  assert.deepEqual(kumaSocketOptions(undefined).transports, ["websocket", "polling"], "unchanged without a header");

  const { io } = await import("socket.io-client");
  const seen: Array<{ kind: string; auth: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ kind: "polling", auth: req.headers.authorization });
    res.writeHead(403); res.end();
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ kind: "websocket", auth: req.headers.authorization });
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const waitFor = async (kind: string) => {
    for (let n = 0; n < 100 && !seen.some((s) => s.kind === kind); n++) await new Promise((r) => setTimeout(r, 20));
  };
  try {
    const opts = { ...kumaSocketOptions("Basic a3VtYTp0ZXN0"), reconnection: false };
    const ws = io(url, opts);
    await waitFor("websocket");
    ws.close();
    const poll = io(url, { ...opts, transports: ["polling"] });
    await waitFor("polling");
    poll.close();
  } finally {
    server.close();
  }
  assert.equal(seen.find((s) => s.kind === "websocket")?.auth, "Basic a3VtYTp0ZXN0");
  assert.equal(seen.find((s) => s.kind === "polling")?.auth, "Basic a3VtYTp0ZXN0");
});
