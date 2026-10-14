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
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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
  SG_HEALTH_API_KEY: KEY, SG_DIRECT_PROBE: "false",
});
const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "sg-fixtures-")), "bot.db"));
db.setSetting("SG_ALERT_CHANNEL_ID", "alerts");
db.setSetting("STATUS_CHANNEL_ID", "board");
const { siteguard, sgSiteLabel, sgCheckUrl, sgSslDays } = await import("../src/services/siteguard.js");
const { startSgAlerts, stopSgAlerts, runReminders } = await import("../src/services/sgAlerts.js");
const { handleSgStatusCommand, handleSgMonitorsCommand } = await import("../src/commands/sg-status.js");
const { updateStatusBoard } = await import("../src/services/statusBoard.js");

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
const report: Record<string, unknown> = {};
const log = (name: string, r: { sent: Sent[]; events: string[]; reqs?: unknown[] }) => {
  report[name] = { events: r.events, mentions: mentions(r.sent), discord: text(r.sent) };
};
const fakeInteraction = (replies: any[]) => ({
  options: { getString: () => null },
  reply: async (m: any) => { replies.push({ content: m.content, embeds: (m.embeds ?? []).map((e: any) => e.toJSON()) }); },
  deferReply: async () => undefined, editReply: async () => undefined, client,
});
const renderViews = async () => {
  const replies: any[] = [];
  await handleSgStatusCommand(fakeInteraction(replies) as any);
  await handleSgMonitorsCommand(fakeInteraction(replies) as any);
  db.setSetting("STATUS_MESSAGE_ID", "");
  const m = mark();
  await updateStatusBoard(client);
  await settle();
  const board = sent.slice(m.s).filter((x) => x.channel === "board");
  sent.splice(m.s); // board messages are not alerts
  return { replies, board };
};

// =============================================================================
test("single: all operational -> no alert, parsed, views render", async () => {
  const r = await pollWith(fresh("s-health-ok"));
  log("s-health-ok", r);
  assert.deepEqual(r.events, ["updated"]);
  assert.equal(r.sent.length, 0);
  assert.equal(r.reqs[0].auth, `Bearer ${KEY}`);
  assert.equal(r.reqs[0].method, "GET");
  assert.equal(siteguard.reachable, true);
  assert.deepEqual(siteguard.getSummary(), { total: 1, operational: 1, degraded: 0, down: 0 });
  const v = await renderViews();
  assert.match(v.replies[0].embeds[0].title, /OPERATIONAL/);
  assert.match(v.replies[0].embeds[0].footer.text, /SiteGuard v1\.5\.3/);
  assert.match(v.board[0].embeds[0].description, /WordPress Health \(1\/1\)/);
});

test("single: site down (real 503) -> one DOWN alert with @everyone, no storm on repeat polls", async () => {
  const r = await pollWith(fresh("s-health-down"));
  log("s-health-down", r);
  assert.deepEqual(r.events, ["siteDown", "updated"]);
  const t = text(r.sent);
  assert.match(t, /sgt-kp-s\.test is DOWN/);
  assert.match(t, /HTTP 503/);
  assert.match(t, /Consecutive Failures:\*\* 2/);
  // Exactly one ping per incident, even with no SMTP (the "no ticket"
  // follow-up is posted without @everyone).
  assert.equal(mentions(r.sent), 1);
  assert.match(t, /No SMTP configured/);
  const r2 = await pollWith(fresh("s-health-down"));
  const r3 = await pollWith(fresh("s-check-down"));
  assert.equal(r2.sent.length + r3.sent.length, 0, "no repeat alert on unchanged state");
  await renderViews();
});

test("single: reminder after SG_ALERT_REPEAT_MIN (default 30) - exactly one, then quiet", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const m = mark();
    await runReminders(client);
    assert.equal(since(m).sent.length, 0, "no reminder before the repeat window");
    mock.timers.setTime(Date.now() + 31 * 60_000);
    await runReminders(client); await settle();
    const first = since(m);
    log("reminder-31min", first);
    assert.equal(first.sent.filter((x) => /STILL DOWN/.test(x.embeds[0]?.title ?? "")).length, 1);
    const m2 = mark();
    await runReminders(client); await settle();
    assert.equal(since(m2).sent.length, 0, "no second reminder within the repeat window");
  } finally {
    mock.timers.reset();
  }
});

