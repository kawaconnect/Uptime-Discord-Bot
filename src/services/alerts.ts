/**
 * Alert system - @everyone alerts for:
 * - Connection to Uptime Kuma lost (30s grace period)
 * - Monitor goes DOWN
 * - Monitor recovers (UP after DOWN)
 *
 * Each alert type can be toggled via /setup alerts-toggle.
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
const DISCONNECT_GRACE_MS = 30_000;

let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wasDisconnected = false;

function isEnabled(type: string): boolean {
  return getSetting(`ALERT_${type.toUpperCase()}_ENABLED`) !== "false";
}

export function startAlerts(client: Client): void {
  // ---- Connection loss ----
  kuma.on("disconnected", (reason) => {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      wasDisconnected = true;
      if (!isEnabled("disconnect")) return;
      sendDisconnectAlert(client, reason).catch((err) =>
        logger.error({ err }, "Failed to send disconnect alert")
      );
    }, DISCONNECT_GRACE_MS);
  });

  kuma.on("connected", () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (wasDisconnected) {
      wasDisconnected = false;
      // Send reconnected notice
      sendReconnectedAlert(client).catch((err) =>
        logger.error({ err }, "Failed to send reconnected alert")
      );
    }
  });

  // ---- Monitor status changes ----
  kuma.on("statusChange", (monitor: KumaMonitor, heartbeat: KumaHeartbeat, previousStatus: number | undefined) => {
    if (heartbeat.status === MonitorStatus.DOWN && isEnabled("down")) {
      sendDownAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err, monitorId: monitor.id }, "Failed to send down alert")
      );
    } else if (heartbeat.status === MonitorStatus.UP && previousStatus === MonitorStatus.DOWN && isEnabled("recovery")) {
      sendRecoveryAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err, monitorId: monitor.id }, "Failed to send recovery alert")
      );
    }
  });
}

async function getAlertChannel(client: Client): Promise<TextChannel | null> {
  const channelId = getSetting(ALERT_CHANNEL_KEY);
  if (!channelId) return null;

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
      `Lost connection to Uptime Kuma for over 30 seconds.\n\n` +
      `**Reason:** ${reason}\n` +
      `**Impact:** Monitor status is unknown - services may be down without detection.\n\n` +
      `Check Uptime Kuma immediately.`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ content: "@everyone", embeds: [embed] });
  });
  logger.warn("Sent disconnect alert");
}

async function sendReconnectedAlert(client: Client): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const summary = kuma.getSummary();
  const embed = new EmbedBuilder()
    .setTitle("\u{1F7E2} Uptime Kuma Reconnected")
    .setDescription(
      `Connection restored.\n\n` +
      `**Status:** ${summary.up}/${summary.active} services up` +
      (summary.down > 0 ? `\n**\u{1F534} ${summary.down} service${summary.down > 1 ? "s" : ""} currently down**` : "")
    )
    .setColor(summary.down > 0 ? 0xe74c3c : 0x2ecc71)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.info("Sent reconnected alert");
}

async function sendDownAlert(client: Client, monitor: KumaMonitor, heartbeat: KumaHeartbeat): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const target = monitor.url || monitor.hostname || "N/A";
  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(MonitorStatus.DOWN)} ${monitor.name} is DOWN`)
    .setDescription(
      `**Type:** ${monitor.type}\n` +
      `**Target:** ${target}\n` +
      `**Error:** ${heartbeat.msg || "No details"}\n` +
      `**Detected:** <t:${Math.floor(new Date(heartbeat.time).getTime() / 1000)}:R>`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date(heartbeat.time));

  await discordQueue.add(async () => {
    await channel.send({ content: "@everyone", embeds: [embed] });
  });
  logger.warn({ monitorId: monitor.id, name: monitor.name, msg: heartbeat.msg }, "Sent DOWN alert");
}

async function sendRecoveryAlert(client: Client, monitor: KumaMonitor, heartbeat: KumaHeartbeat): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const ping = heartbeat.ping ? ` (${heartbeat.ping}ms)` : "";
  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(MonitorStatus.UP)} ${monitor.name} is back UP`)
    .setDescription(
      `**Type:** ${monitor.type}\n` +
      `**Response:** ${heartbeat.msg || "OK"}${ping}\n` +
      `**Recovered:** <t:${Math.floor(new Date(heartbeat.time).getTime() / 1000)}:R>`
    )
    .setColor(0x2ecc71)
    .setTimestamp(new Date(heartbeat.time));

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.info({ monitorId: monitor.id, name: monitor.name }, "Sent recovery alert");
}
