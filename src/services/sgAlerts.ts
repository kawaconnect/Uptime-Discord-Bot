/**
 * SiteGuard alert system - Discord alerts + optional email + optional Zammad
 * ticket for:
 * - Site goes DOWN (@everyone by default) - also on the first poll after a
 *   restart when the site was not already known to be down
 * - Site recovers (UP after DOWN)
 * - SSL certificate expiring soon
 * - WordPress endpoint unreachable (@everyone by default)
 * - WordPress endpoint reachable again
 * - Health data stale (endpoint answers but WP cron has not checked sites)
 * - Repeat reminders while sites stay down / WordPress stays unreachable
 *
 * Delivery guarantees:
 * - Listeners are attached at startup (before the first poll) and are
 *   idempotent, so a failing first poll is still announced.
 * - When no SiteGuard alert channel is set, alerts fall back to the Kuma alert
 *   channel, then the status-board channel. An alert is never silently dropped
 *   for lack of configuration; if truly nothing is configured it is logged at
 *   error level.
 *
 * Each alert type can be toggled via /sg-setup alerts-toggle.
 * @everyone and email are independently configurable (default: both ON for SiteGuard).
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { env } from "../util/env.js";
import { getSetting } from "../db/index.js";
import { siteguard, sgStatusEmoji, type SgSite } from "./siteguard.js";
import { discordQueue } from "../queue/index.js";
import { isSmtpConfigured, sendAlertEmail } from "./email.js";
import {
  isTicketingConfigured,
  ticketMode,
  openIncidentTicket,
  resolveIncidentTicket,
  noteIncidentTicket,
  ticketUrl,
} from "./tickets.js";
import { isPhoneEscalationEnabled, markDown, markUp, reportActive } from "./phone.js";

const SG_ALERT_CHANNEL_KEY = "SG_ALERT_CHANNEL_ID";
const REMINDER_TICK_MS = 60_000;

function isSgEnabled(type: string): boolean {
  return getSetting(`SG_ALERT_${type.toUpperCase()}_ENABLED`) !== "false";
}

/** Whether @everyone mentions are enabled for SiteGuard alerts. Default: true. */
function isMentionEnabled(): boolean {
  return getSetting("SG_ALERT_MENTION_ENABLED") !== "false";
}

/** Whether email alerts are enabled for SiteGuard alerts. Default: true. */
function isEmailEnabled(): boolean {
  return getSetting("SG_ALERT_EMAIL_ENABLED") !== "false";
}

/** Whether Zammad API tickets may be opened for SiteGuard incidents. */
function isTicketsEnabled(): boolean {
  return getSetting("SG_ALERT_TICKETS_ENABLED") !== "false" && isTicketingConfigured() && ticketMode() !== "off";
}

/**
 * Deliver the incident to the helpdesk. The alert email to the support mailbox
 * IS the ticket; if SMTP is unconfigured or the relay rejects the message, open
 * the ticket through the Zammad API instead (mode "fallback"). Mode "always"
 * does both. Returns a Discord line describing where the ticket went.
 */
async function deliverIncident(incidentKey: string, subject: string, html: string): Promise<string> {
  const emailed = await maybeEmail(subject, html);
  const mode = ticketMode();
  const wantApi = isTicketsEnabled() && (mode === "always" || (mode === "fallback" && !emailed));
  let line = "";
  if (emailed) line += `\n**Ticket:** emailed to support`;
  if (wantApi) {
    const rec = await openIncidentTicket(incidentKey, subject, html);
    if (rec) line += `\n**Ticket:** #${rec.number} - ${ticketUrl(rec.id)}${emailed ? "" : " (email failed; opened via API)"}`;
    else if (!emailed) line += `\n\u26A0\uFE0F **Ticket could not be created** (email and API both failed - check SMTP relay and Zammad)`;
  } else if (!emailed) {
    line += isSmtpConfigured() ? `\n\u26A0\uFE0F **Alert email FAILED** - no ticket created` : `\n\u26A0\uFE0F **No SMTP configured** - no ticket created`;
  }
  if (!emailed) logger.error({ incidentKey, apiTicket: wantApi }, "Incident email not delivered");
  return line;
}

