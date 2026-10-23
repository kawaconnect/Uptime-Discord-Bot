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
 * During a maintenance window (/maintenance, see maintenance.ts) none of
 * these go out; each one held back is counted, and monitors still down when
 * the window ends are alerted then (realertKumaAfterMaintenance).
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
import { escapeHtml } from "../util/html.js";
import { mentionsFor, NO_MENTIONS } from "../util/mentions.js";
import { isSmtpConfigured, sendAlertEmail } from "./email.js";
import { isPhoneEscalationEnabled, markDown, markUp, reportActive, trackedKeys } from "./phone.js";
import { suppressedByMaintenance } from "./maintenance.js";

const ALERT_CHANNEL_KEY = "ALERT_CHANNEL_ID";
const DISCONNECT_GRACE_MS = 30_000;

/** How often we re-report still-down monitors to the PBX. */
const ESCALATION_TICK_MS = 60_000;
let escalationTimer: ReturnType<typeof setInterval> | null = null;

let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wasDisconnected = false;
/** Guard against double-registration of Kuma event listeners. */
let alertsStarted = false;
/** Monitors whose current outage has been announced (cleared on recovery). */
const downAnnounced = new Set<number>();

/** Stops the escalation sweep. Called on shutdown. */
export function stopAlerts(): void {
  if (escalationTimer) {
    clearInterval(escalationTimer);
    escalationTimer = null;
  }
}

/**
 * Reports every monitor that is still down to the PBX, and clears the ones
 * that recovered. Paused monitors, monitors inside a paused group, and
 * monitors in a maintenance window are all skipped - a deliberately silenced
 * location must never ring a phone.
 */
async function runEscalationSweep(): Promise<void> {
  if (!isPhoneEscalationEnabled()) return;
  if (!kuma.connected) return; // a dead socket is not evidence that sites are down

  const stillDown = new Set<string>();

  for (const { monitor } of kuma.getDownMonitors()) {
    if (kuma.isEffectivelyPaused(monitor.id)) continue;
    if (kuma.latestStatus.get(monitor.id) === MonitorStatus.MAINTENANCE) continue;

    const key = `kuma:monitor:${monitor.id}`;
    stillDown.add(key);
    markDown(key);
    await reportActive(key, `${monitor.name} is down.`, "uptime", "kuma-down");
  }

  for (const key of trackedKeys()) {
    if (key.startsWith("kuma:monitor:") && !stillDown.has(key)) {
      await markUp(key);
    }
  }
}

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
  if (alertsStarted) {
    logger.debug("Kuma alerts already started - skipping duplicate registration");
    return;
  }
  alertsStarted = true;

  // Phone escalation runs as a periodic sweep rather than off statusChange.
  // A monitor that was already down when the socket reconnected never emits
  // statusChange, so an event-driven check would silently miss exactly the
  // outages that have lasted longest.
  if (escalationTimer) clearInterval(escalationTimer);
  escalationTimer = setInterval(() => {
    runEscalationSweep().catch((err) =>
      logger.error({ err }, "Phone escalation sweep failed"),
    );
  }, ESCALATION_TICK_MS);

  // ---- Connection loss (socket-level disconnect) ----
  kuma.on("disconnected", (reason) => {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      wasDisconnected = true;
      if (!isEnabled("disconnect")) return;
      if (suppressedByMaintenance("kuma-disconnect", { reason })) return;
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
      if (suppressedByMaintenance("kuma-reconnect")) return;
      sendReconnectedAlert(client).catch((err) =>
        logger.error({ err }, "Failed to send reconnected alert")
      );
    }
  });

  // ---- Data staleness (silent failure - the most dangerous kind) ----
  kuma.on("dataStale", (stalenessMs: number) => {
    if (!isEnabled("disconnect")) return;
    if (suppressedByMaintenance("kuma-stale", { stalenessMs })) return;
    sendStaleAlert(client, stalenessMs).catch((err) =>
      logger.error({ err }, "Failed to send stale data alert")
    );
  });

  kuma.on("dataFresh", () => {
    if (suppressedByMaintenance("kuma-fresh")) return;
    sendStaleRecoveredAlert(client).catch((err) =>
      logger.error({ err }, "Failed to send stale recovery alert")
    );
  });

  // ---- Monitor status changes ----
  kuma.on("statusChange", (monitor: KumaMonitor, heartbeat: KumaHeartbeat, previousStatus: number | undefined) => {
    if (heartbeat.status === MonitorStatus.UP) downAnnounced.delete(monitor.id);
    if (heartbeat.status === MonitorStatus.DOWN && isEnabled("down")) {
      markDown(`kuma:monitor:${monitor.id}`);
      if (suppressedByMaintenance("kuma-down", { monitorId: monitor.id, name: monitor.name })) return;
      sendDownAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err, monitorId: monitor.id }, "Failed to send down alert")
      );
    } else if (heartbeat.status === MonitorStatus.UP && previousStatus === MonitorStatus.DOWN && isEnabled("recovery")) {
      markUp(`kuma:monitor:${monitor.id}`).catch(() => undefined);
      if (suppressedByMaintenance("kuma-recovery", { monitorId: monitor.id, name: monitor.name })) return;
      sendRecoveryAlert(client, monitor, heartbeat).catch((err) =>
        logger.error({ err, monitorId: monitor.id }, "Failed to send recovery alert")
      );
    }
  });
}

