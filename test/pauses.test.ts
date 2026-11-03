/**
 * Per-monitor pause/resume: duration parsing, autocomplete, monitor lookup,
 * pausing in Kuma (mocked socket actions), groups, the persisted auto-resume
 * schedule (including across a database reopen, as after a restart), stale
 * record pruning, and the /pause, /resume, /paused command handlers.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionFlagsBits } from "discord.js";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  ADMIN_USER_IDS: "111",
});
delete process.env.SETTINGS_ENCRYPTION_KEY;

const { loadEnv, resetEnvForTests } = await import("../src/util/env.js");
resetEnvForTests();
loadEnv();

const dbPath = join(mkdtempSync(join(tmpdir(), "bot-pause-")), "bot.db");
const db = await import("../src/db/index.js");
db.initDb(dbPath);

const P = await import("../src/services/monitorPauses.js");
const { kuma } = await import("../src/services/kuma.js");
const status = await import("../src/commands/status.js");
const { ADMINS_ONLY } = await import("../src/util/admin.js");
type KumaMonitor = import("../src/services/kuma.js").KumaMonitor;

// ---- fixtures -------------------------------------------------------------

function mon(id: number, name: string, parent: number | null = null, type = "http", active = true): KumaMonitor {
  return {
    id, name, type, url: "", hostname: "", port: null, active, interval: 60,
    description: "", tags: [], parent, maintenance: false, maxretries: 0,
  };
}

/** Mirrors the real layout: customer groups with monitors in them. */
function fleet(): Map<number, KumaMonitor> {
  const list = [
    mon(80, "NOR", null, "group"),
    mon(2, "NOR-HQMain", 80, "ping"),
    mon(5, "NOR-WHSE", 80, "ping"),
    mon(18, "NOR-SLM", 80, "ping", false), // paused on its own beforehand
    mon(81, "SOU", null, "group"),
    mon(9, "SOU-C01", 81, "ping"),
    mon(20, "SOU-C01 Storefront.example", 81),
    mon(26, "KC WordPress Server", null, "ping"),
  ];
  return new Map(list.map((m) => [m.id, m]));
}

type Call = { action: "pause" | "resume"; id: number };

function fakeKuma(opts: { failIds?: number[]; connected?: boolean } = {}) {
  const calls: Call[] = [];
  const k = {
    monitors: fleet(),
    connected: opts.connected ?? true,
    async pauseMonitor(id: number) {
      calls.push({ action: "pause", id });
      return opts.failIds?.includes(id) ? { ok: false, msg: "Kuma said no" } : { ok: true };
    },
    async resumeMonitor(id: number) {
      calls.push({ action: "resume", id });
      return opts.failIds?.includes(id) ? { ok: false, msg: "Kuma said no" } : { ok: true };
    },
  };
  return { k, calls };
}

const req = (monitorId: number, extra: Partial<import("../src/services/monitorPauses.js").PauseRequest> = {}) => ({
  monitorId, durationMs: null, reason: null, userId: "111", userTag: "dean", channelId: "chan-1", ...extra,
});

beforeEach(() => {
  for (const r of P.listPauses()) P.deletePause(r.monitorId);
});

// ---- durations --------------------------------------------------------------

test("parseDuration accepts 30m, 2h, 1d, 1h30m, words and bare minutes", () => {
  const M = 60_000, H = 60 * M, D = 24 * H;
  assert.equal(P.parseDuration("30m"), 30 * M);
  assert.equal(P.parseDuration("2h"), 2 * H);
  assert.equal(P.parseDuration("1d"), D);
  assert.equal(P.parseDuration("1w"), 7 * D);
  assert.equal(P.parseDuration("1h30m"), H + 30 * M);
  assert.equal(P.parseDuration("1h 30m"), H + 30 * M);
  assert.equal(P.parseDuration(" 2 hours "), 2 * H);
  assert.equal(P.parseDuration("1 day 2 hrs"), D + 2 * H);
  assert.equal(P.parseDuration("45"), 45 * M);
  assert.equal(P.parseDuration("2H"), 2 * H);
  for (const bad of ["", "  ", "0", "0m", "abc", "2x", "h2", "1.5h", "-1h", "2h junk", "2hm"]) {
    assert.equal(P.parseDuration(bad), null, bad);
  }
});

