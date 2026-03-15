/**
 * Unified status board - persistent message showing both Uptime Kuma monitors
 * AND SiteGuard WordPress site health in a single embed.
 *
 * Refreshes every 15 seconds. If heartbeats are stale (>90s), forces a
 * reconnect on every refresh cycle until data flows again.
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
  Message,
  Events,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { kuma, MonitorStatus, statusEmoji, statusLabel, type KumaMonitor } from "./kuma.js";
import { siteguard, sgStatusEmoji, SgStatus, type SgSite } from "./siteguard.js";
import { discordQueue } from "../queue/index.js";

const STATUS_CHANNEL_KEY = "STATUS_CHANNEL_ID";
const STATUS_MSG_KEY = "STATUS_MESSAGE_ID";

/** Refresh the board every 15 seconds no matter what. */
const REFRESH_INTERVAL_MS = 15_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let needsReanchor = false;
/** Mutex - prevents concurrent updateStatusBoard calls from racing. */
let updating = false;

export function startStatusBoard(client: Client): void {
  // Status changes get an immediate update
  kuma.on("statusChange", () => {
    logger.info("statusChange event - immediate board update");
    updateStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed to update status board on status change")
    );
  });

  // Reconnect = immediate update after data arrives
  kuma.on("connected", () => {
    logger.info("Kuma connected - scheduling board update in 5s");
    setTimeout(() => {
      updateStatusBoard(client).catch((err) =>
        logger.warn({ err }, "Failed to update status board after reconnect")
      );
    }, 5_000);
  });

  // SiteGuard data updates trigger board refresh too
  siteguard.on("updated", () => {
    updateStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed to update status board on SiteGuard update")
    );
  });

  // Watch for messages in status channel - flag for re-anchor
  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot) return;
    const channelId = getSetting(STATUS_CHANNEL_KEY);
    if (!channelId || msg.channelId !== channelId) return;
    needsReanchor = true;
  });

  // MAIN LOOP: refresh every 15 seconds unconditionally
  refreshTimer = setInterval(() => {
    // If heartbeats are stale, force reconnect to get fresh data
    if (kuma.heartbeatStale && kuma.connected) {
      const staleSec = kuma.heartbeatStalenessSeconds;
      logger.warn({ staleSec }, "Heartbeats stale on refresh - forcing reconnect");
      kuma.forceReconnect();
      // Don't update board this cycle - let reconnect populate data first
      return;
    }

    updateStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed periodic status board refresh")
    );
  }, REFRESH_INTERVAL_MS);

  logger.info({ refreshMs: REFRESH_INTERVAL_MS }, "Status board started - refreshing every 15s");
}