async function getAlertChannel(client: Client): Promise<TextChannel | null> {
  // An alert must always land somewhere: fall back to the status-board channel
  // when no dedicated alert channel has been configured, instead of dropping it.
  const channelId = getSetting(ALERT_CHANNEL_KEY) ?? getSetting("SG_ALERT_CHANNEL_ID") ?? getSetting("STATUS_CHANNEL_ID");
  if (!channelId) {
    logger.error("No alert channel configured (run /setup alerts #channel) - Kuma alert DROPPED");
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
    await channel.send({ ...(content ? { content } : {}), embeds: [embed], allowedMentions: mentionsFor(content) });
  });
  logger.warn("Sent disconnect alert");

  maybeEmail(
    "[DISCONNECTED] Uptime Kuma",
    `<h2>Uptime Kuma Disconnected</h2><p>Lost connection for over 30 seconds.</p><p><b>Reason:</b> ${escapeHtml(reason)}</p>`
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
    await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  });
  logger.info("Sent reconnected alert");

  maybeEmail(
    "[RECONNECTED] Uptime Kuma",
    `<h2>Uptime Kuma Reconnected</h2><p>Status: ${escapeHtml(summary.up)}/${escapeHtml(summary.active)} services up</p>`
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
    await channel.send({ ...(content ? { content } : {}), embeds: [embed], allowedMentions: mentionsFor(content) });
  });
  logger.warn({ stalenessMs, reconnectCount: kuma.reconnectCount }, "Sent stale data alert");

  maybeEmail(
    "[STALE DATA] Uptime Kuma",
    `<h2>Monitoring Degraded - Data Stale</h2><p>No data for ${escapeHtml(staleStr)}. Reconnecting...</p>`
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
    await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  });
  logger.info("Sent stale data recovery alert");

  maybeEmail(
    "[RESTORED] Uptime Kuma Data Flow",
    `<h2>Monitoring Restored</h2><p>Status: ${escapeHtml(summary.up)}/${escapeHtml(summary.active)} services up</p>`
  );
}

/** Monitors that are down and would alert: active, not in a paused group, not in a Kuma maintenance. */
export function alertableDownMonitors(): KumaMonitor[] {
  return kuma.getDownMonitors()
    .map(({ monitor }) => monitor)
    .filter((m) => !kuma.isEffectivelyPaused(m.id) && kuma.latestStatus.get(m.id) !== MonitorStatus.MAINTENANCE);
}

/**
 * After a maintenance window: alert every monitor still down whose outage was
 * not announced (it went down during the window, or before a restart), as a
 * normal down alert. If Uptime Kuma has been unreachable for longer than the
 * disconnect grace, the disconnect alert goes out instead. Returns the number of alerts sent.
 */
export async function realertKumaAfterMaintenance(client: Client): Promise<number> {
  if (!kuma.connected) {
    // Only once the 30 s grace has passed; a shorter blip is still covered by
    // the running grace timer, which alerts normally now the window is over.
    if (!wasDisconnected || !isEnabled("disconnect")) return 0;
    await sendDisconnectAlert(client, "still disconnected when the maintenance window ended");
    return 1;
  }
  if (!isEnabled("down")) return 0;
  let n = 0;
  for (const monitor of alertableDownMonitors()) {
    if (downAnnounced.has(monitor.id)) continue;
    markDown(`kuma:monitor:${monitor.id}`);
    await sendDownAlert(client, monitor, {
      monitorID: monitor.id,
      status: MonitorStatus.DOWN,
      time: new Date().toISOString(),
      msg: "Still down when the maintenance window ended",
      ping: null,
      important: true,
    });
    n++;
  }
  return n;
}

async function sendDownAlert(client: Client, monitor: KumaMonitor, heartbeat: KumaHeartbeat): Promise<void> {
  const channel = await getAlertChannel(client);
  if (!channel) return;
  downAnnounced.add(monitor.id);

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
    await channel.send({ ...(content ? { content } : {}), embeds: [embed], allowedMentions: mentionsFor(content) });
  });
  logger.warn({ monitorId: monitor.id, name: monitor.name, msg: heartbeat.msg }, "Sent DOWN alert");

  maybeEmail(
    `[DOWN] ${monitor.name}`,
    `<h2>${escapeHtml(monitor.name)} is DOWN</h2><p><b>Type:</b> ${escapeHtml(monitor.type)}</p><p><b>Target:</b> ${escapeHtml(target)}</p><p><b>Error:</b> ${escapeHtml(heartbeat.msg || "No details")}</p>`
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
    await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  });
  logger.info({ monitorId: monitor.id, name: monitor.name }, "Sent recovery alert");

  maybeEmail(
    `[RECOVERED] ${monitor.name}`,
    `<h2>${escapeHtml(monitor.name)} is back UP</h2><p><b>Response:</b> ${escapeHtml(heartbeat.msg || "OK")}${escapeHtml(ping)}</p>`
  );
}