test("formatDuration and discordTime", () => {
  assert.equal(P.formatDuration(45 * 60_000), "45m");
  assert.equal(P.formatDuration(150 * 60_000), "2h 30m");
  assert.equal(P.formatDuration(26 * 3_600_000), "1d 2h");
  assert.equal(P.formatDuration(2 * 86_400_000), "2d");
  assert.equal(P.formatDuration(10_000), "1m");
  assert.equal(P.discordTime(1_700_000_000_000), "<t:1700000000:f> (<t:1700000000:R>)");
});

// ---- autocomplete and lookup -----------------------------------------------

test("monitorChoices: substring on name or group, group shown, filtered per command", () => {
  const ms = fleet();
  const status = new Map<number, number>([[2, 1], [5, 0]]);

  const names = (q: string, mode?: "any" | "pause" | "resume") =>
    P.monitorChoices(ms, status, q, mode).map((c) => c.name);

  assert.deepEqual(names("whse"), ["\u274C NOR-WHSE \u00B7 NOR"]);
  assert.deepEqual(P.monitorChoices(ms, status, "whse").map((c) => c.value), ["5"]);
  // "nor" matches the group and its monitors (by name), group first (starts-with, alphabetical)
  assert.deepEqual(names("nor"), ["\u{1F4C1} NOR (group, 3 monitors)", "\u2705 NOR-HQMain \u00B7 NOR", "\u23F8 NOR-SLM \u00B7 NOR", "\u274C NOR-WHSE \u00B7 NOR"]);
  // A group-name match lists the monitors in that group after direct matches.
  assert.deepEqual(names("sou").length, 3);
  assert.ok(names("storefront")[0].includes("SOU-C01 Storefront.example \u00B7 SOU"));
  // /pause offers active ones, /resume paused ones
  assert.ok(!names("nor", "pause").some((n) => n.includes("NOR-SLM")));
  assert.deepEqual(names("nor", "resume"), ["\u23F8 NOR-SLM \u00B7 NOR"]);
  // filter that leaves nothing falls back to all matches
  assert.deepEqual(names("sou-c01 sto", "resume").length, 1);
  assert.equal(names("").length, ms.size);
  assert.equal(P.monitorChoices(ms, status, "", "any", 3).length, 3);
  assert.deepEqual(names("nothing-like-this"), []);
});

test("resolveMonitorStrict: id, exact name, unique substring; ambiguous refused", () => {
  const ms = fleet();
  assert.equal((P.resolveMonitorStrict(ms, "5") as any).monitor.name, "NOR-WHSE");
  assert.equal((P.resolveMonitorStrict(ms, "sou") as any).monitor.id, 81, "exact name (case-insensitive) wins");
  assert.equal((P.resolveMonitorStrict(ms, "hqmain") as any).monitor.id, 2);
  assert.match((P.resolveMonitorStrict(ms, "NOR-") as any).error, /matches 3 monitors/);
  assert.match((P.resolveMonitorStrict(ms, "nope") as any).error, /not found/);
  assert.match((P.resolveMonitorStrict(ms, "  ") as any).error, /not found/);
});

// ---- pause / resume ---------------------------------------------------------

test("pause with a duration pauses in Kuma and records the schedule", async () => {
  const { k, calls } = fakeKuma();
  const out = await P.pauseWithSchedule(req(5, { durationMs: 7_200_000, reason: "ISP work", now: 1_000 }), k);
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [{ action: "pause", id: 5 }]);
  assert.equal(k.monitors.get(5)!.active, false, "local cache updated");
  const rec = P.getPause(5)!;
  assert.equal(rec.resumeAt, 1_000 + 7_200_000);
  assert.equal(rec.reason, "ISP work");
  assert.equal(rec.pausedById, "111");
  assert.equal(rec.channelId, "chan-1");
  assert.equal(rec.groupId, null);
});

test("pause failure in Kuma: error, nothing recorded", async () => {
  const { k } = fakeKuma({ failIds: [5] });
  const out = await P.pauseWithSchedule(req(5), k);
  assert.equal(out.ok, false);
  assert.match(out.error!, /Failed to pause NOR-WHSE: Kuma said no/);
  assert.equal(P.getPause(5), null);
  assert.equal(k.monitors.get(5)!.active, true);
});

