/**
 * Pausing individual Kuma monitors from Discord, optionally for a set time.
 *
 * `/pause` pauses the monitor in Uptime Kuma itself (Kuma stops checking it,
 * so neither Kuma nor the bot alerts on it). A pause can carry a duration and
 * a reason. Every pause made through the bot is recorded in the
 * `monitor_pauses` table of data/bot.db, so the auto-resume schedule survives
 * restarts: a periodic sweep resumes every monitor whose time has come and
 * announces it in the channel the pause was made from.
 *
 * Pausing a group monitor also pauses every active monitor inside it (Kuma
 * keeps checking the children of a paused group otherwise). Those children
 * are recorded with the group's id, so resuming the group resumes exactly the
 * monitors the group pause stopped, not ones that were paused on their own.
 */

import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { database, getSetting } from "../db/index.js";
import { logger } from "../util/logger.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { kuma, MonitorStatus, type KumaMonitor } from "./kuma.js";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

/** The part of the Kuma client this module uses (mocked in tests). */
export interface KumaLike {
  readonly monitors: Map<number, KumaMonitor>;
  readonly connected: boolean;
  pauseMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }>;
  resumeMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }>;
}

export interface PauseRecord {
  monitorId: number;
  monitorName: string;
  pausedBy: string;
  pausedById: string;
  reason: string | null;
  pausedAt: number;
  /** Epoch ms of the automatic resume; null = until someone runs /resume. */
  resumeAt: number | null;
  /** Channel the pause was made from (auto-resume is announced there). */
  channelId: string | null;
  /** Set on a monitor paused together with its group. */
  groupId: number | null;
}

// ---------------------------------------------------------------
// Durations
// ---------------------------------------------------------------

/** Longest pause accepted; longer silences belong in a Kuma maintenance window. */
export const MAX_PAUSE_MS = 30 * 86_400_000;

const UNITS: Array<[RegExp, number]> = [
  [/^(w|wk|wks|week|weeks)$/, 7 * 86_400_000],
  [/^(d|day|days)$/, 86_400_000],
  [/^(h|hr|hrs|hour|hours)$/, 3_600_000],
  [/^(m|min|mins|minute|minutes)$/, 60_000],
];

/**
 * Parse a duration such as "30m", "2h", "1d", "1h30m" or "2 hours".
 * A bare number is minutes. Returns milliseconds, or null when the text is
 * not a duration or adds up to zero.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n * 60_000 : null;
  }
  const re = /(\d+)\s*([a-z]+)\s*/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    if (m.index !== consumed) return null;
    const unit = UNITS.find(([u]) => u.test(m[2]));
    if (!unit) return null;
    total += Number(m[1]) * unit[1];
    consumed += m[0].length;
  }
  if (consumed !== s.length || total <= 0) return null;
  return total;
}

/** "1d 2h", "2h 30m", "45m" (rounded down to the minute, at least 1m). */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  return parts.join(" ") || "1m";
}

/** Discord timestamp markup: absolute time plus "in 2 hours", in each viewer's own timezone. */
export function discordTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `<t:${s}:f> (<t:${s}:R>)`;
}

// ---------------------------------------------------------------
// Persistence (data/bot.db, table monitor_pauses)
// ---------------------------------------------------------------

interface PauseRow {
  monitor_id: number;
  monitor_name: string;
  paused_by: string;
  paused_by_id: string;
  reason: string | null;
  paused_at: number;
  resume_at: number | null;
  channel_id: string | null;
  group_id: number | null;
}

function fromRow(r: PauseRow): PauseRecord {
  return {
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    pausedBy: r.paused_by,
    pausedById: r.paused_by_id,
    reason: r.reason,
    pausedAt: r.paused_at,
    resumeAt: r.resume_at,
    channelId: r.channel_id,
    groupId: r.group_id,
  };
}

