/**
 * Global maintenance window: one switch that silences every alert the bot
 * raises, for a set time.
 *
 * `/maintenance start duration:2h reason:...` opens a window. Until it ends,
 * no Discord alert, @everyone ping, e-mail, Zammad ticket or phone call goes
 * out for Uptime Kuma, SiteGuard or the WordPress node agents. Every alert
 * held back is logged and counted. Monitoring itself keeps running, so state
 * stays current: when the window ends (on time, or early with
 * `/maintenance end`) a short summary goes to the alert channel, and whatever
 * is still down alerts normally from then on.
 *
 * The window is stored in the `maintenance_window` table of data/bot.db (as
 * per-site SiteGuard pauses are), so it survives a restart. A window past its
 * end time no longer silences anything, even before the sweep has closed it.
 *
 * This module is only the store, the gate and the Discord output; starting,
 * ending and the expiry sweep live in maintenanceRun.ts.
 */

import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { database, getSetting } from "../db/index.js";
import { logger } from "../util/logger.js";
import { discordTime, formatDuration } from "./monitorPauses.js";

/** Longest window accepted. A forgotten silence is worse than the outage it hides. */
export const MAX_MAINTENANCE_MS = 7 * 86_400_000;

export interface MaintenanceWindow {
  startedBy: string;
  startedById: string;
  reason: string | null;
  startedAt: number;
  /** Epoch ms of the automatic end. */
  endsAt: number;
  /** Channel the window was started from. */
  channelId: string | null;
  /** Alerts held back so far. */
  suppressed: number;
  /** The same, per kind of alert (e.g. "kuma-down": 3). */
  suppressedKinds: Record<string, number>;
}

// ---------------------------------------------------------------
// Store
// ---------------------------------------------------------------

interface Row {
  started_by: string;
  started_by_id: string;
  reason: string | null;
  started_at: number;
  ends_at: number;
  channel_id: string | null;
  suppressed: number;
  suppressed_kinds: string;
}

function parseKinds(raw: string): Record<string, number> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function fromRow(r: Row): MaintenanceWindow {
  return {
    startedBy: r.started_by,
    startedById: r.started_by_id,
    reason: r.reason,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    channelId: r.channel_id,
    suppressed: r.suppressed,
    suppressedKinds: parseKinds(r.suppressed_kinds),
  };
}

/** The stored window, expired or not (null when none is open). */
export function getMaintenance(): MaintenanceWindow | null {
  const row = database().prepare("SELECT * FROM maintenance_window WHERE id = 1").get() as Row | undefined;
  return row ? fromRow(row) : null;
}