test("already paused: refused without options, schedule updated with a duration", async () => {
  const { k, calls } = fakeKuma();
  let out = await P.pauseWithSchedule(req(18), k);
  assert.equal(out.ok, false);
  assert.match(out.error!, /already paused/);

  out = await P.pauseWithSchedule(req(18, { durationMs: 60_000, now: 5 }), k);
  assert.equal(out.ok, true);
  assert.equal(out.updated, true);
  assert.equal(calls.length, 0, "no Kuma call for an already paused monitor");
  assert.equal(P.getPause(18)!.resumeAt, 60_005);

  // A new reason without a duration keeps the end time.
  out = await P.pauseWithSchedule(req(18, { reason: "still broken", now: 10 }), k);
  assert.equal(P.getPause(18)!.resumeAt, 60_005);
  assert.equal(P.getPause(18)!.reason, "still broken");
});

test("group pause pauses its active monitors; resume restores exactly those", async () => {
  const { k, calls } = fakeKuma();
  const out = await P.pauseWithSchedule(req(80, { durationMs: 3_600_000, now: 0 }), k);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((c) => c.id), [80, 2, 5], "group first, already-paused NOR-SLM skipped");
  assert.equal(out.members, 3);
  assert.equal(P.getPause(2)!.groupId, 80);
  assert.equal(P.getPause(18), null);

  const lines = P.pausedLines(k.monitors, P.listPauses());
  assert.equal(lines.length, 2, "group line + NOR-SLM (paused on its own)");
  assert.match(lines[0], /\*\*NOR\*\* \(group, 2 monitors paused with it\) - until <t:3600:f>/);
  assert.match(lines[1], /NOR-SLM\*\* \u00B7 NOR - paused in Kuma \(no schedule\)/);

  calls.length = 0;
  const r = await P.resumeAndClear(80, k);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => `${c.action}:${c.id}`), ["resume:80", "resume:2", "resume:5"]);
  assert.equal(k.monitors.get(18)!.active, false, "independently paused monitor stays paused");
  assert.equal(P.listPauses().length, 0);
});

test("resume: already active refused; child of a paused group gets a note", async () => {
  const { k } = fakeKuma();
  let r = await P.resumeAndClear(5, k);
  assert.equal(r.ok, false);
  assert.match(r.error!, /already active/);

  k.monitors.get(80)!.active = false;
  k.monitors.get(2)!.active = false;
  r = await P.resumeAndClear(2, k);
  assert.equal(r.ok, true);
  assert.equal(r.stillPausedGroup?.name, "NOR");

  r = await P.resumeAndClear(999, k);
  assert.match(r.error!, /not found/);
});

// ---- auto-resume ------------------------------------------------------------

test("auto-resume: due pauses resume and are announced; later ones wait; failures retry", async () => {
  const { k, calls } = fakeKuma();
  await P.pauseWithSchedule(req(5, { durationMs: 60_000, reason: "r", now: 0 }), k);
  await P.pauseWithSchedule(req(9, { durationMs: 600_000, now: 0 }), k);
  await P.pauseWithSchedule(req(26, { now: 0 }), k); // open-ended
  calls.length = 0;

  const announced: string[] = [];
  const announce = async (rec: any) => { announced.push(rec.monitorName); };

  assert.equal(await P.runAutoResume(30_000, k, announce), 0, "nothing due yet");
  assert.equal(await P.runAutoResume(60_000, k, announce), 1);
  assert.deepEqual(calls, [{ action: "resume", id: 5 }]);
  assert.deepEqual(announced, ["NOR-WHSE"]);
  assert.equal(P.getPause(5), null);
  assert.ok(P.getPause(9));
  assert.ok(P.getPause(26), "open-ended pause never auto-resumes");

  // Kuma not connected: nothing happens, schedule kept.
  const offline = { ...k, connected: false };
  assert.equal(await P.runAutoResume(10_000_000, offline, announce), 0);
  assert.ok(P.getPause(9));

  // Kuma refuses: kept and retried.
  const { k: k2 } = fakeKuma({ failIds: [9] });
  k2.monitors.get(9)!.active = false;
  assert.equal(await P.runAutoResume(10_000_000, k2, announce), 0);
  assert.ok(P.getPause(9), "kept for the next sweep");
  assert.equal(await P.runAutoResume(10_000_000, k, announce), 1);
  assert.equal(P.getPause(9), null);
  assert.deepEqual(announced, ["NOR-WHSE", "SOU-C01"]);
});