/** Minutes between reminder alerts while an incident persists (0 = off). */
function repeatMinutes(): number {
  const raw = getSetting("SG_ALERT_REPEAT_MIN");
  const n = raw !== undefined ? parseInt(raw, 10) : (env().SG_ALERT_REPEAT_MIN ?? 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/**
 * Guard against double-registration. `startSgAlerts` is called from bot
 * startup AND every `/sg-setup connect`, so without this guard the event
 * listeners (and therefore the alerts) would duplicate each time an admin
 * reconnects.
 */
let alertsStarted = false;
let reminderTimer: ReturnType<typeof setInterval> | null = null;

/** Epoch ms of the last alert/reminder sent per incident key. */
const lastSentAt = new Map<string, number>();
/** Sites currently known to be down (site_id -> site). */
const downSites = new Map<number, SgSite>();
/** Sites with a certificate expiring, and when monitoring data went stale. */
const sslExpiring = new Map<number, SgSite>();
/** SSL warnings already escalated, so a cert expiring in three weeks does
 *  not ring a phone every cooldown window until someone renews it. */
const sslEscalated = new Set<number>();
let dataStaleSince: number | null = null;

async function getSgAlertChannel(client: Client): Promise<TextChannel | null> {
  // Dedicated SG channel → Kuma alert channel → status board channel.
  const channelId =
    getSetting(SG_ALERT_CHANNEL_KEY) ??
    getSetting("ALERT_CHANNEL_ID") ??
    getSetting("STATUS_CHANNEL_ID");

  if (!channelId) {
    logger.error("No SiteGuard alert channel, Kuma alert channel, or status channel configured - SiteGuard alert DROPPED. Run /sg-setup alerts #channel.");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId) as TextChannel | null;
    if (channel?.isTextBased()) return channel;
    logger.error({ channelId }, "SiteGuard alert channel is not a text channel - alert DROPPED");
  } catch (err) {
    logger.error({ err, channelId }, "SiteGuard alert channel not found - alert DROPPED");
  }
  return null;
}

/** Get mention string based on config. */
function mention(): string {
  return isMentionEnabled() ? "@everyone" : "";
}

/** Send email if SiteGuard email alerts are enabled. Resolves true only on success. */
async function maybeEmail(subject: string, html: string): Promise<boolean> {
  if (!isEmailEnabled() || !isSmtpConfigured()) return false;
  try {
    return await sendAlertEmail(subject, html);
  } catch (err) {
    logger.error({ err }, "Failed to send SG alert email");
    return false;
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

async function post(client: Client, embed: EmbedBuilder, withMention: boolean): Promise<boolean> {
  const channel = await getSgAlertChannel(client);
  if (!channel) return false;
  const content = withMention ? mention() : "";
  await discordQueue.add(async () => {
    await channel.send({ ...(content ? { content } : {}), embeds: [embed] });
  });
  return true;
}

export function startSgAlerts(client: Client): void {
  if (alertsStarted) {
    logger.debug("SiteGuard alerts already started - skipping duplicate registration");
    return;
  }
  alertsStarted = true;

  // ---- Site goes DOWN ----
  siteguard.on("siteDown", (site: SgSite) => {
    downSites.set(site.site_id, site);
    markDown(`sg:site:${site.site_id}`);
    if (!isSgEnabled("SITE_DOWN")) return;
    sendSiteDownAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG site down alert")
    );
  });

  // ---- Site recovers ----
  siteguard.on("siteRecovery", (site: SgSite) => {
    downSites.delete(site.site_id);
    lastSentAt.delete(`site:${site.site_id}`);
    markUp(`sg:site:${site.site_id}`).catch(() => undefined);
    sslExpiring.delete(site.site_id);
    sslEscalated.delete(site.site_id);
    if (!isSgEnabled("SITE_RECOVERY")) return;
    sendSiteRecoveryAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG recovery alert")
    );
  });

  // ---- SSL expiring ----
  siteguard.on("sslExpiring", (site: SgSite) => {
    sslExpiring.set(site.site_id, site);
    markDown(`sg:ssl:${site.site_id}`);
    if (!isSgEnabled("SSL_EXPIRING")) return;
    sendSslExpiringAlert(client, site).catch((err) =>
      logger.error({ err, domain: site.domain }, "Failed to send SG SSL alert")
    );
  });

  // ---- WordPress unreachable ----
  siteguard.on("unreachable", (errorMsg: string) => {
    markDown("sg:unreachable");
    if (!isSgEnabled("WP_UNREACHABLE")) return;
    sendUnreachableAlert(client, errorMsg).catch((err) =>
      logger.error({ err }, "Failed to send SG unreachable alert")
    );
  });

  // ---- WordPress reachable again ----
  siteguard.on("reachable", () => {
    markUp("sg:unreachable").catch(() => undefined);
    lastSentAt.delete("unreachable");
    sendReachableAlert(client).catch((err) =>
      logger.error({ err }, "Failed to send SG reachable alert")
    );
  });

  // ---- Health data stale (WP cron dead) ----
  siteguard.on("dataStale", (ageSec: number) => {
    dataStaleSince = dataStaleSince ?? Date.now();
    markDown("sg:data-stale");
    if (!isSgEnabled("DATA_STALE")) return;
    sendDataStaleAlert(client, ageSec).catch((err) =>
      logger.error({ err }, "Failed to send SG stale-data alert")
    );
  });
  siteguard.on("dataFresh", () => {
    dataStaleSince = null;
    markUp("sg:data-stale").catch(() => undefined);
    lastSentAt.delete("stale");
    sendDataFreshAlert(client).catch((err) =>
      logger.error({ err }, "Failed to send SG data-fresh alert")
    );
  });

  // ---- Reminders while an incident persists ----
  if (!reminderTimer) {
    reminderTimer = setInterval(() => {
      runReminders(client).catch((err) => logger.error({ err }, "SG reminder tick failed"));
      reportDownSitesToPbx().catch((err) => logger.error({ err }, "SG phone escalation tick failed"));
    }, REMINDER_TICK_MS);
  }

  logger.info({ tickets: isTicketingConfigured(), repeatMin: repeatMinutes() }, "SiteGuard alerts started");
}

/**
 * Reports every WordPress site still down to the PBX, which decides when a
 * call is actually due. Runs on the same tick as the Discord reminders.
 * Re-seeds markDown so a site that was already down when the bot restarted
 * still escalates rather than waiting for a fresh transition.
 */
async function reportDownSitesToPbx(): Promise<void> {
  if (!isPhoneEscalationEnabled()) return;

  for (const site of downSites.values()) {
    const key = `sg:site:${site.site_id}`;
    markDown(key);
    const name = site.domain || `site ${site.site_id}`;
    await reportActive(key, `Web site ${name} is down.`, "uptime", "sg-site-down");
  }

  for (const site of sslExpiring.values()) {
    if (sslEscalated.has(site.site_id)) continue;
    const key = `sg:ssl:${site.site_id}`;
    markDown(key);
    const name = site.domain || `site ${site.site_id}`;
    await reportActive(key, `S S L certificate for ${name} is expiring soon.`, "uptime", "sg-ssl");
    sslEscalated.add(site.site_id);
    await markUp(key).catch(() => undefined);
  }

  // Stale data means SiteGuard is answering but its numbers stopped moving,
  // so every site could be down and look fine. Worth a call, but on a longer
  // fuse than an outage so a brief blip does not wake anyone.
  if (dataStaleSince !== null && Date.now() - dataStaleSince >= 15 * 60_000) {
    markDown("sg:data-stale");
    await reportActive(
      "sg:data-stale",
      "Site Guard monitoring data has gone stale. Sites are not being checked.",
      "uptime",
      "sg-data-stale",
    );
  }
}

export function stopSgAlerts(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

/**
 * Re-announce ongoing incidents every `repeatMinutes()` so an outage cannot
 * scroll past as a single message. Also keeps the ticket annotated.
 */
async function runReminders(client: Client): Promise<void> {
  const every = repeatMinutes();
  if (!isSgEnabled("REPEAT") || every <= 0) return;
  const everyMs = every * 60_000;
  const now = Date.now();

  // WordPress unreachable
  if (!siteguard.reachable && siteguard.unreachableSince > 0) {
    const last = lastSentAt.get("unreachable") ?? siteguard.unreachableSince;
    if (now - last >= everyMs) {
      lastSentAt.set("unreachable", now);
      const dur = fmtDuration(now - siteguard.unreachableSince);
      const embed = new EmbedBuilder()
        .setTitle(`\u{1F6A8} WORDPRESS STILL UNREACHABLE (${dur})`)
        .setDescription(
          `The SiteGuard health endpoint has been unreachable for **${dur}**.\n\n` +
          `**Last error:** ${siteguard.lastError || "unknown"}\n` +
          `**Impact:** Site health is unknown - outages may be going undetected.\n\n` +
          `Check the WordPress server (wp.example.com) and the SiteGuard plugin now.`
        )
        .setColor(0xe74c3c)
        .setTimestamp(new Date());
      await post(client, embed, true);
      logger.warn({ downFor: dur }, "Sent SG unreachable REMINDER");
      void maybeEmail(`[STILL UNREACHABLE ${dur}] WordPress Health Endpoint`, `<h2>WordPress still unreachable (${dur})</h2><p>${siteguard.lastError}</p>`);
      if (isTicketsEnabled()) {
        await noteIncidentTicket("sg:unreachable", `<p>Still unreachable after ${dur}. Last error: ${escapeHtml(siteguard.lastError)}</p>`);
      }
    }
  }

  // Sites down - one combined reminder
  if (downSites.size > 0) {
    // Refresh from the latest poll so response/error fields are current.
    const currentlyDown = siteguard.getDownSites();
    for (const s of currentlyDown) downSites.set(s.site_id, s);
    for (const id of [...downSites.keys()]) {
      if (!currentlyDown.some((s) => s.site_id === id) && siteguard.data) {
        downSites.delete(id); // recovered without an event (e.g. restart) - drop it
      }
    }
    if (downSites.size === 0) return;

    const oldest = Math.min(...[...downSites.keys()].map((id) => lastSentAt.get(`site:${id}`) ?? 0));
    if (oldest > 0 && now - oldest < everyMs) return;

    const lines = [...downSites.values()]
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((s) => `${sgStatusEmoji("down")} **${s.domain}** - ${s.error || `HTTP ${s.http_code || "?"}`} (${s.consecutive_failures ?? "?"} consecutive failures)`);
    const embed = new EmbedBuilder()
      .setTitle(`\u{1F534} ${downSites.size} SITE${downSites.size > 1 ? "S" : ""} STILL DOWN`)
      .setDescription(lines.join("\n") + `\n\nThis reminder repeats every ${every} min until the site${downSites.size > 1 ? "s" : ""} recover.`)
      .setColor(0xe74c3c)
      .setTimestamp(new Date());
    await post(client, embed, true);
    for (const id of downSites.keys()) lastSentAt.set(`site:${id}`, now);
    logger.warn({ count: downSites.size }, "Sent SG sites-down REMINDER");
    void maybeEmail(`[STILL DOWN] ${downSites.size} site(s)`, `<h2>${downSites.size} site(s) still down</h2><ul>${[...downSites.values()].map((s) => `<li>${escapeHtml(s.domain)} - ${escapeHtml(s.error || String(s.http_code))}</li>`).join("")}</ul>`);
    if (isTicketsEnabled()) {
      for (const s of downSites.values()) {
        await noteIncidentTicket(`sg:site:${s.site_id}`, `<p>${escapeHtml(s.domain)} still down (${s.consecutive_failures ?? "?"} consecutive failures). Error: ${escapeHtml(s.error || String(s.http_code))}</p>`);
      }
    }
  }
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function sendSiteDownAlert(client: Client, site: SgSite): Promise<void> {
  lastSentAt.set(`site:${site.site_id}`, Date.now());
  const source = site.check_method === "bot-direct" ? "bot direct probe" : "SiteGuard (WordPress)";

  // Discord first - it is the fastest path - then helpdesk (email → API fallback).
  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("down")} ${site.domain} is DOWN`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**HTTP Code:** ${site.http_code || "N/A"}\n` +
      `**Error:** ${site.error || "No response"}\n` +
      `**Response Time:** ${Math.round((site.response_time || 0) * 1000)}ms\n` +
      `**Consecutive Failures:** ${site.consecutive_failures ?? 1}\n` +
      `**Detected by:** ${source}\n` +
      `**Detected:** <t:${site.last_check || Math.floor(Date.now() / 1000)}:R>`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date((site.last_check || Math.floor(Date.now() / 1000)) * 1000));

  const sent = await post(client, embed, true);
  logger.warn({ domain: site.domain, error: site.error, sent, source }, "SG site DOWN alert");

  const ticketLine = await deliverIncident(
    `sg:site:${site.site_id}`,
    `[DOWN] ${site.domain}`,
    `<h2>${escapeHtml(site.domain)} is DOWN</h2><p><b>URL:</b> ${escapeHtml(site.url)}</p><p><b>HTTP Code:</b> ${site.http_code || "N/A"}</p><p><b>Error:</b> ${escapeHtml(site.error || "No response")}</p><p><b>Consecutive Failures:</b> ${site.consecutive_failures ?? 1}</p><p><b>Detected by:</b> ${source}</p><p>Opened automatically by the uptime bot.</p>`
  );
  if (ticketLine) {
    const follow = new EmbedBuilder().setDescription(`${site.domain}: ${ticketLine.trim()}`).setColor(ticketLine.includes("\u26A0") ? 0xe67e22 : 0x95a5a6);
    await post(client, follow, ticketLine.includes("\u26A0"));
  }
}

async function sendSiteRecoveryAlert(client: Client, site: SgSite): Promise<void> {
  let ticketLine = "";
  if (isTicketingConfigured()) {
    const rec = await resolveIncidentTicket(
      `sg:site:${site.site_id}`,
      `<p>${escapeHtml(site.domain)} is back UP (HTTP ${site.http_code}, ${Math.round((site.response_time || 0) * 1000)}ms). Resolved automatically by the uptime bot.</p>`
    );
    if (rec) ticketLine = `\n**Ticket:** #${rec.number} resolved`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("operational")} ${site.domain} is back UP`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**HTTP Code:** ${site.http_code}\n` +
      `**Response Time:** ${Math.round((site.response_time || 0) * 1000)}ms\n` +
      `**Recovered:** <t:${site.last_check || Math.floor(Date.now() / 1000)}:R>` +
      ticketLine
    )
    .setColor(0x2ecc71)
    .setTimestamp(new Date((site.last_check || Math.floor(Date.now() / 1000)) * 1000));

  await post(client, embed, false);
  logger.info({ domain: site.domain }, "Sent SG recovery alert");

  void maybeEmail(
    `[RECOVERED] ${site.domain}`,
    `<h2>${escapeHtml(site.domain)} is back UP</h2><p><b>Response Time:</b> ${Math.round((site.response_time || 0) * 1000)}ms</p>`
  );
}

