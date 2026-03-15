/**
 * SiteGuard alert system - sends Discord alerts for:
 * - Site goes DOWN (@everyone)
 * - Site recovers (UP after DOWN)
 * - SSL certificate expiring soon
 * - WordPress endpoint unreachable (@everyone)
 * - WordPress endpoint reachable again
 *
 * Each alert type can be toggled via /sg-setup alerts-toggle.
 * Completely independent from Uptime Kuma alerts.
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting } from "../db/index.js";
import { siteguard, sgStatusEmoji, type SgSite } from "./siteguard.js";
import { discordQueue } from "../queue/index.js";

const SG_ALERT_CHANNEL_KEY = "SG_ALERT_CHANNEL_ID";

function isSgEnabled(type: string): boolean {
  return getSetting(`SG_ALERT_${type.toUpperCase()}_ENABLED`) !== "false";
}

async function getSgAlertChannel(client: Client): Promise<TextChannel | null> {
  const channelId = getSetting(SG_ALERT_CHANNEL_KEY);
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId) as TextChannel | null;
    if (channel?.isTextBased()) return channel;
  } catch {
    logger.warn({ channelId }, "SiteGuard alert channel not found");
  }
  return null;
}

export function startSgAlerts(client: Client): void {
  // ---- Site goes DOWN ----
  siteguard.on("siteDown", (site: SgSite) => {
    if (!isSgEnabled("SITE_DOWN")) return;
    sendSiteDownAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG site down alert")
    );
  });

  // ---- Site recovers ----
  siteguard.on("siteRecovery", (site: SgSite) => {
    if (!isSgEnabled("SITE_RECOVERY")) return;
    sendSiteRecoveryAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG recovery alert")
    );
  });

  // ---- SSL expiring ----
  siteguard.on("sslExpiring", (site: SgSite) => {
    if (!isSgEnabled("SSL_EXPIRING")) return;
    sendSslExpiringAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG SSL alert")
    );
  });

  // ---- WordPress unreachable ----
  siteguard.on("unreachable", (errorMsg: string) => {
    if (!isSgEnabled("WP_UNREACHABLE")) return;
    sendUnreachableAlert(client, errorMsg).catch((err) =>
      logger.error({ err }, "Failed to send SG unreachable alert")
    );
  });

  // ---- WordPress reachable again ----
  siteguard.on("reachable", () => {
    sendReachableAlert(client).catch((err) =>
      logger.error({ err }, "Failed to send SG reachable alert")
    );
  });

  logger.info("SiteGuard alerts started");
}

async function sendSiteDownAlert(client: Client, site: SgSite): Promise<void> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("down")} ${site.domain} is DOWN`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**HTTP Code:** ${site.http_code || "N/A"}\n` +
      `**Error:** ${site.error || "No response"}\n` +
      `**Response Time:** ${Math.round(site.response_time * 1000)}ms\n` +
      `**Consecutive Failures:** ${site.consecutive_failures ?? 1}\n` +
      `**Detected:** <t:${site.last_check}:R>`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date(site.last_check * 1000));

  await discordQueue.add(async () => {
    await channel.send({ content: "@everyone", embeds: [embed] });
  });
  logger.warn({ domain: site.domain, error: site.error }, "Sent SG site DOWN alert");
}

async function sendSiteRecoveryAlert(client: Client, site: SgSite): Promise<void> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("operational")} ${site.domain} is back UP`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**HTTP Code:** ${site.http_code}\n` +
      `**Response Time:** ${Math.round(site.response_time * 1000)}ms\n` +
      `**Recovered:** <t:${site.last_check}:R>`
    )
    .setColor(0x2ecc71)
    .setTimestamp(new Date(site.last_check * 1000));

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.info({ domain: site.domain }, "Sent SG recovery alert");
}

async function sendSslExpiringAlert(client: Client, site: SgSite): Promise<void> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`\u26A0\uFE0F SSL Certificate Expiring - ${site.domain}`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**Days Remaining:** ${site.ssl_expiry_days}\n` +
      `**Issuer:** ${site.ssl_issuer || "Unknown"}\n\n` +
      `Renew the certificate before it expires to avoid downtime.`
    )
    .setColor(0xf39c12)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.warn({ domain: site.domain, daysLeft: site.ssl_expiry_days }, "Sent SG SSL expiring alert");
}

async function sendUnreachableAlert(client: Client, errorMsg: string): Promise<void> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F6A8} WORDPRESS UNREACHABLE")
    .setDescription(
      `Cannot reach the SiteGuard health endpoint.\n\n` +
      `**Error:** ${errorMsg}\n` +
      `**Impact:** All site health data is stale - outages may go undetected.\n\n` +
      `Check the WordPress server and SiteGuard plugin immediately.`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ content: "@everyone", embeds: [embed] });
  });
  logger.warn({ error: errorMsg }, "Sent SG WordPress unreachable alert");
}

async function sendReachableAlert(client: Client): Promise<void> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return;

  const summary = siteguard.getSummary();
  const embed = new EmbedBuilder()
    .setTitle("\u{1F7E2} WordPress Connection Restored")
    .setDescription(
      `SiteGuard health endpoint is reachable again.\n\n` +
      `**Status:** ${summary.operational}/${summary.total} sites operational` +
      (summary.down > 0 ? `\n**\u{1F534} ${summary.down} site${summary.down > 1 ? "s" : ""} currently down**` : "")
    )
    .setColor(summary.down > 0 ? 0xe74c3c : 0x2ecc71)
    .setTimestamp(new Date());

  await discordQueue.add(async () => {
    await channel.send({ embeds: [embed] });
  });
  logger.info("Sent SG WordPress reachable alert");
}