test("single: recovery -> one UP alert, no @everyone", async () => {
  const r = await pollWith(fresh("s-health-recovered"));
  log("s-health-recovered", r);
  assert.deepEqual(r.events, ["siteRecovery", "updated"]);
  assert.match(text(r.sent), /back UP/);
  assert.equal(mentions(r.sent), 0);
});

for (const [name, kind, title, reason] of [
  ["s-wrongkey-403", "auth", /API KEY/, /HTTP 403 forbidden: Invalid API key/],
  ["s-nobearer-401", "auth", /API KEY/, /HTTP 401 unauthorized/],
  ["s-ratelimited-429", "rate_limited", /RATE-LIMITING/, /HTTP 429 rate_limited: Too many failed attempts/],
  ["s-disabled-404", "disabled", /HEALTH MONITOR DISABLED/, /HTTP 404 disabled: Health monitor is not enabled/],
] as const) {
  test(`config error ${name}: one non-paging notice with the reason, one recovery, no ticket`, async () => {
    const r = await pollWith(answer(name));
    const again = await pollWith(answer(name));
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let reminder;
    try {
      mock.timers.setTime(Date.now() + 120 * 60_000);
      const m = mark(); await runReminders(client); await settle(); reminder = since(m);
    } finally { mock.timers.reset(); }
    const back = await pollWith(fresh("s-health-ok"));
    log(name, { ...r, sent: [...r.sent, ...again.sent] });
    log(name + "-then-ok", back);
    assert.deepEqual(r.events, ["unreachable"]);
    assert.equal(r.full[0].args[1], kind);
    assert.equal(r.sent.length, 1, "exactly one notice");
    assert.equal(mentions(r.sent), 0, "configuration problems do not page");
    assert.match(text(r.sent), title);
    assert.match(text(r.sent), reason);
    assert.doesNotMatch(text(r.sent), /WORDPRESS UNREACHABLE|Ticket/);
    assert.equal(again.sent.length, 0, "no alert storm on the 2nd failing poll");
    assert.equal(reminder.sent.length, 0, "no reminders for configuration problems");
    assert.deepEqual(back.events, ["reachable", "updated"]);
    assert.equal(back.sent.length, 1);
    assert.equal(mentions(back.sent), 0);
    assert.match(text(back.sent), /Health Data Available Again/);
  });
}

test("auth problem that turns into a real outage is escalated (paged)", async () => {
  const r = await pollWith(answer("s-wrongkey-403"));
  assert.equal(mentions(r.sent), 0);
  const r2 = await pollWith({ status: 502, body: null, raw: "<html>Bad gateway</html>", ct: "text/html" });
  log("auth-then-502", r2);
  assert.deepEqual(r2.events, ["unreachable"]);
  assert.match(text(r2.sent), /WORDPRESS UNREACHABLE/);
  assert.equal(mentions(r2.sent), 1);
  const r3 = await pollWith(answer("s-wrongkey-403"));
  assert.equal(r3.sent.length, 0, "no de-escalation notice");
  const back = await pollWith(fresh("s-health-ok"));
  assert.match(text(back.sent), /WordPress Connection Restored/);
});

test("non-JSON 200 (e.g. HTML error page) and 5xx HTML -> unreachable (paged), no crash", async () => {
  const r = await pollWith({ status: 200, body: null, raw: "<!DOCTYPE html><html><body>There has been a critical error on this website.</body></html>", ct: "text/html" });
  log("non-json-200", r);
  assert.deepEqual(r.events, ["unreachable"]);
  assert.equal(r.full[0].args[1], "bad_payload");
  assert.match(text(r.sent), /not JSON \(text\/html\)/);
  assert.equal(mentions(r.sent), 1);
  const r2 = await pollWith({ status: 502, body: null, raw: "<html>Bad gateway</html>", ct: "text/html" });
  assert.equal(r2.sent.length, 0);
  await pollWith(fresh("s-health-ok"));
});

test("timeout (endpoint hangs > 15 s) -> unreachable", { timeout: 40_000 }, async () => {
  const r = await pollWith({ status: 200, body: null, hang: true });
  log("timeout", r);
  assert.deepEqual(r.events, ["unreachable"]);
  assert.match(text(r.sent), /Timeout after 15s/);
  await pollWith(fresh("s-health-ok"));
});

