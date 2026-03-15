/**
 * Kuma alert system - Discord alerts + optional email for:
 * - Connection to Uptime Kuma lost (30s grace period)
 * - Data stale (watchdog detected silent failure - immediate)
 * - Data recovered after stale period
 * - Monitor goes DOWN
 * - Monitor recovers (UP after DOWN)
 *
 * Each alert type can be toggled via /setup alerts-toggle.
 * @everyone and email are independently configurable (default: both OFF for Kuma).
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
import { isSmtpConfigured, sendAlertEmail } from "./email.js";

const ALERT_CHANNEL_KEY = "ALERT_CHANNEL_ID";
const DISCONNECT_GRACE_MS = 30_000;

let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wasDisconnected = false;

function isEnabled(type: string): boolean {
  return getSetting(`ALERT_${type.toUpperCase()}_ENABLED`) !== "false";
}

/** Whether @everyone mentions are enabled for Kuma alerts. Default: false. */
function isMentionEnabled(): boolean {
  return getSetting("KUMA_ALERT_MENTION_ENABLED") === "true";
}

/** Whether email alerts are enabled for Kuma alerts. Default: false. */
function isEmailEnabled(): boolean {
  return getSetting("KUMA_ALERT_EMAIL_ENABLED") === "true";
}

export function startAlerts(client: Client): void {
  // ---- Connection loss (socket-level disconnect) ----
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
      sendReconnectedAlert(client).catch((err) =>
        logger.error({ err }, "Failed to send reconnected alert")
      );
    }
  });

  // ---- Data staleness (silent failure - the most dangerous kind) ----
  kuma.on("dataStale", (stalenessMs: number) => {
    if (!isEnabled("disconnect")) return;
    sendStaleAlert(client, stalenessMs).catch((err) =>
      logger.error({ err }, "Failed to send stale data alert")
    );
  });

  kuma.on("dataFresh", () => {
    sendStaleRecoveredAlert(client).catch((err) =>
      logger.error({ err }, "Failed to send stale recovery alert")
    );
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

/** Get mention string based on config. */
function mention(): string {
  return isMentionEnabled() ? "@everyone" : "";
}

/** Send email if Kuma email alerts are enabled. */
function maybeEmail(subject: string, html: string): void {
  if (isEmailEnabled() && isSmtpConfigured()) {
    sendAlertEmail(subject, html).catch((err) =>
      logger.error({ err }, "Failed to send Kuma alert email")
    );
  }
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

  const content = mention();
  await discordQueue.add(async () => {
    await channel.send({ ...(content ? { content } : {}), embeds: [embed] });
  });
  logger.warn("Sent disconnect alert");

  maybeEmail(
    "[DISCONNECTED] Uptime Kuma",
    `<h2>Uptime Kuma Disconnected</h2><p>Lost connection for over 30 seconds.</p><p><b>Reason:</b> ${reason}</p>`
  );
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

  maybeEmail(
    "[RECONNECTED] Uptime Kuma",
    `<h2>Uptime Kuma Reconnected</h2><p>Status: ${summary.up}/${summary.active} services up</p>`
  );
}

async function sendStaleAlert(client: Client, stalenessMs: number): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const staleMin = Math.floor(stalenessMs / 60_000);
  const staleSec = Math.floor((stalenessMs % 60_000) / 1000);
  const staleStr = staleMin > 0 ? `${staleMin}m ${staleSec}s` : `${staleSec}s`;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F6A8} MONITORING DEGRADED - DATA STALE")
    .setDescription(
      `Uptime Kuma socket is connected but **stopped sending data** for **${staleStr}**.\n\n` +
      `**Impact:** Monitor statuses shown may be outdated. Outages may go undetected.\n` +
      `**Action:** Bot is forcing a full reconnect to restore data flow.\n` +
      `**Reconnect count:** ${kuma.reconnectCount}\n\n` +
      `If this keeps happening, check Uptime Kuma server health.`
    )
    .setColor(0xff6600)
    .setTimestamp(new Date());

  const content = mention();
  await discordQueue.add(async () => {
    await channel.send({ ...(content ? { content } : {}), embeds: [embed] });
  });
  logger.warn({ stalenessMs, reconnectCount: kuma.reconnectCount }, "Sent stale data alert");

  maybeEmail(
    "[STALE DATA] Uptime Kuma",
    `<h2>Monitoring Degraded - Data Stale</h2><p>No data for ${staleStr}. Reconnecting...</p>`
  );
}

async function sendStaleRecoveredAlert(client: Client): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;

  const summary = kuma.getSummary();
  const embed = new EmbedBuilder()
    .setTitle("\u{1F7E2} Monitoring Restored - Fresh Data")
    .setDescription(
      `Data flow from Uptime Kuma has been restored after a stale period.\n\n` +
      `**Status:** ${summary.up}/${summary.active} services up` +
      (summary.down > 0 ? `\n**\u{1F534} ${summary.down} service${summary.down > 1 ? "s" : ""} currently down**` : "") +
      `\n**Reconnect count:** ${kuma.reconnectCount}`
    )
    .setColor(summary.down > 0 ? 0xe74c3c : 0x2ecc71)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.info("Sent stale data recovery alert");

  maybeEmail(
    "[RESTORED] Uptime Kuma Data Flow",
    `<h2>Monitoring Restored</h2><p>Status: ${summary.up}/${summary.active} services up</p>`
  );
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

  const content = mention();
  await discordQueue.add(async () => {
    await channel.send({ ...(content ? { content } : {}), embeds: [embed] });
  });
  logger.warn({ monitorId: monitor.id, name: monitor.name, msg: heartbeat.msg }, "Sent DOWN alert");

  maybeEmail(
    `[DOWN] ${monitor.name}`,
    `<h2>${monitor.name} is DOWN</h2><p><b>Type:</b> ${monitor.type}</p><p><b>Target:</b> ${target}</p><p><b>Error:</b> ${heartbeat.msg || "No details"}</p>`
  );
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

  maybeEmail(
    `[RECOVERED] ${monitor.name}`,
    `<h2>${monitor.name} is back UP</h2><p><b>Response:</b> ${heartbeat.msg || "OK"}${ping}</p>`
  );
}