test("auto-resume schedule survives a restart (database reopened)", async () => {
  const { k } = fakeKuma();
  await P.pauseWithSchedule(req(80, { durationMs: 120_000, reason: "move", now: 0 }), k);

  db.closeDb();
  db.initDb(dbPath);

  const recs = P.listPauses();
  assert.deepEqual(recs.map((r) => r.monitorId).sort((a, b) => a - b), [2, 5, 80]);
  const fresh = fakeKuma();
  for (const id of [80, 2, 5]) fresh.k.monitors.get(id)!.active = false;
  const announced: number[] = [];
  const n = await P.runAutoResume(120_000, fresh.k, async (rec, out) => { announced.push(rec.monitorId, out.resumed.length); });
  assert.equal(n, 1, "group and its members end as one pause");
  assert.deepEqual(announced, [80, 3]);
  assert.deepEqual(fresh.calls.map((c) => c.id), [80, 2, 5]);
  assert.equal(P.listPauses().length, 0);
});

test("auto-resume drops a record when the monitor was resumed or deleted elsewhere", async () => {
  const { k, calls } = fakeKuma();
  await P.pauseWithSchedule(req(5, { durationMs: 60_000, now: 0 }), k);
  k.monitors.get(5)!.active = true; // resumed in Kuma's UI
  calls.length = 0;
  assert.equal(await P.runAutoResume(60_000, k), 0);
  assert.equal(calls.length, 0);
  assert.equal(P.getPause(5), null);
});

test("pruneStalePauses: keeps fresh records, drops ones Kuma no longer has paused", async () => {
  const { k } = fakeKuma();
  await P.pauseWithSchedule(req(5, { now: 0 }), k);
  await P.pauseWithSchedule(req(9, { now: 0 }), k);
  k.monitors.get(5)!.active = true;
  assert.equal(P.pruneStalePauses(k, 60_000), 0, "within the grace period");
  assert.equal(P.pruneStalePauses(k, 10 * 60_000), 1);
  assert.equal(P.getPause(5), null);
  assert.ok(P.getPause(9));
  k.monitors.delete(9);
  assert.equal(P.pruneStalePauses(k, 10 * 60_000), 1);
  assert.equal(P.pruneStalePauses({ ...k, connected: false }, 10 * 60_000), 0);
});

// ---- command handlers -------------------------------------------------------

type Msg = { content?: string; ephemeral?: boolean; embeds?: any[]; allowedMentions?: unknown };
function fakeInteraction(userId: string, strings: Record<string, string>, commandName = "pause") {
  const replies: Msg[] = [];
  const followUps: Msg[] = [];
  const i: any = {
    commandName,
    user: { id: userId, tag: `u${userId}` },
    channelId: "chan-9",
    deferred: false, replied: false,
    options: { getString: (n: string) => strings[n] ?? null, getSubcommand: () => "" },
    reply: async (m: any) => { i.replied = true; replies.push(typeof m === "string" ? { content: m } : m); },
    deferReply: async (m: any) => { i.deferred = true; i.deferEphemeral = m?.ephemeral; },
    editReply: async (m: any) => { replies.push(typeof m === "string" ? { content: m } : m); },
    followUp: async (m: any) => { followUps.push(m); },
  };
  return { i, replies, followUps };
}

/** Load the fleet into the real client and stub its socket actions. */
function stubRealKuma(failIds: number[] = []) {
  const calls: Call[] = [];
  kuma.monitors.clear();
  for (const [id, m] of fleet()) kuma.monitors.set(id, m);
  (kuma as any)._connected = true;
  (kuma as any)._authenticated = true;
  (kuma as any).pauseMonitor = async (id: number) => {
    calls.push({ action: "pause", id });
    return failIds.includes(id) ? { ok: false, msg: "Timeout" } : { ok: true };
  };
  (kuma as any).resumeMonitor = async (id: number) => {
    calls.push({ action: "resume", id });
    return failIds.includes(id) ? { ok: false, msg: "Timeout" } : { ok: true };
  };
  return calls;
}

