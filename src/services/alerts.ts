/**
 * Alert system - sends @everyone alerts when:
 * - Connection to Uptime Kuma is lost
 * - A monitor goes DOWN
 * - A monitor recovers (UP after being DOWN)
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting } from "../db/index.js";
import { kuma, MonitorStatus, statusEmoji, type KumaMonitor, type KumaHeartbeat } from "./kuma.js";
import { discordQueue } from "../queue/index.js";

const ALERT_CHANNEL_KEY = "ALERT_CHANNEL_ID";

let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
const DISCONNECT_GRACE_SECONDS = 30; // Wait 30s before alerting about disconnect

export function startAlerts(client: Client): void {
  // Connection loss alert
  kuma.on("disconnected", (reason) => {
    // Start a grace timer - don't alert on brief reconnects
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      sendDisconnectAlert(client, reason).catch((err) =>
        logger.error({ err }, "Failed to send disconnect alert")
      );
    }, DISCONNECT_GRACE_SECONDS * 1000);
  });

  kuma.on("connected", () => {
    // Cancel pending disconnect alert if we reconnected in time
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
      logger.info("Reconnected within grace period, no disconnect alert sent");
    }
  });

  // Monitor status change alerts
  kuma.on("statusChange", (monitor: KumaMonitor, heartbeat: KumaHeartbeat, previousStatus: number | undefined) => {
    if (heartbeat.status === MonitorStatus.DOWN) {
      sendDownAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err }, "Failed to send down alert")
      );
    } else if (heartbeat.status === MonitorStatus.UP && previousStatus === MonitorStatus.DOWN) {
      sendRecoveryAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err }, "Failed to send recovery alert")
      );
    }
  });
}

async function getAlertChannel(client: Client): Promise<TextChannel | null> {
  const channelId = getSetting(ALERT_CHANNEL_KEY);
  if (!channelId) {
    logger.debug("No alert channel configured (set via /setup alerts)");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId) as TextChannel | null;
    if (channel?.isTextBased()) return channel;
  } catch {
    logger.warn({ channelId }, "Alert channel not found");
  }
  return null;
}

async function sendDisconnectAlert(client: Client, reason: string): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F6A8} UPTIME KUMA DISCONNECTED")
    .setDescription(
      `Lost connection to Uptime Kuma.\n\n` +
      `**Reason:** ${reason}\n` +
      `**Impact:** Monitor status is unknown - services may be down without detection.\n\n` +
      `Check Uptime Kuma immediately.`
    )
    .setColor(0xe74c3c) // red
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({
      content: "@everyone",
      embeds: [embed],
    });
  });

  logger.warn("Sent disconnect alert to Discord");
}

async function sendDownAlert(client: Client, monitor: KumaMonitor, heartbeat: KumaHeartbeat): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(MonitorStatus.DOWN)} ${monitor.name} is DOWN`)
    .setDescription(
      `**Type:** ${monitor.type}\n` +
      `**URL:** ${monitor.url || monitor.hostname || "N/A"}\n` +
      `**Message:** ${heartbeat.msg || "No details"}\n` +
      `**Time:** <t:${Math.floor(new Date(heartbeat.time).getTime() / 1000)}:R>`
    )
    .setColor(0xe74c3c) // red
    .setTimestamp(new Date(heartbeat.time));

  await discordQueue.add(async () => {
    await channel.send({
      content: "@everyone",
      embeds: [embed],
    });
  });

  logger.warn({ monitorId: monitor.id, name: monitor.name }, "Sent DOWN alert");
}

async function sendRecoveryAlert(client: Client, monitor: KumaMonitor, heartbeat: KumaHeartbeat): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const ping = heartbeat.ping ? ` (${heartbeat.ping}ms)` : "";

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(MonitorStatus.UP)} ${monitor.name} is back UP`)
    .setDescription(
      `**Type:** ${monitor.type}\n` +
      `**URL:** ${monitor.url || monitor.hostname || "N/A"}\n` +
      `**Message:** ${heartbeat.msg || "OK"}${ping}\n` +
      `**Recovered:** <t:${Math.floor(new Date(heartbeat.time).getTime() / 1000)}:R>`
    )
    .setColor(0x2ecc71) // green
    .setTimestamp(new Date(heartbeat.time));

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });

  logger.info({ monitorId: monitor.id, name: monitor.name }, "Sent recovery alert");
}
