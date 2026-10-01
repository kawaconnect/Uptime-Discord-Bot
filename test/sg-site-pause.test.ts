/**
 * Pausing alerts for one SiteGuard site (/sg-pause site, site-resume,
 * status): lookup and autocomplete over the multisite fixture, the admin
 * gate, alert suppression for the paused site only (down alert, reminders),
 * the persisted schedule across a database reopen, and auto-resume, which
 * posts the site's current state and the down alert the pause held back.
 *
 * SiteGuard is served from a local HTTP server built on the real multisite
 * fixture (m-health-ok.json), polled by the bot's actual client.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const KEY = "test-bot-key-SECRET-0123456789abcdef0123456789abcdef";
const base = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "siteguard", "m-health-ok.json"), "utf8")).body;

/** The fixture with fresh timestamps; `down` lists site ids to report as down. */
function payload(down: number[] = []) {
  const b = structuredClone(base);
  const now = Math.floor(Date.now() / 1000);
  b.checked_at = now;
  for (const s of b.sites) {
    s.last_check = now;
    if (down.includes(s.site_id)) Object.assign(s, { status: "down", http_code: 503, error: "HTTP 503", consecutive_failures: 2 });
  }
  return b;
}

let body: unknown = payload();
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
test.after(() => server.close());

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  SG_HEALTH_URL: `http://127.0.0.1:${port}/wp-json/sgbackup/v1/health`,
  SG_HEALTH_API_KEY: KEY, SG_DIRECT_PROBE: "false", ADMIN_USER_IDS: "111",
});
const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const dbPath = join(mkdtempSync(join(tmpdir(), "sg-site-pause-")), "bot.db");
const db = await import("../src/db/index.js");
db.initDb(dbPath);
db.setSetting("SG_ALERT_CHANNEL_ID", "alerts");
db.setSetting("STATUS_CHANNEL_ID", "board");

const { siteguard } = await import("../src/services/siteguard.js");
const sgAlerts = await import("../src/services/sgAlerts.js");
const SP = await import("../src/services/sgSitePauses.js");
const { handleSgPauseCommand, handleSgSiteAutocomplete, sgPauseCommand } = await import("../src/commands/sg-pause.js");
const { handleSgMonitorsCommand } = await import("../src/commands/sg-status.js");
const { ADMINS_ONLY } = await import("../src/util/admin.js");

// ---- fake Discord ------------------------------------------------------------
type Sent = { channel: string; content?: string; embeds: any[] };
const sent: Sent[] = [];
const mkChannel = (id: string) => ({
  id, isTextBased: () => true,
  send: async (m: any) => { sent.push({ channel: id, content: m.content, embeds: (m.embeds ?? []).map((e: any) => e.toJSON?.() ?? e) }); return { id: "m" }; },
});
const channels: Record<string, any> = { alerts: mkChannel("alerts"), board: mkChannel("board"), ops: mkChannel("ops") };
const client: any = { channels: { fetch: async (id: string) => channels[id] ?? null } };
sgAlerts.startSgAlerts(client);
sgAlerts.stopSgAlerts(); // the test drives reminders and auto-resume itself

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 50)); };
const poll = async (down: number[]) => { body = payload(down); const n = sent.length; await siteguard.poll(); await settle(); return sent.slice(n); };
const titles = (s: Sent[]) => s.flatMap((x) => x.embeds.map((e) => e.title ?? ""));

type Reply = { content?: string; ephemeral?: boolean; embeds?: any[] };
function cmd(userId: string, sub: string, strings: Record<string, string> = {}) {
  const replies: Reply[] = [];
  const i: any = {
    commandName: "sg-pause", client, channelId: "ops",
    user: { id: userId, tag: `u${userId}` },
    options: { getSubcommand: () => sub, getString: (n: string) => strings[n] ?? null },
    reply: async (m: any) => { replies.push({ ...m, embeds: (m.embeds ?? []).map((e: any) => e.toJSON?.() ?? e) }); },
  };
  return { i, replies };
}
const fields = (embed: any) => Object.fromEntries((embed.fields ?? []).map((f: any) => [f.name, f.value]));

// =============================================================================
test("first poll: three sites known, no alerts", async () => {
  const s = await poll([]);
  assert.equal(s.length, 0);
  assert.equal(siteguard.sites.length, 3);
  assert.equal(siteguard.knownSites.length, 3);
});