export function stopStatusBoard(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export async function updateStatusBoard(client: Client): Promise<void> {
  // Mutex - if another update is in progress, skip to avoid creating duplicate messages
  if (updating) {
    logger.info("Skipping board update - another update in progress");
    return;
  }
  updating = true;

  try {
    await doUpdateStatusBoard(client);
  } finally {
    updating = false;
  }
}

async function doUpdateStatusBoard(client: Client): Promise<void> {
  const channelId = getSetting(STATUS_CHANNEL_KEY);
  if (!channelId) return;

  if (kuma.monitors.size === 0 && !kuma.connected && !siteguard.data) {
    logger.info("Skipping board update - no data from either source");
    return;
  }

  let channel: TextChannel | null;
  try {
    channel = await client.channels.fetch(channelId) as TextChannel | null;
  } catch (err: any) {
    const status = err?.status ?? err?.httpStatus ?? 0;
    if (status >= 500 || status === 0) {
      logger.warn({ err, channelId, status }, "Status board channel fetch failed (transient) - skipping cycle");
      return;
    }
    throw err;
  }
  if (!channel?.isTextBased()) {
    logger.warn({ channelId }, "Status board channel not found");
    return;
  }

  const summary = kuma.getSummary();
  logger.info(
    { up: summary.up, down: summary.down, total: summary.total, stale: kuma.heartbeatStale },
    "Updating status board"
  );

  const embed = buildStatusEmbed();
  const oldMsgId = getSetting(STATUS_MSG_KEY);

  if (oldMsgId) {
    try {
      const lastMessages = await channel.messages.fetch({ limit: 1, cache: false });
      const lastMsg = lastMessages.first();
      const isAtBottom = lastMsg?.id === oldMsgId;

      if (isAtBottom) {
        await discordQueue.add(async () => {
          await lastMsg!.edit({ embeds: [embed] });
        });
        needsReanchor = false;
        return;
      }

      // Not at bottom - delete and re-send
      logger.info("Re-anchoring status board to bottom");
      try {
        const oldMsg = await channel.messages.fetch(oldMsgId);
        await discordQueue.add(async () => { await oldMsg.delete(); });
      } catch {
        // Already deleted
      }
    } catch (err: any) {
      // Transient errors (503, 500, network) - do NOT fall through to create a new message.
      // Only treat 404/403 as "message gone".
      const status = err?.status ?? err?.httpStatus ?? 0;
      if (status >= 500 || status === 0) {
        logger.warn({ err, status, oldMsgId }, "Status board update failed (transient) - skipping to avoid duplicates");
        return;
      }
      logger.info({ status }, "Status board message missing, creating new one");
    }
  }

  needsReanchor = false;

  try {
    const msg = await discordQueue.add(async () =>
      channel.send({
        embeds: [embed],
        flags: 4096,
      } as any)
    ) as Message | undefined;

    if (msg) {
      setSetting(STATUS_MSG_KEY, msg.id);
    }
  } catch (err) {
    logger.error({ err }, "Failed to create status board message");
  }
}

function buildStatusEmbed(): EmbedBuilder {
  const monitors = kuma.monitors;
  const latestStatus = kuma.latestStatus;
  const kumaSummary = kuma.getSummary();
  const sgSummary = siteguard.getSummary();
  const hasSg = siteguard.data && siteguard.data.sites.length > 0;

  // ---- Kuma section ----
  const groups = new Map<number | null, KumaMonitor[]>();
  for (const [, monitor] of monitors) {
    const parentId = monitor.parent ?? null;
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId)!.push(monitor);
  }

  const kumaLines: string[] = [];
  const topLevel = groups.get(null) ?? [];
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  for (const monitor of topLevel) {
    const children = groups.get(monitor.id);
    if (children && children.length > 0) {
      kumaLines.push(`\n**${monitor.name}**`);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        kumaLines.push(formatMonitorLine(child, latestStatus));
      }
    } else if (monitor.type !== "group") {
      kumaLines.push(formatMonitorLine(monitor, latestStatus));
    }
  }

  // ---- SiteGuard section ----
  const sgLines: string[] = [];
  if (hasSg) {
    const sorted = [...siteguard.data!.sites].sort((a, b) => a.domain.localeCompare(b.domain));
    for (const site of sorted) {
      sgLines.push(formatSiteLine(site));
    }
  }

  // ---- Combined header ----
  const totalUp = kumaSummary.up + sgSummary.operational;
  const totalActive = (kumaSummary.total - kumaSummary.paused) + sgSummary.total;
  const totalDown = kumaSummary.down + sgSummary.down;

  const headerParts: string[] = [
    `${statusEmoji(MonitorStatus.UP)} **${totalUp}** up`,
  ];
  if (totalDown > 0) headerParts.push(`${statusEmoji(MonitorStatus.DOWN)} **${totalDown}** down`);
  if (kumaSummary.pending > 0) headerParts.push(`${statusEmoji(MonitorStatus.PENDING)} **${kumaSummary.pending}** pending`);
  if (kumaSummary.maintenance > 0) headerParts.push(`${statusEmoji(MonitorStatus.MAINTENANCE)} **${kumaSummary.maintenance}** maintenance`);
  if (kumaSummary.paused > 0) headerParts.push(`\u23F8\uFE0F **${kumaSummary.paused}** paused`);
  if (sgSummary.degraded > 0) headerParts.push(`${sgStatusEmoji(SgStatus.DEGRADED)} **${sgSummary.degraded}** degraded`);

  // ---- Build description ----
  let description = headerParts.join("  |  ");

  // Kuma monitors
  if (kumaLines.length > 0) {
    description += "\n" + kumaLines.join("\n");
  } else if (monitors.size === 0 && kuma.connected) {
    description += "\n\nNo monitors configured.";
  }

  // SiteGuard section (separated)
  if (hasSg) {
    const sgHeader = [
      `${sgStatusEmoji(SgStatus.OPERATIONAL)} **${sgSummary.operational}** operational`,
    ];
    if (sgSummary.degraded > 0) sgHeader.push(`${sgStatusEmoji(SgStatus.DEGRADED)} **${sgSummary.degraded}** degraded`);
    if (sgSummary.down > 0) sgHeader.push(`${sgStatusEmoji(SgStatus.DOWN)} **${sgSummary.down}** down`);

    description += `\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
    description += `\n**WordPress Health (${sgSummary.operational}/${sgSummary.total})**`;
    description += `\n${sgHeader.join("  |  ")}`;
    description += "\n\n" + sgLines.join("\n");
  }

  // Truncate if too long
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n*... truncated*`;
  }

  // ---- Color ----
  let color = 0x2ecc71; // green
  if (totalDown > 0) color = 0xe74c3c; // red
  else if (kumaSummary.pending > 0 || sgSummary.degraded > 0) color = 0xf39c12; // orange
  else if (kumaSummary.maintenance > 0) color = 0x3498db; // blue

  const stale = kuma.heartbeatStale;
  if (stale) color = 0xff6600;
  if (hasSg && !siteguard.reachable) color = 0xff6600;

  // ---- Timestamps ----
  const now = new Date();
  const unixTs = Math.floor(now.getTime() / 1000);
  const tz = getSetting("TIMEZONE");
  let botTimeStr = "";
  if (tz) {
    try {
      botTimeStr = now.toLocaleString("en-US", { timeZone: tz, timeStyle: "short", dateStyle: "short" });
    } catch { /* ignore */ }
  }

  const timeLines = [
    `\n\nLast updated: <t:${unixTs}:T> (your time)`,
    botTimeStr ? `Bot time: **${botTimeStr}** (${tz})` : "",
  ].filter(Boolean).join("\n");

  let warnings = "";
  if (stale) {
    const staleSecs = kuma.heartbeatStalenessSeconds;
    const staleStr = staleSecs > 120
      ? `${Math.floor(staleSecs / 60)}m ${staleSecs % 60}s`
      : `${staleSecs}s`;
    warnings += `\n\n\u26A0\uFE0F **Kuma data may be stale** - no heartbeat in ${staleStr}. Reconnecting...`;
  }
  if (hasSg && !siteguard.reachable) {
    warnings += "\n\n\u26A0\uFE0F **WordPress endpoint unreachable** - SiteGuard data shown may be stale.";
  }

  description += timeLines + warnings;

  // ---- Footer ----
  const footerParts: string[] = [];
  if (kuma.connected) footerParts.push("Kuma");
  if (hasSg) {
    const checkedAgo = siteguard.data!.checked_at > 0
      ? `checked ${Math.floor((Date.now() / 1000 - siteguard.data!.checked_at) / 60)}m ago`
      : "";
    footerParts.push(`SiteGuard v${siteguard.data!.version}${checkedAgo ? ` (${checkedAgo})` : ""}`);
  }
  footerParts.push("Refreshes every 15s");
  if (stale) footerParts.push("Kuma data may be stale");

  return new EmbedBuilder()
    .setTitle(`Service Status (${totalUp}/${totalActive})`)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: footerParts.join(" | ") });
}