test("command definitions: options, admin default permissions, /paused registered", () => {
  const pause = status.pauseCommand.toJSON();
  assert.equal(pause.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.deepEqual(pause.options!.map((o) => [o.name, !!o.required]), [["name", true], ["duration", false], ["reason", false]]);
  assert.equal((pause.options![0] as any).autocomplete, true);
  assert.equal(status.resumeCommand.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(status.pausedCommand.toJSON().name, "paused");
});

test("/pause: non-admin, unknown site, bad duration, too long: ephemeral, Kuma untouched", async () => {
  const calls = stubRealKuma();
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["999", { name: "5", duration: "2h" }, new RegExp(ADMINS_ONLY)],
    ["111", { name: "no-such-site" }, /not found/],
    ["111", { name: "NOR-" }, /matches 3 monitors/],
    ["111", { name: "5", duration: "soon" }, /Could not read the duration/],
    ["111", { name: "5", duration: "45d" }, /longest pause is 30d/],
  ];
  for (const [user, strings, re] of cases) {
    const { i, replies, followUps } = fakeInteraction(user, strings);
    await status.handlePauseCommand(i);
    assert.equal(replies.length, 1, JSON.stringify(strings));
    assert.match(replies[0].content!, re);
    assert.equal(replies[0].ephemeral, true);
    assert.equal(followUps.length, 0);
  }
  assert.equal(calls.length, 0);
  assert.equal(P.listPauses().length, 0);
});

test("/pause: Kuma failure is reported privately, no announcement", async () => {
  const calls = stubRealKuma([5]);
  const { i, replies, followUps } = fakeInteraction("111", { name: "5", duration: "2h" });
  await status.handlePauseCommand(i);
  assert.equal(i.deferEphemeral, true);
  assert.match(replies[0].content!, /Failed to pause NOR-WHSE: Timeout/);
  assert.equal(followUps.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(P.getPause(5), null);
});

test("/pause then /paused then /resume: confirmation posted publicly with who, until, reason", async () => {
  const calls = stubRealKuma();
  const before = Date.now();
  let f = fakeInteraction("111", { name: "5", duration: "2h", reason: "ISP maintenance" });
  await status.handlePauseCommand(f.i);
  assert.match(f.replies[0].content!, /Paused \*\*NOR-WHSE\*\* until <t:\d+:f>/);
  assert.equal(f.followUps.length, 1);
  const embed = f.followUps[0].embeds![0].toJSON();
  assert.equal(f.followUps[0].ephemeral, undefined, "public");
  assert.deepEqual(f.followUps[0].allowedMentions, { parse: [] });
  assert.match(embed.title, /Paused: NOR-WHSE/);
  const fields = Object.fromEntries(embed.fields.map((x: any) => [x.name, x.value]));
  assert.equal(fields.By, "<@111>");
  assert.match(fields.Until, /resumes automatically/);
  assert.equal(fields.Reason, "ISP maintenance");
  const rec = P.getPause(5)!;
  assert.ok(rec.resumeAt! >= before + 7_200_000 && rec.resumeAt! <= Date.now() + 7_200_000);
  assert.equal(rec.channelId, "chan-9");

  f = fakeInteraction("222", {}, "paused");
  await status.handlePausedCommand(f.i);
  const list = f.replies[0].embeds![0].toJSON().description as string;
  assert.match(list, /NOR-WHSE\*\* \u00B7 NOR - until <t:\d+:f> .* by <@111> \u00B7 ISP maintenance/);
  assert.equal(f.replies[0].ephemeral, true);

  f = fakeInteraction("999", { name: "5" }, "resume");
  await status.handleResumeCommand(f.i);
  assert.equal(f.replies[0].content, ADMINS_ONLY);

  f = fakeInteraction("111", { name: "NOR-WHSE" }, "resume");
  await status.handleResumeCommand(f.i);
  assert.match(f.replies[0].content!, /Resumed \*\*NOR-WHSE\*\*/);
  assert.match(f.followUps[0].embeds![0].toJSON().title, /Resumed: NOR-WHSE/);
  assert.deepEqual(calls.map((c) => `${c.action}:${c.id}`), ["pause:5", "resume:5"]);
  assert.equal(P.getPause(5), null);
});

test("autocomplete: /pause offers active monitors, /resume paused ones, with group", async () => {
  stubRealKuma();
  const responses: any[] = [];
  const ac = (commandName: string, focused: string) => ({
    commandName,
    options: { getFocused: () => focused },
    respond: async (r: any) => { responses.push(r); },
  });
  await status.handleMonitorAutocomplete(ac("pause", "nor") as any);
  await status.handleMonitorAutocomplete(ac("resume", "nor") as any);
  await status.handleMonitorAutocomplete(ac("monitor", "slm") as any);
  assert.ok(!responses[0].some((c: any) => c.value === "18"));
  assert.deepEqual(responses[1].map((c: any) => c.value), ["18"]);
  assert.match(responses[2][0].name, /NOR-SLM \u00B7 NOR/);
});