test("SSL mix: expiring alerts only on fresh data, probe failures reported once", async () => {
  const r = await pollWith(fresh("s-health-ssl-mixed"));
  log("s-health-ssl-mixed", r);
  const of = (ev: string) => r.full.filter((e) => e.ev === ev).map((e) => e.args[0].domain);
  assert.deepEqual(of("siteDown"), ["expired.example.test"]);
  // sslfail.example.test (9 days, ssl_stale: carried forward) must NOT alert.
  assert.deepEqual(of("sslExpiring"), ["expiring.example.test"]);
  // skipped.example.test is status "unknown": its probe "failure" is only the time budget.
  assert.deepEqual(of("sslProbeFailed"), ["sslfail.example.test"]);
  assert.match(text(r.sent), /SSL Check Failing - sslfail\.example\.test/);
  assert.match(text(r.sent), /SSL Certificate Expiring - expiring\.example\.test/);
  assert.ok(!siteguard.getSslExpiring().some((s) => s.domain === "sslfail.example.test"));
  const again = await pollWith(fresh("s-health-ssl-mixed"));
  assert.equal(again.sent.length, 0, "SSL notices are sent once");
  await renderViews();
});

test("a DOWN site that the next run skips (status unknown) is not announced as recovered", async () => {
  const r = await pollWith(fresh("s-health-ssl-mixed", (b) => {
    const s = b.sites.find((x: any) => x.site_id === 13);
    Object.assign(s, { status: "unknown", http_code: 0, last_check: 0, error: "Skipped: time budget exceeded", check_method: "skipped" });
  }));
  log("down-then-unknown", r);
  assert.ok(!r.events.includes("siteRecovery"));
  assert.ok(siteguard.getDownSites().some((s) => s.site_id === 13), "still counted as down");
  const up = await pollWith(fresh("s-health-ssl-mixed", (b) => {
    Object.assign(b.sites.find((x: any) => x.site_id === 13), { status: "operational", error: "", ssl_expiry_days: 60 });
  }));
  assert.deepEqual(up.full.filter((e) => e.ev === "siteRecovery").map((e) => e.args[0].site_id), [13]);
});

test("SiteGuard 1.5.4 ssl_expires_at is preferred over ssl_expiry_days", () => {
  const now = 1_800_000_000;
  const site: any = { ssl_expiry_days: 80, ssl_expires_at: now + 3 * 86400 + 60 };
  assert.equal(sgSslDays(site, now), 3);
  assert.equal(sgSslDays({ ...site, ssl_expires_at: new Date((now + 10 * 86400) * 1000).toISOString() }, now), 10);
  assert.equal(sgSslDays({ ...site, ssl_expires_at: null }, now), 80);
  assert.equal(sgSslDays({ ssl_expiry_days: 80 } as any, now), 80);
});

test("stale data (checked_at 2 h old) -> stale alert + POST /health/check; 429 cooldown handled", async () => {
  postAnswer = answer("s-check-cooldown");
  const r = await pollWith(fresh("s-health-ok", (b) => { b.checked_at -= 7200; b.sites.forEach((s: any) => (s.last_check -= 7200)); }));
  await settle();
  const post = requests.filter((q) => q.method === "POST").at(-1);
  assert.ok(post, "a POST was sent");
  assert.equal(post!.url, "/wp-json/sgbackup/v1/health/check");
  assert.equal(post!.auth, `Bearer ${KEY}`);
  assert.ok(r.events.includes("dataStale"));
  const back = await pollWith(fresh("s-health-ok"));
  assert.ok(back.events.includes("dataFresh"));
});

test("force-check answer is applied like a poll (transitions detected); bad answers are not applied", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 10 * 60_000 }); // past the 5 min cooldown
  try {
    postAnswer = fresh("s-check-down");
    const m = mark();
    getAnswer = fresh("s-health-ok", (b) => { b.checked_at -= 7200; });
    await siteguard.poll(); await settle(); await settle();
    const r = since(m);
    assert.equal(r.reqs.filter((q) => q.method === "POST").length, 1);
    const downs = r.full.filter((e) => e.ev === "siteDown").map((e) => e.args[0].site_id);
    assert.deepEqual(downs, [1], "down from the POST answer is announced");

    mock.timers.setTime(Date.now() + 10 * 60_000);
    postAnswer = { status: 200, body: { code: "weird" } };
    const m2 = mark();
    await siteguard.poll(); await settle(); await settle();
    assert.equal(since(m2).reqs.filter((q) => q.method === "POST").length, 1);
    assert.ok(Array.isArray(siteguard.data?.sites), "POST answer without sites[] is not applied");
    assert.notEqual(siteguard.data, null);
  } finally {
    mock.timers.reset();
  }
  // The second (stale) GET already carried site 1 as operational again.
  await pollWith(fresh("s-health-ok"));
  assert.equal(siteguard.getDownSites().length, 0);
});