export function saveMaintenance(w: MaintenanceWindow): void {
  database()
    .prepare(
      `INSERT OR REPLACE INTO maintenance_window
         (id, started_by, started_by_id, reason, started_at, ends_at, channel_id, suppressed, suppressed_kinds)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(w.startedBy, w.startedById, w.reason, w.startedAt, w.endsAt, w.channelId, w.suppressed, JSON.stringify(w.suppressedKinds));
}

/** Close the window; returns it as it was (null when none was open). */
export function clearMaintenance(): MaintenanceWindow | null {
  const w = getMaintenance();
  if (w) database().prepare("DELETE FROM maintenance_window WHERE id = 1").run();
  return w;
}

// ---------------------------------------------------------------
// Gate
// ---------------------------------------------------------------

/** True while a maintenance window is open (an expired one no longer counts). */
export function isMaintenanceActive(now = Date.now()): boolean {
  const w = getMaintenance();
  return !!w && w.endsAt > now;
}

/**
 * Call where an alert is about to go out. During a window it records the
 * alert as suppressed (log line + counter) and returns true: the caller must
 * then not send it. Outside a window it returns false and does nothing.
 */
export function suppressedByMaintenance(kind: string, detail: Record<string, unknown> = {}, now = Date.now()): boolean {
  const w = getMaintenance();
  if (!w || w.endsAt <= now) return false;
  const kinds = { ...w.suppressedKinds, [kind]: (w.suppressedKinds[kind] ?? 0) + 1 };
  database()
    .prepare("UPDATE maintenance_window SET suppressed = suppressed + 1, suppressed_kinds = ? WHERE id = 1")
    .run(JSON.stringify(kinds));
  logger.info({ kind, ...detail, endsAt: new Date(w.endsAt).toISOString() }, "Alert suppressed: maintenance window");
  return true;
}

// ---------------------------------------------------------------
// Discord output
// ---------------------------------------------------------------

const KIND_LABELS: Record<string, string> = {
  "kuma-down": "Kuma down",
  "kuma-recovery": "Kuma recovery",
  "kuma-disconnect": "Kuma disconnected",
  "kuma-reconnect": "Kuma reconnected",
  "kuma-stale": "Kuma data stale",
  "kuma-fresh": "Kuma data fresh",
  "sg-site-down": "SiteGuard site down",
  "sg-site-recovery": "SiteGuard recovery",
  "sg-ssl": "SiteGuard SSL",
  "sg-unreachable": "WordPress unreachable",
  "sg-reachable": "WordPress reachable",
  "sg-data-stale": "SiteGuard data stale",
  "sg-data-fresh": "SiteGuard data fresh",
  "sg-failover": "Failover notice",
  "wpops": "WordPress ops",
};

/** "12 (Kuma down 5, Kuma recovery 4, SiteGuard site down 3)". */
export function suppressedText(w: Pick<MaintenanceWindow, "suppressed" | "suppressedKinds">): string {
  if (w.suppressed === 0) return "0";
  const parts = Object.entries(w.suppressedKinds)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n}`);
  return `${w.suppressed}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

const SILENCED = "No alerts, @everyone pings, e-mails, tickets or phone calls go out for Uptime Kuma, SiteGuard or the WordPress nodes. Monitoring keeps running.";

/** Public notice that a window started (or had its end time / reason changed). */
export function maintenanceStartEmbed(w: MaintenanceWindow, opts: { updated?: boolean; userId?: string } = {}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(opts.updated ? "🛠️ Maintenance window updated" : "🛠️ Maintenance window started")
    .setColor(0xf1c40f)
    .setDescription(`${SILENCED} Anything still down when it ends alerts normally.`)
    .addFields(
      { name: "By", value: `<@${opts.userId ?? w.startedById}>`, inline: true },
      { name: "Until", value: `${discordTime(w.endsAt)}, then ends automatically`, inline: true },
      { name: "Reason", value: (w.reason || "not given").slice(0, 1024) },
    )
    .setFooter({ text: "/maintenance end to finish early" })
    .setTimestamp();
  return embed;
}

/** The one summary posted when a window ends. */
export function maintenanceEndEmbed(
  w: MaintenanceWindow,
  opts: { auto: boolean; userId?: string; now: number; stillDown: string[] },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(opts.auto ? "✅ Maintenance window ended" : "✅ Maintenance window ended early")
    .setColor(opts.stillDown.length > 0 ? 0xe67e22 : 0x2ecc71)
    .setDescription("Alerts and phone calls are active again.")
    .addFields(
      { name: "Ended", value: `<t:${Math.floor(opts.now / 1000)}:f>${opts.userId ? ` by <@${opts.userId}>` : " (on schedule)"}`, inline: true },
      { name: "Lasted", value: formatDuration(opts.now - w.startedAt), inline: true },
      { name: "Started by", value: `<@${w.startedById}>`, inline: true },
      { name: "Reason", value: (w.reason || "not given").slice(0, 1024) },
      { name: "Alerts suppressed", value: suppressedText(w).slice(0, 1024) },
    )
    .setTimestamp(opts.now);
  if (opts.stillDown.length > 0) {
    let list = opts.stillDown.slice(0, 15).join(", ");
    if (opts.stillDown.length > 15) list += `, +${opts.stillDown.length - 15} more`;
    embed.addFields({ name: `Still down (${opts.stillDown.length}), alerting normally now`, value: list.slice(0, 1024) });
  }
  return embed;
}

/** `/maintenance status`. */
export function maintenanceStatusEmbed(w: MaintenanceWindow | null, now = Date.now()): EmbedBuilder {
  if (!w || w.endsAt <= now) {
    return new EmbedBuilder()
      .setTitle("Maintenance window")
      .setColor(0x2ecc71)
      .setDescription(
        w
          ? "**Ending now.** The window's time is up; the summary is being posted."
          : "**None active.** Alerts and phone calls go out normally.",
      );
  }
  return new EmbedBuilder()
    .setTitle("🛠️ Maintenance window active")
    .setColor(0xf1c40f)
    .setDescription(SILENCED)
    .addFields(
      { name: "Started by", value: `<@${w.startedById}>`, inline: true },
      { name: "Started", value: `<t:${Math.floor(w.startedAt / 1000)}:f>`, inline: true },
      { name: "Ends", value: discordTime(w.endsAt), inline: true },
      { name: "Reason", value: (w.reason || "not given").slice(0, 1024) },
      { name: "Alerts suppressed so far", value: suppressedText(w).slice(0, 1024) },
    );
}

/** One line for the status board while a window is open ("" otherwise). */
export function maintenanceBanner(now = Date.now()): string {
  const w = getMaintenance();
  if (!w || w.endsAt <= now) return "";
  const reason = w.reason ? ` - ${w.reason.slice(0, 100)}` : "";
  return `🛠️ **MAINTENANCE WINDOW - alerts and calls paused until <t:${Math.floor(w.endsAt / 1000)}:t> (<t:${Math.floor(w.endsAt / 1000)}:R>)**${reason}`;
}

/** The alert channel: the Kuma alert channel, then the SiteGuard one, then the status board. */
export async function maintenanceChannel(client: Client): Promise<TextChannel | null> {
  const ids = [getSetting("ALERT_CHANNEL_ID"), getSetting("SG_ALERT_CHANNEL_ID"), getSetting("STATUS_CHANNEL_ID")]
    .filter((x): x is string => !!x);
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
