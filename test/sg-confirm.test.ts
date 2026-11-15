/**
 * SiteGuard integration test with REAL SiteGuard 1.5.3 responses.
 *
 * test/fixtures/siteguard/*.json were captured from disposable single-site
 * (sgt-kp-s) and multisite (sgt-kp-m) instances: {request, http_status,
 * content_type, body}. A local HTTP server replays them to the bot's actual
 * SiteGuard client (poll / force check), alert pipeline (sgAlerts), the
 * /sg-status + /sg-monitors commands and the status board, with a fake
 * Discord client that records every message.
 *
 * Run: npm test   (or: node --import tsx --test test/siteguard-fixtures.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIX = join(import.meta.dirname, "fixtures", "siteguard");
const KEY = "test-bot-key-SECRET-0123456789abcdef0123456789abcdef";
const fx = (name: string) => JSON.parse(readFileSync(join(FIX, name + ".json"), "utf8"));

// ---- fake SiteGuard endpoint -------------------------------------------------
type Answer = { status: number; body: unknown; raw?: string; ct?: string; hang?: boolean };
let getAnswer: Answer = { status: 200, body: {} };
let postAnswer: Answer = { status: 429, body: {} };
const requests: Array<{ method: string; url: string; auth: string | undefined }> = [];
const server = http.createServer((req, res) => {
  requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
  const a = req.method === "POST" ? postAnswer : getAnswer;
  if (a.hang) return; // never answers -> client timeout
  res.writeHead(a.status, { "content-type": a.ct ?? "application/json; charset=UTF-8" });
  res.end(a.raw ?? JSON.stringify(a.body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const answer = (name: string, patch?: (b: any) => void): Answer => {
  const f = fx(name);
  const body = structuredClone(f.body);
  if (patch) patch(body);
  return { status: f.http_status, body };
};
/** Real fixture with timestamps shifted to "now" so the bot does not treat it as stale. */
const fresh = (name: string, patch?: (b: any) => void) =>
  answer(name, (b) => {
    if (b && Array.isArray(b.sites)) {
      const now = Math.floor(Date.now() / 1000);
      const delta = now - (b.checked_at || now);
      b.checked_at = now;
      for (const s of b.sites) if (s.last_check) s.last_check += delta;
    }
    patch?.(b);
  });

// ---- env + db before importing bot modules ----------------------------------
Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  SG_HEALTH_URL: `http://127.0.0.1:${port}/wp-json/sgbackup/v1/health`,
  SG_HEALTH_API_KEY: KEY, SG_DIRECT_PROBE: "false", SG_SITE_DOWN_FAILS: "3",
});
const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "sg-confirm-")), "bot.db"));
db.setSetting("SG_ALERT_CHANNEL_ID", "alerts");
db.setSetting("STATUS_CHANNEL_ID", "board");
const { siteguard } = await import("../src/services/siteguard.js");
const { startSgAlerts, stopSgAlerts } = await import("../src/services/sgAlerts.js");

// ---- fake Discord ------------------------------------------------------------
type Sent = { channel: string; content?: string; embeds: any[]; allowedMentions?: { parse?: string[] } };
const sent: Sent[] = [];
const mkChannel = (id: string) => ({
  id, isTextBased: () => true,
  send: async (m: any) => {
    sent.push({ channel: id, content: m.content, allowedMentions: m.allowedMentions, embeds: (m.embeds ?? []).map((e: any) => e.toJSON?.() ?? e) });
    return { id: "m" + sent.length };
  },
  messages: { fetch: async () => { throw Object.assign(new Error("gone"), { status: 404 }); } },
});
const channels: Record<string, any> = { alerts: mkChannel("alerts"), board: mkChannel("board") };
const client: any = { channels: { fetch: async (id: string) => channels[id] ?? null } };
const events: Array<{ ev: string; args: any[] }> = [];
for (const ev of ["siteDown", "siteRecovery", "sslExpiring", "sslProbeFailed", "unreachable", "reachable", "dataStale", "dataFresh", "updated"]) {
  siteguard.on(ev, (...args: any[]) => events.push({ ev, args }));
}
startSgAlerts(client);
stopSgAlerts(); // no real 60 s reminder interval: reminders are driven by the test

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 50)); };
const mark = () => ({ s: sent.length, e: events.length, r: requests.length });
const since = (m: ReturnType<typeof mark>) => ({
  sent: sent.slice(m.s), events: events.slice(m.e).map((x) => x.ev), full: events.slice(m.e), reqs: requests.slice(m.r),
});
const pollWith = async (a: Answer) => { getAnswer = a; const m = mark(); await siteguard.poll(); await settle(); return since(m); };
const text = (s: Sent[]) => s.map((x) => [x.content ?? "", ...x.embeds.map((e) => `${e.title ?? ""}\n${e.description ?? ""}\n${e.footer?.text ?? ""}`)].join("\n")).join("\n---\n");
const mentions = (s: Sent[]) => s.filter((x) => x.content === "@everyone").length;
// =============================================================================
// A node's own SiteGuard self-checks raised tickets on ONE failed check ("cURL error 7 after 169 ms")
// while sites were up for visitors. A SiteGuard down report now needs SG_SITE_DOWN_FAILS consecutive failures (or the
// bot's own probe failing too) before it alerts.
test("confirm: a down report below the threshold is not announced", async () => {
  const r = await pollWith(fresh("s-health-down", (b) => { for (const s of b.sites) s.consecutive_failures = 1; }));
  assert.deepEqual(r.events, ["updated"]);
  assert.equal(r.sent.length, 0, "no alert on one failed self-check");
});

test("confirm: the threshold reached -> one DOWN alert", async () => {
  const r2 = await pollWith(fresh("s-health-down", (b) => { for (const s of b.sites) s.consecutive_failures = 2; }));
  assert.deepEqual(r2.events, ["updated"], "still below 3");
  const r3 = await pollWith(fresh("s-health-down", (b) => { for (const s of b.sites) s.consecutive_failures = 3; }));
  assert.deepEqual(r3.events, ["siteDown", "updated"]);
  assert.match(text(r3.sent), /is DOWN/);
  assert.equal(mentions(r3.sent), 1);
});

test("confirm: recovery after a confirmed outage is announced", async () => {
  const r = await pollWith(fresh("s-health-ok"));
  assert.deepEqual(r.events, ["siteRecovery", "updated"]);
});
test.after(() => { stopSgAlerts(); siteguard.stop(); server.close(); });