async function sendSslExpiringAlert(client: Client, site: SgSite): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ SSL Certificate Expiring - ${site.domain}`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**Days Remaining:** ${site.ssl_expiry_days}\n` +
      `**Issuer:** ${site.ssl_issuer || "Unknown"}\n\n` +
      `Renew the certificate before it expires to avoid downtime.`
    )
    .setColor(0xf39c12)
    .setTimestamp(new Date());

  await post(client, embed, false);
  logger.warn({ domain: site.domain, daysLeft: site.ssl_expiry_days }, "Sent SG SSL expiring alert");

  void maybeEmail(
    `[SSL EXPIRING] ${site.domain} - ${site.ssl_expiry_days} days left`,
    `<h2>SSL Certificate Expiring - ${escapeHtml(site.domain)}</h2><p><b>Days Remaining:</b> ${site.ssl_expiry_days}</p><p><b>Issuer:</b> ${escapeHtml(site.ssl_issuer || "Unknown")}</p><p>Renew the certificate before it expires.</p>`
  );
}

async function sendUnreachableAlert(client: Client, errorMsg: string): Promise<void> {
  lastSentAt.set("unreachable", Date.now());
  const ticketLine = "";

  const embed = new EmbedBuilder()
    .setTitle("\u{1F6A8} WORDPRESS UNREACHABLE")
    .setDescription(
      `Cannot reach the SiteGuard health endpoint.\n\n` +
      `**Endpoint:** ${siteguard.getUrl() ?? "?"}\n` +
      `**Error:** ${errorMsg}\n` +
      `**Impact:** All site health data is stale - outages may go undetected.\n\n` +
      `Check the WordPress server and SiteGuard plugin immediately.` +
      ticketLine
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date());

  const sent = await post(client, embed, true);
  logger.warn({ error: errorMsg, sent }, "SG WordPress unreachable alert");

  const ticketLine2 = await deliverIncident(
    "sg:unreachable",
    "[UNREACHABLE] WordPress health endpoint (SiteGuard)",
    `<h2>WordPress Unreachable</h2><p>The SiteGuard health endpoint at ${escapeHtml(siteguard.getUrl() ?? "")} cannot be reached.</p><p><b>Error:</b> ${escapeHtml(errorMsg)}</p><p>All site health data is stale; outages may be going undetected. Opened automatically by the uptime bot.</p>`
  );
  if (ticketLine2) {
    const follow = new EmbedBuilder().setDescription(`WordPress unreachable: ${ticketLine2.trim()}`).setColor(ticketLine2.includes("\u26A0") ? 0xe67e22 : 0x95a5a6);
    await post(client, follow, ticketLine2.includes("\u26A0"));
  }
}

