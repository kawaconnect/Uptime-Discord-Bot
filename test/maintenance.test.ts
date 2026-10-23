/**
 * Global maintenance window (/maintenance start|end|status): the command
 * definition and admin gate, the start notice, suppression of every alert
 * path (Kuma down/recovery alerts, SiteGuard site alerts, phone calls to the
 * PBX, WordPress node notices), the window and its counter surviving a
 * database reopen (as after a restart), expiry with the summary and normal
 * alerts for what is still down, a manual end, and status.
 *
 * Kuma events are emitted on the real client singleton; SiteGuard is served
 * from a local HTTP server built on the multisite fixture, and the PBX is a
 * local HTTP server that records what the bot asks of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const KEY = "test-bot-key-SECRET-0123456789abcdef0123456789abcdef";
const base = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "siteguard", "m-health-ok.json"), "utf8")).body;

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

// ---- SiteGuard + PBX stand-ins -----------------------------------------------
let sgBody: unknown = payload();
const pbxCalls: Array<{ path: string; key: string }> = [];
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/pbx/")) {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      pbxCalls.push({ path: req.url!.slice(4), key: JSON.parse(data || "{}").key });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ called: false, reason: "too_soon" }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(sgBody));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
test.after(() => server.close());

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  SG_HEALTH_URL: `http://127.0.0.1:${port}/wp-json/sgbackup/v1/health`,
  SG_HEALTH_API_KEY: KEY, SG_DIRECT_PROBE: "false", ADMIN_USER_IDS: "111",
  PHONE_ESCALATION_ENABLED: "true", PBX_ALERT_URL: `http://127.0.0.1:${port}/pbx`, PBX_ALERT_TOKEN: "pbx-token",
});
delete process.env.SETTINGS_ENCRYPTION_KEY;
const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const dbPath = join(mkdtempSync(join(tmpdir(), "maintenance-")), "bot.db");
const db = await import("../src/db/index.js");
db.initDb(dbPath);
db.setSetting("ALERT_CHANNEL_ID", "alerts");
db.setSetting("SG_ALERT_CHANNEL_ID", "alerts");

const { kuma, MonitorStatus } = await import("../src/services/kuma.js");
const { siteguard } = await import("../src/services/siteguard.js");
const alerts = await import("../src/services/alerts.js");
const sgAlerts = await import("../src/services/sgAlerts.js");
const phone = await import("../src/services/phone.js");
const M = await import("../src/services/maintenance.js");
const run = await import("../src/services/maintenanceRun.js");
const { handleMaintenanceCommand, maintenanceCommand } = await import("../src/commands/maintenance.js");
const { ADMINS_ONLY } = await import("../src/util/admin.js");
type KumaMonitor = import("../src/services/kuma.js").KumaMonitor;

// ---- fake Discord + Kuma -----------------------------------------------------
type Sent = { channel: string; content?: string; embeds: any[] };
const sent: Sent[] = [];
const mkChannel = (id: string) => ({
  id, isTextBased: () => true,
  send: async (m: any) => { sent.push({ channel: id, content: m.content, embeds: (m.embeds ?? []).map((e: any) => e.toJSON?.() ?? e) }); return { id: "m" }; },
});
const channels: Record<string, any> = { alerts: mkChannel("alerts"), ops: mkChannel("ops") };
const client: any = { channels: { fetch: async (id: string) => channels[id] ?? null } };

let kumaConnected = true;
Object.defineProperty(kuma, "connected", { get: () => kumaConnected, configurable: true });
function mon(id: number, name: string): KumaMonitor {
  return { id, name, type: "ping", url: "", hostname: `${name}.lan`, port: null, active: true, interval: 60, description: "", tags: [], parent: null, maintenance: false, maxretries: 0 };
}
for (const m of [mon(1, "pve1"), mon(2, "pve2"), mon(3, "opnsense")]) {
  kuma.monitors.set(m.id, m);
  kuma.latestStatus.set(m.id, MonitorStatus.UP);
}
function kumaBeat(id: number, status: number) {
  const prev = kuma.latestStatus.get(id);
  kuma.latestStatus.set(id, status);
  kuma.emit("statusChange", kuma.monitors.get(id), { monitorID: id, status, time: new Date().toISOString(), msg: status === MonitorStatus.DOWN ? "timeout" : "OK", ping: null, important: true }, prev);
}

alerts.startAlerts(client);
alerts.stopAlerts(); // the escalation sweep is driven by hand
sgAlerts.startSgAlerts(client);
sgAlerts.stopSgAlerts();

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 50)); };
const since = async (fn: () => unknown) => { const n = sent.length; await fn(); await settle(); return sent.slice(n); };
const poll = (down: number[]) => since(async () => { sgBody = payload(down); await siteguard.poll(); });
const titles = (s: Sent[]) => s.flatMap((x) => x.embeds.map((e) => e.title ?? ""));
const fields = (embed: any) => Object.fromEntries((embed.fields ?? []).map((f: any) => [f.name, f.value]));

type Reply = { content?: string; ephemeral?: boolean; embeds?: any[] };
function cmd(userId: string, sub: string, strings: Record<string, string> = {}) {
  const replies: Reply[] = [];
  const i: any = {
    commandName: "maintenance", client, channelId: "ops",
    user: { id: userId, tag: `u${userId}` },
    options: {
      getSubcommand: () => sub,
      getString: (n: string, req?: boolean) => {
        const v = strings[n] ?? null;
        if (req && v === null) throw new Error(`missing ${n}`);
        return v;
      },
    },
    reply: async (m: any) => { replies.push({ ...m, embeds: (m.embeds ?? []).map((e: any) => e.toJSON?.() ?? e) }); },
  };
  return { i, replies };
}
async function runCmd(userId: string, sub: string, strings: Record<string, string> = {}) {
  const c = cmd(userId, sub, strings);
  const s = await since(() => handleMaintenanceCommand(c.i));
  return { replies: c.replies, sent: s };
}

// =============================================================================
test("command definition: start (duration required, reason), end, status; admin default", () => {
  const json = maintenanceCommand.toJSON() as any;
  assert.equal(json.name, "maintenance");
  const subs = Object.fromEntries(json.options.map((o: any) => [o.name, o]));
  assert.deepEqual(Object.keys(subs).sort(), ["end", "start", "status"]);
  assert.deepEqual(subs.start.options.map((o: any) => [o.name, !!o.required]), [["duration", true], ["reason", false]]);
  assert.ok(json.default_member_permissions);
});

test("errors are private: non-admin, bad or too long duration, end with nothing open", async () => {
  const cases: Array<[string, string, Record<string, string>, RegExp]> = [
    ["999", "start", { duration: "2h" }, new RegExp(ADMINS_ONLY)],
    ["999", "end", {}, new RegExp(ADMINS_ONLY)],
    ["111", "start", { duration: "soon" }, /Could not read the duration/],
    ["111", "start", { duration: "8d" }, /longest maintenance window is 7d/],
    ["111", "end", {}, /No maintenance window is active/],
  ];
  for (const [user, sub, strings, re] of cases) {
    const { replies, sent: s } = await runCmd(user, sub, strings);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content ?? "", re, `${sub} ${JSON.stringify(strings)}`);
    assert.equal(replies[0].ephemeral, true);
    assert.equal(s.length, 0);
  }
  assert.equal(M.getMaintenance(), null);
  const { replies } = await runCmd("999", "status");
  assert.match(replies[0].embeds![0].description, /None active/);
});

test("before the window: SiteGuard known, a Kuma outage alerts and reaches the PBX", async () => {
  assert.equal((await poll([])).length, 0);
  const s = await since(() => kumaBeat(1, MonitorStatus.DOWN));
  assert.deepEqual(titles(s), ["\u{1F534} pve1 is DOWN"]);
  pbxCalls.length = 0;
  await phone.reportActive("kuma:monitor:1", "pve1 is down.");
  assert.deepEqual(pbxCalls.map((c) => c.path), ["/alert"]);
});

let endsAt = 0;
test("start: one notice in the alert channel with who, reason and end time; private confirmation", async () => {
  pbxCalls.length = 0;
  const before = Date.now();
  const { replies, sent: s } = await runCmd("111", "start", { duration: "2h", reason: "proxmox upgrades" });
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content!, /Maintenance window started.*<t:\d+:f>/);
  assert.equal(s.length, 1);
  assert.equal(s[0].channel, "alerts");
  assert.equal(s[0].content, undefined, "no ping");
  const e = s[0].embeds[0];
  assert.match(e.title, /Maintenance window started/);
  const f = fields(e);
  assert.equal(f.By, "<@111>");
  assert.equal(f.Reason, "proxmox upgrades");
  assert.match(f.Until, /<t:\d+:f>.*ends automatically/);
  const w = M.getMaintenance()!;
  assert.ok(w.endsAt >= before + 7_200_000 && w.endsAt <= Date.now() + 7_200_000);
  assert.equal(w.startedById, "111");
  endsAt = w.endsAt;
  assert.ok(M.isMaintenanceActive());
  // the escalation already running for pve1 is stood down at the PBX
  assert.deepEqual(pbxCalls, [{ path: "/resolve", key: "kuma:monitor:1" }]);
});

test("during the window: Kuma, SiteGuard, PBX and node notices are all held back and counted", async () => {
  pbxCalls.length = 0;
  let s = await since(() => { kumaBeat(2, MonitorStatus.DOWN); kumaBeat(3, MonitorStatus.DOWN); kumaBeat(3, MonitorStatus.UP); });
  assert.equal(s.length, 0, "no Kuma down or recovery alert");
  s = await poll([2]);
  assert.equal(s.length, 0, "no SiteGuard down alert");
  assert.equal(siteguard.getDownSites().length, 1, "state still tracked");

  await phone.reportActive("kuma:monitor:2", "pve2 is down.");
  await phone.reportActive("sg:site:2", "Web site is down.", "uptime", "sg-site-down");
  assert.deepEqual(pbxCalls.filter((c) => c.path === "/alert"), [], "no call requested");
  assert.ok(phone.trackedKeys().includes("kuma:monitor:2"), "condition kept for after the window");

  // reminders stay quiet too
  s = await since(() => sgAlerts.runReminders(client));
  assert.equal(s.length, 0);

  const w = M.getMaintenance()!;
  assert.equal(w.suppressed, 4);
  assert.deepEqual(w.suppressedKinds, { "kuma-down": 2, "kuma-recovery": 1, "sg-site-down": 1 });
  assert.equal(M.suppressedText(w), "4 (Kuma down 2, Kuma recovery 1, SiteGuard site down 1)");
  assert.match(M.maintenanceBanner(), /MAINTENANCE WINDOW .* proxmox upgrades/);
});

test("status shows who, until when, why and what was held back", async () => {
  const { replies } = await runCmd("999", "status");
  assert.equal(replies[0].ephemeral, true);
  const e = replies[0].embeds![0];
  assert.match(e.title, /Maintenance window active/);
  const f = fields(e);
  assert.equal(f["Started by"], "<@111>");
  assert.match(f.Ends, /<t:\d+:f>/);
  assert.equal(f.Reason, "proxmox upgrades");
  assert.match(f["Alerts suppressed so far"], /^4 /);
});

test("the window and its counter survive a restart (database reopened)", () => {
  db.closeDb();
  db.initDb(dbPath);
  const w = M.getMaintenance()!;
  assert.equal(w.endsAt, endsAt);
  assert.equal(w.reason, "proxmox upgrades");
  assert.equal(w.suppressed, 4);
  assert.ok(M.isMaintenanceActive());
});

test("expiry: one summary, then normal alerts for what is still down; calls resume", async () => {
  assert.equal(await run.runMaintenanceSweep(client, endsAt - 1), false, "not due yet");
  pbxCalls.length = 0;
  let ended = false;
  const s = await since(async () => { ended = await run.runMaintenanceSweep(client, endsAt); });
  assert.equal(ended, true);
  assert.equal(M.getMaintenance(), null);

  const summary = s[0];
  assert.equal(summary.channel, "alerts");
  assert.equal(summary.content, undefined);
  assert.match(summary.embeds[0].title, /Maintenance window ended$/);
  const f = fields(summary.embeds[0]);
  assert.match(f.Ended, new RegExp(`<t:${Math.floor(endsAt / 1000)}:f> \\(on schedule\\)`));
  assert.equal(f["Started by"], "<@111>");
  assert.equal(f.Reason, "proxmox upgrades");
  assert.match(f["Alerts suppressed"], /^4 \(/);
  assert.match(f["Still down (3), alerting normally now"], /pve1, pve2, sgt-kp-m\.test\/sub1/);

  const t = titles(s.slice(1));
  assert.ok(t.includes("\u{1F534} pve2 is DOWN"), "outage that started in the window alerts now");
  assert.ok(!t.includes("\u{1F534} pve1 is DOWN"), "outage announced before the window is not repeated");
  assert.ok(!t.some((x) => /opnsense/.test(x)), "recovered monitor stays quiet");
  const sgDown = s.find((x) => /sub1 is DOWN/.test(x.embeds[0]?.title ?? ""));
  assert.ok(sgDown, "SiteGuard site still down alerts now");
  assert.equal(sgDown!.content, "@everyone");
  assert.equal(titles(s).filter((x) => /Maintenance window/.test(x)).length, 1, "exactly one summary");

  // phone escalation starts over and reaches the PBX again
  assert.ok(pbxCalls.some((c) => c.path === "/resolve" && c.key === "kuma:monitor:2"));
  pbxCalls.length = 0;
  await phone.reportActive("kuma:monitor:2", "pve2 is down.");
  assert.deepEqual(pbxCalls.map((c) => c.path), ["/alert"]);

  // and a new outage alerts as usual
  const n = await since(() => kumaBeat(3, MonitorStatus.DOWN));
  assert.deepEqual(titles(n), ["\u{1F534} opnsense is DOWN"]);
  assert.equal(await run.runMaintenanceSweep(client, endsAt + 60_000), false, "only once");
});

test("start while open updates the end time; manual end posts one summary naming who ended it", async () => {
  let r = await runCmd("111", "start", { duration: "2m", reason: "test window" });
  assert.match(titles(r.sent)[0], /started/);
  const first = M.getMaintenance()!;

  const s0 = await since(() => kumaBeat(3, MonitorStatus.UP));
  assert.equal(s0.length, 0, "recovery held back");

  r = await runCmd("111", "start", { duration: "5m" });
  assert.match(r.replies[0].content!, /updated/);
  assert.match(titles(r.sent)[0], /Maintenance window updated/);
  const upd = M.getMaintenance()!;
  assert.equal(upd.startedAt, first.startedAt);
  assert.equal(upd.reason, "test window", "reason kept");
  assert.ok(upd.endsAt > first.endsAt);
  assert.equal(upd.suppressed, 1);

  r = await runCmd("111", "end");
  assert.equal(r.replies[0].ephemeral, true);
  assert.match(r.replies[0].content!, /ended.*1 alert was suppressed; 3 still down/);
  assert.equal(r.sent[0].channel, "alerts");
  assert.match(r.sent[0].embeds[0].title, /ended early/);
  assert.match(fields(r.sent[0].embeds[0]).Ended, /by <@111>/);
  assert.equal(titles(r.sent).filter((x) => /Maintenance window/.test(x)).length, 1);
  assert.ok(!titles(r.sent).some((x) => /is DOWN/.test(x)), "already-announced outages are not repeated");
  assert.equal(M.getMaintenance(), null);

  const st = await runCmd("111", "status");
  assert.match(st.replies[0].embeds![0].description, /None active/);
});

test("node notices are held back too; an expired window no longer silences anything", async () => {
  M.saveMaintenance({ startedBy: "u", startedById: "111", reason: null, startedAt: 0, endsAt: Date.now() + 60_000, channelId: null, suppressed: 0, suppressedKinds: {} });
  assert.equal(M.suppressedByMaintenance("wpops", { subject: "node down" }), true);
  assert.equal(M.getMaintenance()!.suppressedKinds.wpops, 1);

  M.saveMaintenance({ ...M.getMaintenance()!, endsAt: 1_000 });
  assert.equal(M.isMaintenanceActive(), false);
  assert.equal(M.suppressedByMaintenance("kuma-down"), false);
  assert.equal(M.getMaintenance()!.suppressed, 1, "not counted after the end time");
  assert.match(M.maintenanceStatusEmbed(M.getMaintenance()).toJSON().description!, /Ending now/);
  M.clearMaintenance();
});