test("force-check URL for pretty and ?rest_route= style endpoints", () => {
  assert.equal(sgCheckUrl("https://x.test/wp-json/sgbackup/v1/health"), "https://x.test/wp-json/sgbackup/v1/health/check");
  assert.equal(sgCheckUrl("https://x.test/wp-json/sgbackup/v1/health/"), "https://x.test/wp-json/sgbackup/v1/health/check");
  const u = new URL(sgCheckUrl("https://x.test/?rest_route=/sgbackup/v1/health&x=1"));
  assert.equal(u.searchParams.get("rest_route"), "/sgbackup/v1/health/check");
  assert.equal(u.searchParams.get("x"), "1");
});

test("multisite: operational, sub1 down, sub2 https (real SSL probe failure); subsites labelled domain/path", async () => {
  await pollWith(fresh("m-health-ok"));
  const b = await pollWith(fresh("m-health-sub1-down"));
  log("m-health-sub1-down", b);
  assert.ok(b.events.includes("siteDown"));
  assert.equal(b.sent[0]?.embeds[0]?.title, "\u{1F534} sgt-kp-m.test/sub1 is DOWN");
  const c = await pollWith(fresh("m-health-sub2-https"));
  log("m-health-sub2-https", c);
  const v = await renderViews();
  const board = v.board[0].embeds[0].description as string;
  // Collapsed WordPress section: one line per origin, only problem sites listed.
  assert.match(board, /\*\*WordPress \(sgt-kp-m\.test\)\*\*/);
  assert.match(board, /\*\*sgt-kp-m\.test\/sub2\*\*/, "the failing subsite is named");
  assert.doesNotMatch(board, /\*\*sgt-kp-m\.test\*\* -/, "operational main site is not listed individually");
  assert.doesNotMatch(board, /\*\*sgt-kp-m\.test\/sub1\*\*/, "a recovered subsite is not listed individually");
  const d = await pollWith(fresh("m-health-ok"));
  assert.ok(d.events.includes("siteRecovery"));
});

test("site labels", () => {
  assert.equal(sgSiteLabel({ domain: "a.test", url: "https://a.test/" }), "a.test");
  assert.equal(sgSiteLabel({ domain: "a.test", url: "https://a.test/sub/x/" }), "a.test/sub/x");
  assert.equal(sgSiteLabel({ domain: null, url: "https://b.test/sub/" } as any), "b.test/sub");
  assert.equal(sgSiteLabel({ domain: null, url: null } as any), "?");
});

test("forward compatibility: extra/unknown fields and a null domain do not crash views or alerts", async () => {
  const r = await pollWith(fresh("m-health-ok", (b) => {
    b.key = { fp: "sgk-000000000000", source: "db" };
    b.kuma = { configured: true, last_push: { ok: true, code: 200, at: 1 } };
    b.api_version = 3;
    b.sites[0].new_field = { nested: [1, 2] };
  }));
  assert.deepEqual(r.events, ["updated"]);
  const r2 = await pollWith(fresh("m-health-ok", (b) => { b.sites[2].domain = null; b.sites[2].status = "down"; b.sites[2].error = "HTTP 500"; }));
  assert.ok(r2.events.includes("siteDown"));
  await renderViews(); // throws if a sort still calls null.localeCompare
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 60 * 60_000 });
  try { await runReminders(client); } finally { mock.timers.reset(); }
  await pollWith(fresh("m-health-ok"));
});

test("every Discord message sets allowedMentions; only @everyone pings may resolve mentions", () => {
  for (const m of sent) {
    assert.ok(m.allowedMentions, "allowedMentions set");
    if (m.content === "@everyone") assert.deepEqual(m.allowedMentions!.parse, ["everyone"]);
    else assert.deepEqual(m.allowedMentions!.parse, []);
  }
});

test("no secrets in any Discord output", () => {
  const all = JSON.stringify(sent);
  assert.ok(!all.includes(KEY), "API key leaked into Discord output");
  assert.ok(!/\$wp\$|\$2y\$|api\/push\//.test(all), "hash or push URL pattern in Discord output");
  if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
});

test.after(() => { stopSgAlerts(); siteguard.stop(); server.close(); });
