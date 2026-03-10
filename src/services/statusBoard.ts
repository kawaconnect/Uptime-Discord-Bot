/**
 * Status board - persistent message showing all monitor states.
 * Refreshes every 15 seconds. Period.
 *
 * If heartbeats are stale (>90s), forces a reconnect on every refresh
 * cycle until data flows again.
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

  if (kuma.monitors.size === 0 && !kuma.connected) {
    logger.info("Skipping board update - no data and not connected");
    return;
  }

  const channel = await client.channels.fetch(channelId) as TextChannel | null;
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
    } catch {
      logger.info("Status board message missing, creating new one");
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
  const summary = kuma.getSummary();

  const groups = new Map<number | null, KumaMonitor[]>();
  for (const [, monitor] of monitors) {
    const parentId = monitor.parent ?? null;
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId)!.push(monitor);
  }

  const lines: string[] = [];
  const topLevel = groups.get(null) ?? [];
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  for (const monitor of topLevel) {
    const children = groups.get(monitor.id);
    if (children && children.length > 0) {
      lines.push(`\n**${monitor.name}**`);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        lines.push(formatMonitorLine(child, latestStatus));
      }
    } else if (monitor.type !== "group") {
      lines.push(formatMonitorLine(monitor, latestStatus));
    }
  }

  let description = lines.join("\n");
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n*... and more (${monitors.size} total)*`;
  }
  if (description.length === 0) {
    description = "No monitors configured.";
  }

  let color = 0x2ecc71;
  if (summary.down > 0) color = 0xe74c3c;
  else if (summary.pending > 0) color = 0xf39c12;
  else if (summary.maintenance > 0) color = 0x3498db;

  const stale = kuma.heartbeatStale;
  if (stale) color = 0xff6600;

  const headerParts: string[] = [
    `${statusEmoji(MonitorStatus.UP)} **${summary.up}** up`,
  ];
  if (summary.down > 0) headerParts.push(`${statusEmoji(MonitorStatus.DOWN)} **${summary.down}** down`);
  if (summary.pending > 0) headerParts.push(`${statusEmoji(MonitorStatus.PENDING)} **${summary.pending}** pending`);
  if (summary.maintenance > 0) headerParts.push(`${statusEmoji(MonitorStatus.MAINTENANCE)} **${summary.maintenance}** maintenance`);
  if (summary.paused > 0) headerParts.push(`\u23F8\uFE0F **${summary.paused}** paused`);

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

  let staleWarning = "";
  if (stale) {
    const staleSecs = kuma.heartbeatStalenessSeconds;
    const staleStr = staleSecs > 120
      ? `${Math.floor(staleSecs / 60)}m ${staleSecs % 60}s`
      : `${staleSecs}s`;
    staleWarning = `\n\n\u26A0\uFE0F **Data may be stale** - no heartbeat from Kuma in ${staleStr}. Reconnecting...`;
  }

  return new EmbedBuilder()
    .setTitle(`Service Status (${summary.up}/${summary.total - summary.paused})`)
    .setDescription(`${headerParts.join("  |  ")}\n${description}${timeLines}${staleWarning}`)
    .setColor(color)
    .setFooter({ text: stale ? "Data may be stale - reconnecting to Kuma" : "Refreshes every 15s" });
}

function formatMonitorLine(monitor: KumaMonitor, latestStatus: Map<number, number>): string {
  if (!monitor.active) {
    return `\u23F8\uFE0F ${monitor.name} - *paused*`;
  }
  const status = latestStatus.get(monitor.id);
  const emoji = status !== undefined ? statusEmoji(status) : "\u26AA";
  const label = status !== undefined ? statusLabel(status) : "UNKNOWN";
  const ping = kuma.avgPing.get(monitor.id);
  const pingStr = ping !== undefined && ping > 0 ? ` (${Math.round(ping)}ms)` : "";
  return `${emoji} ${monitor.name} - ${label}${pingStr}`;
}
