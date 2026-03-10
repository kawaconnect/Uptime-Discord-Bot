/**
 * Status board - a persistent message in a configured channel that shows
 * the current state of all monitors, auto-updated on every heartbeat.
 *
 * The message always stays at the bottom of the channel:
 *  - If the bot's message is already the last message, edit it in place.
 *  - If someone posts below it, delete the old one and re-send (silent).
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

let updateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUpdate = false;
let needsReanchor = false;

/**
 * Start listening for kuma events and auto-update the status board.
 * Debounces updates to avoid spamming Discord on rapid heartbeats.
 */
export function startStatusBoard(client: Client): void {
  kuma.on("heartbeat", () => {
    scheduleUpdate(client);
  });

  kuma.on("monitorListUpdated", () => {
    scheduleUpdate(client);
  });

  kuma.on("statusChange", () => {
    // Status changes get an immediate update
    updateStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed to update status board on status change")
    );
  });

  // Watch for new messages in the status channel - if someone posts below
  // the status message, flag it for re-anchoring on the next update.
  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot) return;
    const channelId = getSetting(STATUS_CHANNEL_KEY);
    if (!channelId || msg.channelId !== channelId) return;
    needsReanchor = true;
    scheduleUpdate(client);
  });
}

function scheduleUpdate(client: Client): void {
  if (pendingUpdate) return;
  pendingUpdate = true;

  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    pendingUpdate = false;
    updateStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed to update status board")
    );
  }, 10_000); // Debounce to 10 seconds
}

export async function updateStatusBoard(client: Client): Promise<void> {
  const channelId = getSetting(STATUS_CHANNEL_KEY);
  if (!channelId) return;

  if (!kuma.connected) {
    logger.debug("Skipping status board update - not connected to Kuma");
    return;
  }

  const channel = await client.channels.fetch(channelId) as TextChannel | null;
  if (!channel?.isTextBased()) {
    logger.warn({ channelId }, "Status board channel not found");
    return;
  }

  const embed = buildStatusEmbed();
  const oldMsgId = getSetting(STATUS_MSG_KEY);

  // Check if our message is already the last in the channel
  if (oldMsgId) {
    try {
      const lastMessages = await channel.messages.fetch({ limit: 1 });
      const lastMsg = lastMessages.first();
      const isAtBottom = lastMsg?.id === oldMsgId;

      if (isAtBottom) {
        // Already at the bottom - just edit in place
        const oldMsg = await channel.messages.fetch(oldMsgId);
        await discordQueue.add(async () => {
          await oldMsg.edit({ embeds: [embed] });
        });
        needsReanchor = false;
        return;
      }

      // Not at the bottom - delete and re-send
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
        flags: 4096, // SUPPRESS_NOTIFICATIONS - no beep
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

  // Group monitors by parent (groups) or flat
  const groups = new Map<number | null, KumaMonitor[]>();

  for (const [, monitor] of monitors) {
    const parentId = monitor.parent ?? null;
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId)!.push(monitor);
  }

  const lines: string[] = [];

  // Top-level monitors (no parent)
  const topLevel = groups.get(null) ?? [];
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  for (const monitor of topLevel) {
    // Check if this monitor is a group parent
    const children = groups.get(monitor.id);

    if (children && children.length > 0) {
      // Group header
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

  // Overall color: green if all up, red if any down, yellow if pending
  let color = 0x2ecc71; // green
  if (summary.down > 0) color = 0xe74c3c; // red
  else if (summary.pending > 0) color = 0xf39c12; // yellow
  else if (summary.maintenance > 0) color = 0x3498db; // blue

  const headerParts: string[] = [
    `${statusEmoji(MonitorStatus.UP)} **${summary.up}** up`,
  ];
  if (summary.down > 0) headerParts.push(`${statusEmoji(MonitorStatus.DOWN)} **${summary.down}** down`);
  if (summary.pending > 0) headerParts.push(`${statusEmoji(MonitorStatus.PENDING)} **${summary.pending}** pending`);
  if (summary.maintenance > 0) headerParts.push(`${statusEmoji(MonitorStatus.MAINTENANCE)} **${summary.maintenance}** maintenance`);
  if (summary.paused > 0) headerParts.push(`\u23F8\uFE0F **${summary.paused}** paused`);

  // Show both bot timezone and user's local time (Discord renders <t:> in viewer's tz)
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

  return new EmbedBuilder()
    .setTitle(`Service Status (${summary.up}/${summary.total - summary.paused})`)
    .setDescription(`${headerParts.join("  |  ")}\n${description}${timeLines}`)
    .setColor(color)
    .setFooter({ text: "Auto-updates on every heartbeat" });
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