test("lookup: subdirectory subsites told apart by name or URL; ambiguous refused", () => {
  const sites = SP.mergeSgSites(siteguard.sites, siteguard.knownSites);
  const id = (v: string) => ("site" in SP.resolveSgSite(sites, v) ? (SP.resolveSgSite(sites, v) as any).site.site_id : null);
  assert.equal(id("2"), 2);
  assert.equal(id("sgt-kp-m.test"), 1, "exact name of the main site");
  assert.equal(id("sgt-kp-m.test/sub1"), 2);
  assert.equal(id("http://sgt-kp-m.test/sub2/"), 3);
  assert.equal(id("sub2"), 3);
  assert.match((SP.resolveSgSite(sites, "kp-m") as any).error, /matches 3 sites/);
  assert.match((SP.resolveSgSite(sites, "nope") as any).error, /not found/);
  assert.match((SP.resolveSgSite([], "x") as any).error, /No SiteGuard sites known yet/);

  const names = SP.sgSiteChoices(sites, "sub", "any", () => false).map((c) => c.name);
  assert.deepEqual(names, ["\u{1F7E2} sgt-kp-m.test/sub1", "\u{1F7E2} sgt-kp-m.test/sub2"]);
  assert.equal(SP.sgSiteChoices(sites, "", "any", () => false).length, 3);
  assert.deepEqual(SP.sgSiteChoices(sites, "SUB1", "any", () => false).map((c) => c.value), ["2"]);
  // pause offers unpaused sites, resume paused ones
  assert.deepEqual(SP.sgSiteChoices(sites, "", "resume", (x) => x === 3).map((c) => c.value), ["3"]);
  assert.ok(!SP.sgSiteChoices(sites, "", "pause", (x) => x === 3).some((c) => c.value === "3"));
});

test("command definition: site and site-resume subcommands with autocomplete; admin default", () => {
  const json = sgPauseCommand.toJSON() as any;
  const subs = Object.fromEntries(json.options.map((o: any) => [o.name, o]));
  assert.deepEqual(Object.keys(subs).sort(), ["off", "on", "site", "site-resume", "status"]);
  assert.deepEqual(subs.site.options.map((o: any) => [o.name, !!o.required, !!o.autocomplete]), [["site", true, true], ["duration", false, false], ["reason", false, false]]);
  assert.equal(subs["site-resume"].options[0].autocomplete, true);
  assert.ok(json.default_member_permissions);
});

test("errors are private: non-admin, unknown site, bad duration, not paused", async () => {
  const cases: Array<[string, string, Record<string, string>, RegExp]> = [
    ["999", "site", { site: "2", duration: "2h" }, new RegExp(ADMINS_ONLY)],
    ["999", "site-resume", { site: "2" }, new RegExp(ADMINS_ONLY)],
    ["111", "site", { site: "no-such-site" }, /not found/],
    ["111", "site", { site: "2", duration: "later" }, /Could not read the duration/],
    ["111", "site", { site: "2", duration: "40d" }, /longest pause/],
    ["111", "site-resume", { site: "2" }, /not paused/],
  ];
  for (const [user, sub, strings, re] of cases) {
    const { i, replies } = cmd(user, sub, strings);
    await handleSgPauseCommand(i);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content ?? "", re, `${sub} ${JSON.stringify(strings)}`);
    assert.equal(replies[0].ephemeral, true);
  }
  assert.equal(SP.listSitePauses().length, 0);
});

test("pause one site: public confirmation with who, until, reason and current state", async () => {
  const before = Date.now();
  const { i, replies } = cmd("111", "site", { site: "2", duration: "2h", reason: "theme update" });
  await handleSgPauseCommand(i);
  assert.equal(replies[0].ephemeral, undefined, "public");
  const e = replies[0].embeds![0];
  assert.match(e.title, /SiteGuard site paused: sgt-kp-m\.test\/sub1/);
  const f = fields(e);
  assert.equal(f.By, "<@111>");
  assert.match(f.Until, /<t:\d+:f>.*resumes automatically/);
  assert.equal(f.Reason, "theme update");
  assert.match(f["Current status"], /Operational/);
  const p = SP.getSitePause(2)!;
  assert.ok(p.resumeAt! >= before + 7_200_000 && p.resumeAt! <= Date.now() + 7_200_000);
  assert.equal(p.channelId, "ops");
  assert.equal(SP.isSgSitePaused(2), true);
  assert.equal(SP.isSgSitePaused(3), false);

  // again without options: refused; with a new reason: updated, end time kept
  let r = cmd("111", "site", { site: "sub1" });
  await handleSgPauseCommand(r.i);
  assert.match(r.replies[0].content!, /already paused/);
  r = cmd("111", "site", { site: "sub1", reason: "plugin update too" });
  await handleSgPauseCommand(r.i);
  assert.match(r.replies[0].embeds![0].title, /pause updated/);
  assert.equal(SP.getSitePause(2)!.resumeAt, p.resumeAt);
  assert.equal(SP.getSitePause(2)!.reason, "plugin update too");

  // autocomplete for site-resume offers the paused site
  const responses: any[] = [];
  await handleSgSiteAutocomplete({
    options: { getSubcommand: () => "site-resume", getFocused: () => "" },
    respond: async (x: any) => { responses.push(x); },
  } as any);
  assert.deepEqual(responses[0].map((c: any) => c.value), ["2"]);
  assert.match(responses[0][0].name, /^\u23F8 /);
});