async function sendReachableAlert(client: Client): Promise<void> {
  const summary = siteguard.getSummary();

  let ticketLine = "";
  if (isTicketingConfigured()) {
    const rec = await resolveIncidentTicket(
      "sg:unreachable",
      `<p>SiteGuard health endpoint reachable again. ${summary.operational}/${summary.total} sites operational${summary.down > 0 ? `, ${summary.down} down` : ""}. Resolved automatically by the uptime bot.</p>`
    );
    if (rec) ticketLine = `\n**Ticket:** #${rec.number} resolved`;
  }

  const embed = new EmbedBuilder()
    .setTitle("\u{1F7E2} WordPress Connection Restored")
    .setDescription(
      `SiteGuard health endpoint is reachable again.\n\n` +
      `**Status:** ${summary.operational}/${summary.total} sites operational` +
      (summary.down > 0 ? `\n**\u{1F534} ${summary.down} site${summary.down > 1 ? "s" : ""} currently down**` : "") +
      ticketLine
    )
    .setColor(summary.down > 0 ? 0xe74c3c : 0x2ecc71)
    .setTimestamp(new Date());

  // Still mention if sites are down after the connection came back.
  await post(client, embed, summary.down > 0);
  logger.info("Sent SG WordPress reachable alert");

  void maybeEmail(
    "[RESTORED] WordPress Health Endpoint",
    `<h2>WordPress Connection Restored</h2><p>Status: ${summary.operational}/${summary.total} sites operational</p>`
  );
}

