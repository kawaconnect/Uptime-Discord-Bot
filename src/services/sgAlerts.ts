/**
 * SiteGuard alert system - Discord alerts + optional email + optional Zammad
 * ticket for:
 * - Site goes DOWN (@everyone by default) - also on the first poll after a
 *   restart when the site was not already known to be down
 * - Site recovers (UP after DOWN)
 * - SSL certificate expiring soon
 * - WordPress endpoint unreachable (@everyone by default)
 * - SiteGuard answering but refusing the bot (monitor disabled, API key
 *   rejected, IP rate-limited, route missing): one notice without @everyone,
 *   email or ticket, since WordPress is up and the fix is configuration; the
 *   bot's direct probe keeps watching the sites meanwhile
 * - WordPress endpoint reachable again
 * - SSL probe failures reported by SiteGuard (one notice per site)
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
 * Each alert type can be toggled via /sg-setup alerts-toggle. Alerts for a
 * single site can be paused with /sg-pause site (see sgSitePauses.ts): its
 * down/recovery/SSL alerts, reminders, tickets and phone calls are skipped
 * while its state keeps being tracked.
 * @everyone and email are independently configurable (default: both ON for SiteGuard).
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { env } from "../util/env.js";
import { getSetting, setSetting } from "../db/index.js";
import {
  siteguard,
  sgStatusEmoji,
  sgSiteLabel,
  isConfigErrorKind,
  type SgSite,
  type SgErrorKind,
} from "./siteguard.js";
import { escapeHtml } from "../util/html.js";
import { mentionsFor, NO_MENTIONS } from "../util/mentions.js";
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
import {
  isSgSitePaused,
  dueSitePauses,
  deleteSitePause,
  sgSiteResumeEmbed,
  type SgSitePause,
} from "./sgSitePauses.js";

const SG_ALERT_CHANNEL_KEY = "SG_ALERT_CHANNEL_ID";
const REMINDER_TICK_MS = 60_000;

const SG_PAUSED_KEY = "SG_MONITORING_PAUSED";

/**
 * True while SiteGuard monitoring is paused.
 *
 * Pausing suppresses every outward effect - Discord alerts, Zammad tickets
 * and phone calls - while leaving the poller running, so state stays current
 * and recovery is detected normally. Intended for planned maintenance, where
 * the sites are expected to be down and nobody should be woken about it.
 */
export function isSgPaused(): boolean {
  return getSetting(SG_PAUSED_KEY) === "true";
}

export function setSgPaused(paused: boolean): void {
  setSetting(SG_PAUSED_KEY, paused ? "true" : "false");
}