export function savePause(rec: PauseRecord): void {
  database()
    .prepare(
      `INSERT OR REPLACE INTO monitor_pauses
         (monitor_id, monitor_name, paused_by, paused_by_id, reason, paused_at, resume_at, channel_id, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.monitorId, rec.monitorName, rec.pausedBy, rec.pausedById, rec.reason,
      rec.pausedAt, rec.resumeAt, rec.channelId, rec.groupId,
    );
}

export function getPause(monitorId: number): PauseRecord | null {
  const row = database()
    .prepare("SELECT * FROM monitor_pauses WHERE monitor_id = ?")
    .get(monitorId) as PauseRow | undefined;
  return row ? fromRow(row) : null;
}

export function listPauses(): PauseRecord[] {
  return (database().prepare("SELECT * FROM monitor_pauses ORDER BY monitor_name").all() as PauseRow[]).map(fromRow);
}

/** Pauses whose resume time has come, groups before their children. */
export function duePauses(now: number): PauseRecord[] {
  return (database()
    .prepare(
      `SELECT * FROM monitor_pauses
       WHERE resume_at IS NOT NULL AND resume_at <= ?
       ORDER BY (group_id IS NOT NULL), resume_at`,
    )
    .all(now) as PauseRow[]).map(fromRow);
}

export function deletePause(monitorId: number): void {
  database().prepare("DELETE FROM monitor_pauses WHERE monitor_id = ?").run(monitorId);
}

function groupMemberPauses(groupId: number): PauseRecord[] {
  return (database()
    .prepare("SELECT * FROM monitor_pauses WHERE group_id = ?")
    .all(groupId) as PauseRow[]).map(fromRow);
}

// ---------------------------------------------------------------
// Monitor lookup
// ---------------------------------------------------------------

/** Every monitor below a group (children, grandchildren, ...). */
export function descendants(monitors: Map<number, KumaMonitor>, groupId: number): KumaMonitor[] {
  const out: KumaMonitor[] = [];
  const seen = new Set<number>([groupId]);
  const queue = [groupId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const m of monitors.values()) {
      if (m.parent === parent && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  return out;
}

/** Name of the group a monitor sits in, if any. */
export function groupNameOf(monitors: Map<number, KumaMonitor>, m: KumaMonitor): string | null {
  if (m.parent === null || m.parent === undefined) return null;
  return monitors.get(m.parent)?.name ?? null;
}

/** The nearest paused group above a monitor, if any. */
function pausedAncestor(monitors: Map<number, KumaMonitor>, m: KumaMonitor): KumaMonitor | null {
  const seen = new Set<number>([m.id]);
  let cur = m.parent !== null && m.parent !== undefined ? monitors.get(m.parent) : undefined;
  while (cur && !seen.has(cur.id)) {
    if (!cur.active) return cur;
    seen.add(cur.id);
    cur = cur.parent !== null && cur.parent !== undefined ? monitors.get(cur.parent) : undefined;
  }
  return null;
}

export type ChoiceMode = "any" | "pause" | "resume";

/**
 * Autocomplete choices: substring match on the monitor name or its group's
 * name, the group shown next to the name. For /pause active monitors are
 * offered, for /resume paused ones (falling back to every match when the
 * filter leaves nothing). The value is the monitor id.
 */
export function monitorChoices(
  monitors: Map<number, KumaMonitor>,
  latestStatus: Map<number, number>,
  query: string,
  mode: ChoiceMode = "any",
  limit = 25,
): Array<{ name: string; value: string }> {
  const q = query.trim().toLowerCase();
  const scored: Array<{ m: KumaMonitor; group: string | null; rank: number }> = [];
  for (const m of monitors.values()) {
    const group = groupNameOf(monitors, m);
    const name = m.name.toLowerCase();
    let rank: number;
    if (!q || name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (group && group.toLowerCase().includes(q)) rank = 2;
    else continue;
    scored.push({ m, group, rank });
  }

  let pool = scored;
  if (mode !== "any") {
    const wanted = scored.filter((s) => (mode === "pause" ? s.m.active : !s.m.active));
    if (wanted.length > 0) pool = wanted;
  }

  pool.sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name));

  return pool.slice(0, limit).map(({ m, group }) => {
    let label: string;
    if (m.type === "group") {
      const n = descendants(monitors, m.id).length;
      label = `${m.active ? "\u{1F4C1}" : "⏸"} ${m.name} (group, ${n} monitor${n === 1 ? "" : "s"})`;
    } else {
      const status = latestStatus.get(m.id);
      const emoji = !m.active ? "⏸"
        : status === undefined ? "❓"
        : status === MonitorStatus.UP ? "✅"
        : status === MonitorStatus.DOWN ? "❌"
        : "⚠";
      label = `${emoji} ${m.name}${group ? ` · ${group}` : ""}`;
    }
    return { name: label.slice(0, 100), value: String(m.id) };
  });
}

/**
 * Resolve the `name` option of /pause and /resume: a monitor id (what
 * autocomplete sends), an exact name (any case), or a substring that matches
 * exactly one monitor. Ambiguous text is refused rather than guessed, since
 * pausing the wrong monitor silences it.
 */
export function resolveMonitorStrict(
  monitors: Map<number, KumaMonitor>,
  value: string,
): { monitor: KumaMonitor } | { error: string } {
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const byId = monitors.get(Number(v));
    if (byId) return { monitor: byId };
  }
  const q = v.toLowerCase();
  if (!q) return { error: "Monitor not found." };
  const all = [...monitors.values()];
  const exact = all.filter((m) => m.name.toLowerCase() === q);
  if (exact.length === 1) return { monitor: exact[0] };
  const partial = all.filter((m) => m.name.toLowerCase().includes(q));
  if (partial.length === 1) return { monitor: partial[0] };
  if (partial.length === 0) return { error: `Monitor not found: "${v.slice(0, 80)}".` };
  const names = partial.slice(0, 5).map((m) => m.name).join(", ");
  return { error: `"${v.slice(0, 80)}" matches ${partial.length} monitors (${names}${partial.length > 5 ? ", ..." : ""}). Pick one from the list.` };
}

// ---------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------

export interface PauseRequest {
  monitorId: number;
  durationMs: number | null;
  reason: string | null;
  userId: string;
  userTag: string;
  channelId: string | null;
  now?: number;
}

export interface PauseOutcome {
  ok: boolean;
  error?: string;
  monitor?: KumaMonitor;
  /** Monitors this call paused in Kuma (the target first). */
  paused: KumaMonitor[];
  /** Group members that could not be paused. */
  failed: Array<{ monitor: KumaMonitor; msg: string }>;
  resumeAt: number | null;
  /** The monitor was already paused and only its schedule/reason changed. */
  updated: boolean;
  /** Number of group members covered by the pause (paused now or before). */
  members: number;
}

function markActive(k: KumaLike, id: number, active: boolean): void {
  const m = k.monitors.get(id);
  if (m) m.active = active;
}

/**
 * Pause a monitor in Kuma (and, for a group, every active monitor in it) and
 * record the schedule. On an already paused monitor, a duration or reason
 * updates the schedule instead.
 */
export async function pauseWithSchedule(req: PauseRequest, k: KumaLike = kuma): Promise<PauseOutcome> {
  const now = req.now ?? Date.now();
  let resumeAt = req.durationMs ? now + req.durationMs : null;
  const base: PauseOutcome = { ok: false, paused: [], failed: [], resumeAt, updated: false, members: 0 };

  const m = k.monitors.get(req.monitorId);
  if (!m) return { ...base, error: "Monitor not found." };
  base.monitor = m;

  const isGroup = m.type === "group";
  const members = isGroup ? descendants(k.monitors, m.id) : [];
  const activeMembers = members.filter((c) => c.active);
  base.members = members.length;

  const existing = getPause(m.id);
  // Updating an existing pause without a new duration keeps its end time.
  if (!m.active && !req.durationMs && existing) resumeAt = existing.resumeAt;
  base.resumeAt = resumeAt;
  const record = (target: KumaMonitor, groupId: number | null): PauseRecord => ({
    monitorId: target.id,
    monitorName: target.name,
    pausedBy: req.userTag,
    pausedById: req.userId,
    reason: req.reason,
    pausedAt: now,
    resumeAt,
    channelId: req.channelId,
    groupId,
  });

  if (!m.active) {
    if (!req.durationMs && !req.reason && activeMembers.length === 0) {
      return { ...base, error: `${m.name} is already paused. Give a duration or reason to change its schedule, or use /resume.` };
    }
    // Already paused: update the schedule (and the reason, when one is given).
    const keepReason = req.reason ?? existing?.reason ?? null;
    savePause({ ...record(m, existing?.groupId ?? null), reason: keepReason, pausedAt: existing?.pausedAt ?? now });
    for (const rec of groupMemberPauses(m.id)) {
      savePause({ ...rec, resumeAt, reason: req.reason ?? rec.reason, pausedBy: req.userTag, pausedById: req.userId });
    }
    base.updated = true;
  } else {
    const res = await k.pauseMonitor(m.id);
    if (!res.ok) return { ...base, error: `Failed to pause ${m.name}: ${res.msg ?? "unknown error"}` };
    markActive(k, m.id, false);
    savePause(record(m, null));
    base.paused.push(m);
  }

  for (const c of activeMembers) {
    const res = await k.pauseMonitor(c.id);
    if (res.ok) {
      markActive(k, c.id, false);
      savePause(record(c, m.id));
      base.paused.push(c);
    } else {
      base.failed.push({ monitor: c, msg: res.msg ?? "unknown error" });
    }
  }

  logger.info(
    {
      monitorId: m.id, name: m.name, user: req.userTag, resumeAt, reason: req.reason ?? undefined,
      paused: base.paused.length, failed: base.failed.length, updated: base.updated,
    },
    "Monitor paused",
  );
  return { ...base, ok: true };
}

export interface ResumeOutcome {
  ok: boolean;
  error?: string;
  monitor?: KumaMonitor;
  /** Monitors this call resumed in Kuma (the target first). */
  resumed: KumaMonitor[];
  failed: Array<{ monitor: KumaMonitor; msg: string }>;
  /** The pause record of the target, as it was before the resume. */
  record: PauseRecord | null;
  /** A group above the monitor that is still paused (it stays silent). */
  stillPausedGroup: KumaMonitor | null;
}

/**
 * Resume a monitor in Kuma and drop its schedule. For a group, also resume
 * the members that were paused together with it.
 */
export async function resumeAndClear(monitorId: number, k: KumaLike = kuma): Promise<ResumeOutcome> {
  const base: ResumeOutcome = { ok: false, resumed: [], failed: [], record: null, stillPausedGroup: null };
  const record = getPause(monitorId);
  base.record = record;

  const m = k.monitors.get(monitorId);
  if (!m) {
    if (record) deletePause(monitorId);
    return { ...base, error: "Monitor not found." };
  }
  base.monitor = m;

  const members = groupMemberPauses(m.id)
    .map((r) => ({ r, mon: k.monitors.get(r.monitorId) }));
  const pausedMembers = members.filter((x) => x.mon && !x.mon.active);

  if (m.active && pausedMembers.length === 0) {
    if (record) deletePause(m.id);
    for (const x of members) deletePause(x.r.monitorId);
    return { ...base, error: `${m.name} is already active.` };
  }

  if (!m.active) {
    const res = await k.resumeMonitor(m.id);
    if (!res.ok) return { ...base, error: `Failed to resume ${m.name}: ${res.msg ?? "unknown error"}` };
    markActive(k, m.id, true);
    base.resumed.push(m);
  }
  deletePause(m.id);

  for (const x of members) {
    if (!x.mon) { deletePause(x.r.monitorId); continue; }
    if (x.mon.active) { deletePause(x.mon.id); continue; }
    const res = await k.resumeMonitor(x.mon.id);
    if (res.ok) {
      markActive(k, x.mon.id, true);
      deletePause(x.mon.id);
      base.resumed.push(x.mon);
    } else {
      base.failed.push({ monitor: x.mon, msg: res.msg ?? "unknown error" });
    }
  }

  base.stillPausedGroup = pausedAncestor(k.monitors, m);
  logger.info(
    { monitorId: m.id, name: m.name, resumed: base.resumed.length, failed: base.failed.length },
    "Monitor resumed",
  );
  return { ...base, ok: true };
}

// ---------------------------------------------------------------
// Auto-resume
// ---------------------------------------------------------------

/** A record younger than this is never treated as stale (Kuma may not have pushed the new state yet). */
const STALE_GRACE_MS = 2 * 60_000;

/**
 * Drop records of monitors that were resumed outside the bot (in Kuma's UI)
 * or deleted from Kuma, so they do not auto-resume a later, unrelated pause.
 */
export function pruneStalePauses(k: KumaLike = kuma, now = Date.now()): number {
  if (!k.connected || k.monitors.size === 0) return 0;
  let n = 0;
  for (const rec of listPauses()) {
    if (now - rec.pausedAt < STALE_GRACE_MS) continue;
    const m = k.monitors.get(rec.monitorId);
    if (!m || m.active) {
      deletePause(rec.monitorId);
      n++;
      logger.info({ monitorId: rec.monitorId, name: rec.monitorName, gone: !m }, "Dropped pause record: monitor no longer paused in Kuma");
    }
  }
  return n;
}

export type AutoResumeAnnounce = (record: PauseRecord, outcome: ResumeOutcome) => Promise<void>;

/**
 * Resume every monitor whose pause has lapsed. Failures stay recorded and are
 * retried on the next sweep. Returns the number of pauses ended.
 */
export async function runAutoResume(
  now: number,
  k: KumaLike = kuma,
  announce: AutoResumeAnnounce = async () => {},
): Promise<number> {
  if (!k.connected) return 0;
  let ended = 0;
  for (const due of duePauses(now)) {
    const rec = getPause(due.monitorId);
    if (!rec || rec.resumeAt === null || rec.resumeAt > now) continue; // handled with its group
    const m = k.monitors.get(rec.monitorId);
    if (!m || m.active) {
      deletePause(rec.monitorId);
      for (const r of groupMemberPauses(rec.monitorId)) {
        if (r.resumeAt !== null && r.resumeAt <= now) await resumeMemberQuietly(r, k);
      }
      continue;
    }
    const outcome = await resumeAndClear(rec.monitorId, k);
    if (!outcome.ok) {
      logger.warn({ monitorId: rec.monitorId, name: rec.monitorName, err: outcome.error }, "Auto-resume failed; retrying on the next sweep");
      continue;
    }
    ended++;
    try {
      await announce(rec, outcome);
    } catch (err) {
      logger.warn({ err, monitorId: rec.monitorId }, "Auto-resume announcement failed");
    }
  }
  return ended;
}

async function resumeMemberQuietly(r: PauseRecord, k: KumaLike): Promise<void> {
  const m = k.monitors.get(r.monitorId);
  if (!m || m.active) { deletePause(r.monitorId); return; }
  const res = await k.resumeMonitor(m.id);
  if (res.ok) { markActive(k, m.id, true); deletePause(m.id); }
}

// ---------------------------------------------------------------
// Discord output
// ---------------------------------------------------------------

/** Public confirmation of a pause. */
export function pauseEmbed(out: PauseOutcome, userId: string, reason: string | null): EmbedBuilder {
  const m = out.monitor!;
  const isGroup = m.type === "group";
  const embed = new EmbedBuilder()
    .setTitle(`⏸️ ${out.updated ? "Pause updated" : "Paused"}: ${m.name}`.slice(0, 256))
    .setColor(0xf1c40f)
    .setDescription(
      isGroup
        ? `Uptime Kuma stops checking this group and the ${out.members} monitor${out.members === 1 ? "" : "s"} in it: no alerts, emails or phone calls for them.`
        : "Uptime Kuma stops checking this monitor: no alerts, emails or phone calls for it.",
    )
    .addFields(
      { name: "By", value: `<@${userId}>`, inline: true },
      {
        name: "Until",
        value: out.resumeAt ? `${discordTime(out.resumeAt)}, then resumes automatically` : "Someone runs `/resume`",
        inline: true,
      },
    )
    .setTimestamp();
  if (reason) embed.addFields({ name: "Reason", value: reason.slice(0, 1024) });
  if (out.failed.length > 0) {
    embed.addFields({
      name: "Could not pause",
      value: out.failed.map((f) => `${f.monitor.name}: ${f.msg}`).join("\n").slice(0, 1024),
    });
  }
  return embed;
}

/** Public confirmation of a resume (manual or automatic). */
export function resumeEmbed(out: ResumeOutcome, opts: { userId?: string; auto?: boolean }): EmbedBuilder {
  const m = out.monitor!;
  const rec = out.record;
  const members = out.resumed.filter((x) => x.id !== m.id);
  const embed = new EmbedBuilder()
    .setTitle(`▶️ ${opts.auto ? "Auto-resumed" : "Resumed"}: ${m.name}`.slice(0, 256))
    .setColor(0x2ecc71)
    .setDescription(
      members.length > 0
        ? `Uptime Kuma is checking this group again, with ${members.length} monitor${members.length === 1 ? "" : "s"} in it.`
        : "Uptime Kuma is checking this monitor again.",
    )
    .setTimestamp();
  if (opts.userId) embed.addFields({ name: "By", value: `<@${opts.userId}>`, inline: true });
  if (rec) {
    embed.addFields({ name: "Paused by", value: `<@${rec.pausedById}>`, inline: true });
    embed.addFields({ name: "Paused for", value: formatDuration(Date.now() - rec.pausedAt), inline: true });
    if (rec.reason) embed.addFields({ name: "Reason", value: rec.reason.slice(0, 1024) });
  }
  if (out.failed.length > 0) {
    embed.addFields({
      name: "Could not resume",
      value: out.failed.map((f) => `${f.monitor.name}: ${f.msg}`).join("\n").slice(0, 1024),
    });
  }
  if (out.stillPausedGroup) {
    embed.addFields({
      name: "Note",
      value: `Its group **${out.stillPausedGroup.name}** is still paused, so it stays silent until the group is resumed.`,
    });
  }
  return embed;
}

/** Lines for /paused: every paused monitor, with who, until when and why. */
export function pausedLines(monitors: Map<number, KumaMonitor>, records: PauseRecord[]): string[] {
  const byId = new Map(records.map((r) => [r.monitorId, r]));
  const paused = [...monitors.values()].filter((m) => !m.active);
  const pausedIds = new Set(paused.map((m) => m.id));
  const lines: string[] = [];
  const sorted = paused.sort((a, b) =>
    (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1) || a.name.localeCompare(b.name));
  for (const m of sorted) {
    const rec = byId.get(m.id);
    // Members paused with their group are listed under the group.
    if (rec?.groupId !== null && rec?.groupId !== undefined && pausedIds.has(rec.groupId)) continue;
    let line = `⏸️ **${m.name}**`;
    if (m.type === "group") {
      const n = records.filter((r) => r.groupId === m.id).length;
      line += ` (group${n > 0 ? `, ${n} monitor${n === 1 ? "" : "s"} paused with it` : ""})`;
    } else {
      const g = groupNameOf(monitors, m);
      if (g) line += ` · ${g}`;
    }
    if (rec) {
      line += rec.resumeAt ? ` - until ${discordTime(rec.resumeAt)}` : " - until `/resume`";
      line += ` · by <@${rec.pausedById}>`;
      if (rec.reason) line += ` · ${rec.reason.slice(0, 120)}`;
    } else {
      line += " - paused in Kuma (no schedule)";
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------

const SWEEP_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

async function announceChannel(client: Client, channelId: string | null): Promise<TextChannel | null> {
  const ids = [channelId, getSetting("ALERT_CHANNEL_ID"), getSetting("STATUS_CHANNEL_ID")].filter(
    (x): x is string => !!x,
  );
  for (const id of ids) {
    try {
      const ch = await client.channels.fetch(id) as TextChannel | null;
      if (ch?.isTextBased()) return ch;
    } catch {
      // try the next one
    }
  }
  return null;
}

async function sweep(client: Client): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    pruneStalePauses(kuma);
    await runAutoResume(Date.now(), kuma, async (rec, outcome) => {
      const ch = await announceChannel(client, rec.channelId);
      if (!ch) {
        logger.warn({ monitorId: rec.monitorId }, "No channel to announce the auto-resume in");
        return;
      }
      await ch.send({ embeds: [resumeEmbed(outcome, { auto: true })], allowedMentions: NO_MENTIONS });
    });
  } catch (err) {
    logger.error({ err }, "Pause sweep failed");
  } finally {
    sweeping = false;
  }
}

/** Start the auto-resume sweep (every 30 s, and right after each Kuma connect). */
export function startPauseScheduler(client: Client): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweep(client), SWEEP_MS);
  kuma.on("connected", () => {
    // Give Kuma a moment to push the monitor list after login.
    setTimeout(() => void sweep(client), 5_000);
  });
  const pending = listPauses().filter((r) => r.resumeAt !== null).length;
  if (pending > 0) logger.info({ pending }, "Timed monitor pauses loaded");
}

export function stopPauseScheduler(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