async function sendDataStaleAlert(client: Client, ageSec: number): Promise<void> {
  lastSentAt.set("stale", Date.now());
  const age = fmtDuration(ageSec * 1000);
  const embed = new EmbedBuilder()
    .setTitle("⚠️ SITEGUARD HEALTH DATA STALE")
    .setDescription(
      `WordPress answers, but SiteGuard has not checked its sites for **${age}**.\n\n` +
      `WP-Cron is probably not running on the WordPress server, so site outages are **not being detected**. ` +
      `The bot has requested an on-demand check; if this persists, fix WP-Cron (or set up a system cron hitting wp-cron.php).`
    )
    .setColor(0xe67e22)
    .setTimestamp(new Date());

  await post(client, embed, true);
  logger.warn({ ageSec }, "Sent SG stale-data alert");
  void maybeEmail("[STALE] SiteGuard health data", `<h2>SiteGuard health data stale (${age})</h2><p>WP-Cron may be dead; site outages are not being detected.</p>`);
}

async function sendDataFreshAlert(client: Client): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("\u{1F7E2} SiteGuard Health Data Fresh Again")
    .setDescription("WordPress has resumed checking its sites; health data is current.")
    .setColor(0x2ecc71)
    .setTimestamp(new Date());
  await post(client, embed, false);
  logger.info("Sent SG data-fresh alert");
}