function isSgEnabled(type: string): boolean {
  if (isSgPaused()) return false;
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
  if (isSgPaused()) return "";
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
/** Error kind of the current "unreachable" incident ("" when reachable). */
let unreachableKind: SgErrorKind | "" = "";

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
    await channel.send({ ...(content ? { content } : {}), embeds: [embed], allowedMentions: mentionsFor(content) });
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
    if (isSgSitePaused(site.site_id)) {
      logger.info({ site: sgSiteLabel(site) }, "SG site down while its alerts are paused: not announced");
      return;
    }
    markDown(`sg:site:${site.site_id}`);
    if (!isSgEnabled("SITE_DOWN")) return;
    sendSiteDownAlert(client, site).catch((err) =>
      logger.error({ err, site: sgSiteLabel(site) }, "Failed to send SG site down alert")
    );
  });

  // ---- Site recovers ----
  siteguard.on("siteRecovery", (site: SgSite) => {
    downSites.delete(site.site_id);
    lastSentAt.delete(`site:${site.site_id}`);
    markUp(`sg:site:${site.site_id}`).catch(() => undefined);
    sslExpiring.delete(site.site_id);
    sslEscalated.delete(site.site_id);
    if (isSgSitePaused(site.site_id)) {
      // Not announced, but a ticket opened before the pause is still closed.
      logger.info({ site: sgSiteLabel(site) }, "SG site recovered while its alerts are paused: not announced");
      if (isTicketingConfigured()) {
        resolveIncidentTicket(`sg:site:${site.site_id}`, `<p>${escapeHtml(sgSiteLabel(site))} is back UP (alerts for this site were paused). Resolved automatically by the uptime bot.</p>`)
          .catch((err) => logger.warn({ err }, "Could not resolve the ticket of a paused site"));
      }
      return;
    }
    if (!isSgEnabled("SITE_RECOVERY")) return;
    sendSiteRecoveryAlert(client, site).catch((err) =>
      logger.error({ err, site: sgSiteLabel(site) }, "Failed to send SG recovery alert")
    );
  });

  // ---- SSL expiring ----
  siteguard.on("sslExpiring", (site: SgSite) => {
    sslExpiring.set(site.site_id, site);
    if (isSgSitePaused(site.site_id)) return;
    markDown(`sg:ssl:${site.site_id}`);
    if (!isSgEnabled("SSL_EXPIRING")) return;
    sendSslExpiringAlert(client, site).catch((err) =>
      logger.error({ err, site: sgSiteLabel(site) }, "Failed to send SG SSL alert")
    );
  });

  // ---- WordPress unreachable ----
  siteguard.on("unreachable", (errorMsg: string, kind: SgErrorKind | "" = "") => {
    unreachableKind = kind;
    if (!isConfigErrorKind(kind)) markDown("sg:unreachable");
    if (!isSgEnabled("WP_UNREACHABLE")) return;
    sendUnreachableAlert(client, errorMsg, kind).catch((err) =>
      logger.error({ err }, "Failed to send SG unreachable alert")
    );
  });

  // ---- WordPress reachable again ----
  siteguard.on("reachable", (previousKind: SgErrorKind | "" = "") => {
    unreachableKind = "";
    markUp("sg:unreachable").catch(() => undefined);
    lastSentAt.delete("unreachable");
    if (isSgPaused()) return;
    sendReachableAlert(client, previousKind).catch((err) =>
      logger.error({ err }, "Failed to send SG reachable alert")
    );
  });

  // ---- SSL probe failed (SiteGuard could not read the certificate) ----
  siteguard.on("sslProbeFailed", (site: SgSite, message: string) => {
    if (isSgSitePaused(site.site_id)) return;
    if (!isSgEnabled("SSL_EXPIRING")) return;
    sendSslProbeFailedAlert(client, site, message).catch((err) =>
      logger.error({ err, site: sgSiteLabel(site) }, "Failed to send SG SSL probe alert")
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
      // Lapsed site pauses first, so a site that went down while paused gets
      // its down alert before any "still down" reminder.
      runSgSiteAutoResume(client)
        .catch((err) => logger.error({ err }, "SG site auto-resume failed"))
        .then(() => runReminders(client)).catch((err) => logger.error({ err }, "SG reminder tick failed"));
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
  if (isSgPaused()) return;
  if (!isPhoneEscalationEnabled()) return;

  for (const site of downSites.values()) {
    const key = `sg:site:${site.site_id}`;
    if (isSgSitePaused(site.site_id)) {
      await markUp(key).catch(() => undefined); // stop any call already in progress
      continue;
    }
    markDown(key);
    const name = sgSiteLabel(site) || `site ${site.site_id}`;
    await reportActive(key, `Web site ${name} is down.`, "uptime", "sg-site-down");
  }

  for (const site of sslExpiring.values()) {
    if (sslEscalated.has(site.site_id)) continue;
    if (isSgSitePaused(site.site_id)) continue;
    const key = `sg:ssl:${site.site_id}`;
    markDown(key);
    const name = sgSiteLabel(site) || `site ${site.site_id}`;
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
 * Exported for tests; runs on the reminder tick.
 */
export async function runReminders(client: Client): Promise<void> {
  const every = repeatMinutes();
  if (!isSgEnabled("REPEAT") || every <= 0) return;
  const everyMs = every * 60_000;
  const now = Date.now();

  // WordPress unreachable
  // Configuration problems (monitor disabled, key rejected, rate-limited) are
  // announced once and not repeated: WordPress is up and nobody needs paging.
  if (!siteguard.reachable && siteguard.unreachableSince > 0 && !isConfigErrorKind(unreachableKind)) {
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
      void maybeEmail(`[STILL UNREACHABLE ${dur}] WordPress Health Endpoint`, `<h2>WordPress still unreachable (${escapeHtml(dur)})</h2><p>${escapeHtml(siteguard.lastError)}</p>`);
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
    // Sites whose alerts are paused are left out of the reminder.
    const active = [...downSites.values()].filter((site) => !isSgSitePaused(site.site_id));
    if (active.length === 0) return;

    const oldest = Math.min(...active.map((site) => lastSentAt.get(`site:${site.site_id}`) ?? 0));
    if (oldest > 0 && now - oldest < everyMs) return;

    const lines = active
      .sort((a, b) => sgSiteLabel(a).localeCompare(sgSiteLabel(b)))
      .map((s) => `${sgStatusEmoji("down")} **${sgSiteLabel(s)}** - ${s.error || `HTTP ${s.http_code || "?"}`} (${s.consecutive_failures ?? "?"} consecutive failures)`);
    const embed = new EmbedBuilder()
      .setTitle(`\u{1F534} ${active.length} SITE${active.length > 1 ? "S" : ""} STILL DOWN`)
      .setDescription(lines.join("\n") + `\n\nThis reminder repeats every ${every} min until the site${active.length > 1 ? "s" : ""} recover.`)
      .setColor(0xe74c3c)
      .setTimestamp(new Date());
    await post(client, embed, true);
    for (const site of active) lastSentAt.set(`site:${site.site_id}`, now);
    logger.warn({ count: active.length }, "Sent SG sites-down REMINDER");
    void maybeEmail(`[STILL DOWN] ${active.length} site(s)`, `<h2>${active.length} site(s) still down</h2><ul>${active.map((s) => `<li>${escapeHtml(sgSiteLabel(s))} - ${escapeHtml(s.error || String(s.http_code))}</li>`).join("")}</ul>`);
    if (isTicketsEnabled()) {
      for (const s of active) {
        await noteIncidentTicket(`sg:site:${s.site_id}`, `<p>${escapeHtml(sgSiteLabel(s))} still down (${escapeHtml(s.consecutive_failures ?? "?")} consecutive failures). Error: ${escapeHtml(s.error || String(s.http_code))}</p>`);
      }
    }
  }
}


async function sendSiteDownAlert(client: Client, site: SgSite): Promise<void> {
  lastSentAt.set(`site:${site.site_id}`, Date.now());
  const source = site.check_method === "bot-direct" ? "bot direct probe" : "SiteGuard (WordPress)";
  const label = sgSiteLabel(site);

  // Discord first - it is the fastest path - then helpdesk (email → API fallback).
  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("down")} ${label} is DOWN`)
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
  logger.warn({ site: label, error: site.error, sent, source }, "SG site DOWN alert");

  const ticketLine = await deliverIncident(
    `sg:site:${site.site_id}`,
    `[DOWN] ${label}`,
    `<h2>${escapeHtml(label)} is DOWN</h2><p><b>URL:</b> ${escapeHtml(site.url)}</p><p><b>HTTP Code:</b> ${escapeHtml(site.http_code || "N/A")}</p><p><b>Error:</b> ${escapeHtml(site.error || "No response")}</p><p><b>Consecutive Failures:</b> ${escapeHtml(site.consecutive_failures ?? 1)}</p><p><b>Detected by:</b> ${escapeHtml(source)}</p><p>Opened automatically by the uptime bot.</p>`
  );
  await postTicketFollowUp(client, label, ticketLine);
}

/**
 * Where the incident ticket went, as a follow-up to the alert. Never pings:
 * the alert itself already did, and a second @everyone per incident (e.g.
 * "no SMTP configured") is noise.
 */
async function postTicketFollowUp(client: Client, subject: string, ticketLine: string): Promise<void> {
  if (!ticketLine) return;
  const warn = ticketLine.includes("\u26A0");
  const follow = new EmbedBuilder().setDescription(`${subject}: ${ticketLine.trim()}`).setColor(warn ? 0xe67e22 : 0x95a5a6);
  await post(client, follow, false);
}

async function sendSiteRecoveryAlert(client: Client, site: SgSite): Promise<void> {
  const label = sgSiteLabel(site);
  let ticketLine = "";
  if (isTicketingConfigured()) {
    const rec = await resolveIncidentTicket(
      `sg:site:${site.site_id}`,
      `<p>${escapeHtml(label)} is back UP (HTTP ${escapeHtml(site.http_code)}, ${Math.round((site.response_time || 0) * 1000)}ms). Resolved automatically by the uptime bot.</p>`
    );
    if (rec) ticketLine = `\n**Ticket:** #${rec.number} resolved`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji("operational")} ${label} is back UP`)
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
  logger.info({ site: label }, "Sent SG recovery alert");

  void maybeEmail(
    `[RECOVERED] ${label}`,
    `<h2>${escapeHtml(label)} is back UP</h2><p><b>Response Time:</b> ${Math.round((site.response_time || 0) * 1000)}ms</p>`
  );
}

async function sendSslExpiringAlert(client: Client, site: SgSite): Promise<void> {
  const label = sgSiteLabel(site);
  const embed = new EmbedBuilder()
    .setTitle(`\u26A0\uFE0F SSL Certificate Expiring - ${label}`)
    .setDescription(
      `**URL:** ${site.url}\n` +
      `**Days Remaining:** ${site.ssl_expiry_days}\n` +
      `**Issuer:** ${site.ssl_issuer || "Unknown"}\n\n` +
      `Renew the certificate before it expires to avoid downtime.`
    )
    .setColor(0xf39c12)
    .setTimestamp(new Date());

  await post(client, embed, false);
  logger.warn({ site: label, daysLeft: site.ssl_expiry_days }, "Sent SG SSL expiring alert");

  void maybeEmail(
    `[SSL EXPIRING] ${label} - ${site.ssl_expiry_days} days left`,
    `<h2>SSL Certificate Expiring - ${escapeHtml(label)}</h2><p><b>Days Remaining:</b> ${escapeHtml(site.ssl_expiry_days)}</p><p><b>Issuer:</b> ${escapeHtml(site.ssl_issuer || "Unknown")}</p><p>Renew the certificate before it expires.</p>`
  );
}

/** One Discord notice (no @everyone, email or ticket): SiteGuard could not read the certificate. */
async function sendSslProbeFailedAlert(client: Client, site: SgSite, message: string): Promise<void> {
  const label = sgSiteLabel(site);
  const last = Number(site.ssl_last_success) > 0 ? `<t:${Number(site.ssl_last_success)}:R>` : "never";
  const embed = new EmbedBuilder()
    .setTitle(`\u26A0\uFE0F SSL Check Failing - ${label}`)
    .setDescription(
      `SiteGuard could not read the certificate, so its expiry is not being checked.\n\n` +
      `**URL:** ${site.url}\n` +
      `**Error:** ${(message || site.ssl_error || "unknown").slice(0, 500)}\n` +
      `**Last successful check:** ${last}`
    )
    .setColor(0xf39c12)
    .setTimestamp(new Date());
  await post(client, embed, false);
  logger.warn({ site: label, message }, "Sent SG SSL probe failure notice");
}

const CONFIG_ERROR_TEXT: Record<string, { title: string; lead: string; fix: string }> = {
  disabled: {
    title: "\u26A0\uFE0F SITEGUARD HEALTH MONITOR DISABLED",
    lead: "WordPress answers, but SiteGuard's health monitor is switched off.",
    fix: "Enable it in SiteGuard \u2192 Health, or `/sg-setup disconnect` if this is intended.",
  },
  auth: {
    title: "\u26A0\uFE0F SITEGUARD REJECTED THE BOT'S API KEY",
    lead: "WordPress answers, but no longer accepts the bot's API key.",
    fix: "Copy the current key from SiteGuard \u2192 Health and run `/sg-setup connect` again.",
  },
  rate_limited: {
    title: "\u26A0\uFE0F SITEGUARD IS RATE-LIMITING THE BOT",
    lead: "WordPress answers, but blocks this IP after too many failed key attempts.",
    fix: "Check the API key (`/sg-setup connect`); the block clears by itself.",
  },
  not_found: {
    title: "\u26A0\uFE0F SITEGUARD HEALTH ROUTE NOT FOUND",
    lead: "WordPress answers, but the SiteGuard health route does not exist.",
    fix: "Check that the SiteGuard plugin is active and the endpoint URL is right.",
  },
};

async function sendUnreachableAlert(client: Client, errorMsg: string, kind: SgErrorKind | "" = ""): Promise<void> {
  lastSentAt.set("unreachable", Date.now());

  const cfg = isConfigErrorKind(kind) ? CONFIG_ERROR_TEXT[kind] : undefined;
  if (cfg) {
    // Configuration problem: WordPress is up, so no @everyone, email or
    // ticket, and no reminders. Site outages are still caught by the bot's
    // direct probe of every known site.
    const embed = new EmbedBuilder()
      .setTitle(cfg.title)
      .setDescription(
        `${cfg.lead}\n\n` +
        `**Endpoint:** ${siteguard.getUrl() ?? "?"}\n` +
        `**Error:** ${errorMsg}\n` +
        `**Impact:** SiteGuard health data is not updating. The bot's own probe of each site keeps running.\n\n` +
        cfg.fix
      )
      .setColor(0xe67e22)
      .setTimestamp(new Date());
    const sent = await post(client, embed, false);
    logger.warn({ error: errorMsg, kind, sent }, "SG configuration error notice");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("\u{1F6A8} WORDPRESS UNREACHABLE")
    .setDescription(
      `Cannot reach the SiteGuard health endpoint.\n\n` +
      `**Endpoint:** ${siteguard.getUrl() ?? "?"}\n` +
      `**Error:** ${errorMsg}\n` +
      `**Impact:** All site health data is stale - outages may go undetected.\n\n` +
      `Check the WordPress server and SiteGuard plugin immediately.`
    )
    .setColor(0xe74c3c)
    .setTimestamp(new Date());

  const sent = await post(client, embed, true);
  logger.warn({ error: errorMsg, kind, sent }, "SG WordPress unreachable alert");

  const ticketLine = await deliverIncident(
    "sg:unreachable",
    "[UNREACHABLE] WordPress health endpoint (SiteGuard)",
    `<h2>WordPress Unreachable</h2><p>The SiteGuard health endpoint at ${escapeHtml(siteguard.getUrl() ?? "")} cannot be reached.</p><p><b>Error:</b> ${escapeHtml(errorMsg)}</p><p>All site health data is stale; outages may be going undetected. Opened automatically by the uptime bot.</p>`
  );
  await postTicketFollowUp(client, "WordPress unreachable", ticketLine);
}

async function sendReachableAlert(client: Client, previousKind: SgErrorKind | "" = ""): Promise<void> {
  const summary = siteguard.getSummary();
  const wasConfig = isConfigErrorKind(previousKind);

  let ticketLine = "";
  if (!wasConfig && isTicketingConfigured()) {
    const rec = await resolveIncidentTicket(
      "sg:unreachable",
      `<p>SiteGuard health endpoint reachable again. ${summary.operational}/${summary.total} sites operational${summary.down > 0 ? `, ${summary.down} down` : ""}. Resolved automatically by the uptime bot.</p>`
    );
    if (rec) ticketLine = `\n**Ticket:** #${rec.number} resolved`;
  }

  const embed = new EmbedBuilder()
    .setTitle(wasConfig ? "\u{1F7E2} SiteGuard Health Data Available Again" : "\u{1F7E2} WordPress Connection Restored")
    .setDescription(
      `SiteGuard health endpoint is ${wasConfig ? "answering the bot" : "reachable"} again.\n\n` +
      `**Status:** ${summary.operational}/${summary.total} sites operational` +
      (summary.down > 0 ? `\n**\u{1F534} ${summary.down} site${summary.down > 1 ? "s" : ""} currently down**` : "") +
      ticketLine
    )
    .setColor(summary.down > 0 ? 0xe74c3c : 0x2ecc71)
    .setTimestamp(new Date());

  // Still mention if sites are down after the connection came back (not
  // after a configuration problem: WordPress was up, sites were probed).
  await post(client, embed, !wasConfig && summary.down > 0);
  logger.info({ previousKind }, "Sent SG WordPress reachable alert");

  if (!wasConfig) {
    void maybeEmail(
      "[RESTORED] WordPress Health Endpoint",
      `<h2>WordPress Connection Restored</h2><p>Status: ${summary.operational}/${summary.total} sites operational</p>`
    );
  }
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

// ---------------------------------------------------------------
// Per-site pause: state on resume, auto-resume
// ---------------------------------------------------------------

/** One-line current state of a site, for pause/resume notices. */
export function sgSiteStatusLine(siteId: number): { line: string; down: boolean } {
  const down = siteguard.getDownSites().find((s) => s.site_id === siteId);
  if (down) {
    return {
      line: `${sgStatusEmoji("down")} **DOWN** - ${(down.error || `HTTP ${down.http_code || "?"}`).slice(0, 300)} (${down.consecutive_failures ?? "?"} consecutive failures)`,
      down: true,
    };
  }
  const site = siteguard.sites.find((s) => s.site_id === siteId);
  if (!site) return { line: "No current health data for this site.", down: false };
  let line = `${sgStatusEmoji(site.status)} ${site.status === "unknown" ? "Not checked in the last run" : site.status.charAt(0).toUpperCase() + site.status.slice(1)}`;
  if (site.http_code) line += ` - HTTP ${site.http_code}, ${Math.round((site.response_time || 0) * 1000)}ms`;
  if (sslExpiring.has(siteId) || (site.ssl_expiry_days >= 0 && site.ssl_expiry_days <= (parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10) || 14) && site.ssl_stale !== true)) {
    line += `\n\u26A0\uFE0F SSL certificate expires in ${site.ssl_expiry_days} days`;
  }
  return { line, down: false };
}

/**
 * After a site's pause ends: if it is down and the outage was never announced
 * (it went down while paused), send the normal down alert now (ticket and
 * phone escalation included), so nothing is lost by the pause.
 */
export async function alertSiteAfterResume(client: Client, siteId: number): Promise<boolean> {
  const down = siteguard.getDownSites().find((s) => s.site_id === siteId);
  if (!down) return false;
  downSites.set(siteId, down);
  if (lastSentAt.has(`site:${siteId}`)) return false; // announced before the pause; reminders carry on
  markDown(`sg:site:${siteId}`);
  if (!isSgEnabled("SITE_DOWN")) return false;
  await sendSiteDownAlert(client, down);
  return true;
}

async function channelFor(client: Client, channelId: string | null): Promise<TextChannel | null> {
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId) as TextChannel | null;
      if (ch?.isTextBased()) return ch;
    } catch { /* fall back to the alert channel */ }
  }
  return getSgAlertChannel(client);
}

/**
 * End every site pause whose time has come: announce it (with the site's
 * current state) where it was paused, then alert an outage that started
 * during the pause. Returns the number of pauses ended. Runs on the reminder
 * tick; exported for tests.
 */
export async function runSgSiteAutoResume(client: Client, now = Date.now()): Promise<number> {
  let ended = 0;
  for (const p of dueSitePauses(now)) {
    if (!deleteSitePause(p.siteId)) continue;
    ended++;
    logger.info({ site: p.siteLabel, siteId: p.siteId }, "SG site pause ended (auto-resume)");
    await announceSiteResume(client, p, { auto: true, now }).catch((err) =>
      logger.error({ err, site: p.siteLabel }, "Failed to announce the SG site auto-resume"),
    );
  }
  return ended;
}

/** Post the resume notice for a site, then its down alert if one is owed. */
export async function announceSiteResume(
  client: Client,
  p: SgSitePause,
  opts: { auto: boolean; userId?: string; now?: number; send?: (embed: EmbedBuilder) => Promise<void> },
): Promise<void> {
  const status = sgSiteStatusLine(p.siteId);
  const embed = sgSiteResumeEmbed(p, { auto: opts.auto, userId: opts.userId, currentStatus: status.line, down: status.down, now: opts.now });
  if (opts.send) {
    await opts.send(embed);
  } else {
    const ch = await channelFor(client, p.channelId);
    if (ch) await discordQueue.add(async () => { await ch.send({ embeds: [embed], allowedMentions: NO_MENTIONS }); });
    else logger.warn({ site: p.siteLabel }, "No channel to announce the SG site resume in");
  }
  if (isSgPaused()) return; // all of SiteGuard is paused: nothing alerts
  await alertSiteAfterResume(client, p.siteId);
}