test("paused site going down is not announced; another site still alerts", async () => {
  const s = await poll([2, 3]);
  const t = titles(s);
  assert.ok(t.some((x) => /sgt-kp-m\.test\/sub2 is DOWN/.test(x)), "unpaused site alerts");
  assert.ok(!t.some((x) => /sub1/.test(x)), "paused site does not");
  assert.equal(s.filter((x) => x.content === "@everyone").length, 1);
  assert.equal(siteguard.getDownSites().length, 2, "state still tracked for the paused site");
});

test("reminder lists only unpaused sites; views mark the paused one", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.setTime(Date.now() + 31 * 60_000);
    const n = sent.length;
    await sgAlerts.runReminders(client); await settle();
    const r = sent.slice(n);
    assert.equal(r.length, 1);
    assert.match(r[0].embeds[0].title, /1 SITE STILL DOWN/);
    assert.match(r[0].embeds[0].description, /sub2/);
    assert.doesNotMatch(r[0].embeds[0].description, /sub1/);
  } finally {
    mock.timers.reset();
  }

  const { i, replies } = cmd("111", "status");
  await handleSgPauseCommand(i);
  const f = fields(replies[0].embeds![0]);
  assert.match(f["Paused sites (1)"], /sgt-kp-m\.test\/sub1\*\* - until <t:\d+:f>.* by <@111> \u00B7 plugin update too/);

  const mon: Reply[] = [];
  await handleSgMonitorsCommand({ options: { getString: () => null }, reply: async (m: any) => { mon.push({ embeds: m.embeds.map((e: any) => e.toJSON()) }); } } as any);
  assert.match(mon[0].embeds![0].description, /sub1\*\* .*alerts paused/);
});

test("pause survives a restart (database reopened)", () => {
  db.closeDb();
  db.initDb(dbPath);
  assert.equal(SP.isSgSitePaused(2), true);
  assert.equal(SP.getSitePause(2)!.reason, "plugin update too");
});

test("auto-resume: notice in the pause channel with the current state, then the held-back down alert", async () => {
  const p = SP.getSitePause(2)!;
  assert.equal(await sgAlerts.runSgSiteAutoResume(client, p.resumeAt! - 1), 0, "not due yet");
  const n = sent.length;
  assert.equal(await sgAlerts.runSgSiteAutoResume(client, p.resumeAt!), 1);
  await settle();
  const s = sent.slice(n);
  assert.equal(s[0].channel, "ops");
  assert.match(s[0].embeds[0].title, /SiteGuard site auto-resumed: sgt-kp-m\.test\/sub1/);
  assert.match(fields(s[0].embeds[0])["Current status"], /DOWN/);
  const alert = s.find((x) => /sub1 is DOWN/.test(x.embeds[0]?.title ?? ""));
  assert.ok(alert, "down alert sent now");
  assert.equal(alert!.channel, "alerts");
  assert.equal(alert!.content, "@everyone");
  assert.equal(SP.getSitePause(2), null);
  assert.equal(await sgAlerts.runSgSiteAutoResume(client, p.resumeAt! + 60_000), 0, "only once");
});

test("site already alerted, paused, recovers silently; manual resume shows it is up, no alert", async () => {
  let r = cmd("111", "site", { site: "sub2" }); // open-ended
  await handleSgPauseCommand(r.i);
  assert.match(fields(r.replies[0].embeds![0]).Until, /site-resume/);
  assert.match(fields(r.replies[0].embeds![0])["Current status"], /DOWN/);

  const s = await poll([2]); // sub2 recovers while paused; sub1 still down (already announced)
  assert.ok(!titles(s).some((x) => /sub2/.test(x)), "recovery of a paused site not announced");

  const n = sent.length;
  r = cmd("111", "site-resume", { site: "sgt-kp-m.test/sub2" });
  await handleSgPauseCommand(r.i);
  await settle();
  const e = r.replies[0].embeds![0];
  assert.match(e.title, /SiteGuard site resumed: sgt-kp-m\.test\/sub2/);
  assert.equal(fields(e).By, "<@111>");
  assert.match(fields(e)["Current status"], /Operational/);
  assert.equal(sent.length, n, "no alert for a site that is up");
  assert.equal(SP.getSitePause(3), null);
});

test("an expired pause no longer silences, even before the sweep removes it", () => {
  SP.saveSitePause({
    siteId: 1, siteLabel: "sgt-kp-m.test", siteUrl: "http://sgt-kp-m.test/", pausedBy: "u", pausedById: "111",
    reason: null, pausedAt: 0, resumeAt: 1_000, channelId: null,
  });
  assert.equal(SP.isSgSitePaused(1, 999), true);
  assert.equal(SP.isSgSitePaused(1, 1_000), false);
  assert.match(SP.sgSitePauseLines(SP.listSitePauses(), 5_000)[0], /ending now/);
  SP.deleteSitePause(1);
});