function formatMonitorLine(monitor: KumaMonitor, latestStatus: Map<number, number>): string {
  if (!monitor.active) {
    return `\u23F8\uFE0F ${monitor.name} - *paused*`;
  }
  const status = latestStatus.get(monitor.id);
  const emoji = status !== undefined ? statusEmoji(status) : "\u26AA";
  const label = status !== undefined ? statusLabel(status) : "UNKNOWN";
  const ping = kuma.latestPing.get(monitor.id) ?? kuma.avgPing.get(monitor.id);
  const pingStr = ping !== undefined && ping > 0 ? ` (${Math.round(ping)}ms)` : "";
  return `${emoji} ${monitor.name} - ${label}${pingStr}`;
}

function formatSiteLine(site: SgSite): string {
  const emoji = sgStatusEmoji(site.status);
  const responseMs = Math.round(site.response_time * 1000);
  const sslStr = site.ssl_expiry_days >= 0 ? `SSL: ${site.ssl_expiry_days}d` : "";
  const parts = [`${emoji} **${site.domain}**`, `${responseMs}ms`];
  if (sslStr) parts.push(sslStr);
  if (site.consecutive_failures > 1) parts.push(`\u{1F6A8} ${site.consecutive_failures} consecutive failures`);
  if (site.error) parts.push(`\u26A0 ${site.error}`);
  return parts.join(" - ");
}
