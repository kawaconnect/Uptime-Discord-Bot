/**
 * Pausing alerts for one SiteGuard site at a time.
 *
 * `/sg-pause site` silences a single WordPress site: no Discord alerts,
 * reminders, emails, tickets or phone calls for it, while every other site
 * keeps alerting. The bot keeps polling SiteGuard and probing the site, so its
 * state stays current; on resume the current state is announced, and a site
 * that went down while paused gets its normal down alert then.
 *
 * Pauses are stored in the `sg_site_pauses` table of data/bot.db, so a timed
 * pause survives restarts. A pause past its end time no longer silences
 * anything, even before the sweep has removed it.
 *
 * This module is only the store and the lookup helpers; alert suppression and
 * the auto-resume sweep live in sgAlerts.ts.
 */

import { EmbedBuilder } from "discord.js";
import { database } from "../db/index.js";
import { sgSiteLabel, sgStatusEmoji, type SgSite } from "./siteguard.js";
import { discordTime, formatDuration } from "./monitorPauses.js";

export interface SgSitePause {
  siteId: number;
  siteLabel: string;
  siteUrl: string;
  pausedBy: string;
  pausedById: string;
  reason: string | null;
  pausedAt: number;
  /** Epoch ms of the automatic resume; null = until someone resumes it. */
  resumeAt: number | null;
  /** Channel the pause was made from (the auto-resume is announced there). */
  channelId: string | null;
}

/** A site the bot knows: from the latest poll, or remembered from earlier ones. */
export interface SgSiteRef {
  site_id: number;
  url: string;
  domain: string;
  status?: SgSite["status"];
}

// ---------------------------------------------------------------
// Store
// ---------------------------------------------------------------

interface Row {
  site_id: number;
  site_label: string;
  site_url: string;
  paused_by: string;
  paused_by_id: string;
  reason: string | null;
  paused_at: number;
  resume_at: number | null;
  channel_id: string | null;
}

function fromRow(r: Row): SgSitePause {
  return {
    siteId: r.site_id,
    siteLabel: r.site_label,
    siteUrl: r.site_url,
    pausedBy: r.paused_by,
    pausedById: r.paused_by_id,
    reason: r.reason,
    pausedAt: r.paused_at,
    resumeAt: r.resume_at,
    channelId: r.channel_id,
  };
}

export function saveSitePause(p: SgSitePause): void {
  database()
    .prepare(
      `INSERT OR REPLACE INTO sg_site_pauses
         (site_id, site_label, site_url, paused_by, paused_by_id, reason, paused_at, resume_at, channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.siteId, p.siteLabel, p.siteUrl, p.pausedBy, p.pausedById, p.reason, p.pausedAt, p.resumeAt, p.channelId);
}

export function getSitePause(siteId: number): SgSitePause | null {
  const row = database().prepare("SELECT * FROM sg_site_pauses WHERE site_id = ?").get(siteId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listSitePauses(): SgSitePause[] {
  return (database().prepare("SELECT * FROM sg_site_pauses ORDER BY site_label").all() as Row[]).map(fromRow);
}

export function dueSitePauses(now: number): SgSitePause[] {
  return (database()
    .prepare("SELECT * FROM sg_site_pauses WHERE resume_at IS NOT NULL AND resume_at <= ? ORDER BY resume_at")
    .all(now) as Row[]).map(fromRow);
}

export function deleteSitePause(siteId: number): boolean {
  return database().prepare("DELETE FROM sg_site_pauses WHERE site_id = ?").run(siteId).changes > 0;
}

/** True while alerts for this site are paused (an expired pause no longer counts). */
export function isSgSitePaused(siteId: number, now = Date.now()): boolean {
  const p = getSitePause(siteId);
  return !!p && (p.resumeAt === null || p.resumeAt > now);
}

// ---------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------

/** Live sites first; sites only remembered from earlier polls fill in. */
export function mergeSgSites(live: SgSite[], known: Array<{ site_id: number; url: string; domain: string }>): SgSiteRef[] {
  const byId = new Map<number, SgSiteRef>();
  for (const s of live) byId.set(s.site_id, { site_id: s.site_id, url: s.url, domain: s.domain, status: s.status });
  for (const s of known) if (!byId.has(s.site_id)) byId.set(s.site_id, { site_id: s.site_id, url: s.url, domain: s.domain });
  return [...byId.values()];
}

function haystack(s: SgSiteRef): string[] {
  return [sgSiteLabel(s), s.domain, s.url].filter(Boolean).map((x) => x.toLowerCase());
}

export type SgChoiceMode = "any" | "pause" | "resume";

/**
 * Autocomplete choices: substring match on the site name, domain or URL.
 * For pausing, sites not paused are offered; for resuming, paused ones
 * (falling back to every match when the filter leaves nothing). The value is
 * the SiteGuard site id.
 */
export function sgSiteChoices(
  sites: SgSiteRef[],
  query: string,
  mode: SgChoiceMode = "any",
  isPaused: (siteId: number) => boolean = (id) => isSgSitePaused(id),
  limit = 25,
): Array<{ name: string; value: string }> {
  const q = query.trim().toLowerCase();
  const matched: Array<{ s: SgSiteRef; rank: number; label: string }> = [];
  for (const s of sites) {
    const label = sgSiteLabel(s) || s.url;
    const hay = haystack(s);
    let rank: number;
    if (!q || label.toLowerCase().startsWith(q)) rank = 0;
    else if (hay.some((h) => h.includes(q))) rank = 1;
    else continue;
    matched.push({ s, rank, label });
  }
  let pool = matched;
  if (mode !== "any") {
    const wanted = matched.filter((m) => (mode === "resume" ? isPaused(m.s.site_id) : !isPaused(m.s.site_id)));
    if (wanted.length > 0) pool = wanted;
  }
  pool.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return pool.slice(0, limit).map(({ s, label }) => {
    const emoji = isPaused(s.site_id) ? "⏸" : s.status ? sgStatusEmoji(s.status) : "❓";
    const url = s.url && s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") !== label ? ` · ${s.url}` : "";
    return { name: `${emoji} ${label}${url}`.slice(0, 100), value: String(s.site_id) };
  });
}

/**
 * Resolve the `site` option: a site id (what autocomplete sends), an exact
 * name, domain or URL (any case), or text matching exactly one site.
 * Ambiguous text is refused rather than guessed.
 */
export function resolveSgSite(sites: SgSiteRef[], value: string): { site: SgSiteRef } | { error: string } {
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const byId = sites.find((s) => s.site_id === Number(v));
    if (byId) return { site: byId };
  }
  const q = v.toLowerCase().replace(/\/$/, "");
  if (!q) return { error: "Site not found." };
  // Exact name first (subdirectory subsites share a domain), then exact URL.
  const norm = (x: string) => x.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const nq = norm(q);
  for (const exact of [
    sites.filter((s) => norm(sgSiteLabel(s)) === nq),
    sites.filter((s) => s.url && norm(s.url) === nq),
  ]) {
    if (exact.length === 1) return { site: exact[0] };
  }
  const partial = sites.filter((s) => haystack(s).some((h) => h.includes(q)));
  if (partial.length === 1) return { site: partial[0] };
  if (partial.length === 0) {
    return { error: sites.length === 0 ? "No SiteGuard sites known yet (no health data received)." : `Site not found: "${v.slice(0, 80)}".` };
  }
  const names = partial.slice(0, 5).map((s) => sgSiteLabel(s)).join(", ");
  return { error: `"${v.slice(0, 80)}" matches ${partial.length} sites (${names}${partial.length > 5 ? ", ..." : ""}). Pick one from the list.` };
}

// ---------------------------------------------------------------
// Discord output
// ---------------------------------------------------------------

/** Public confirmation of a site pause. */
export function sgSitePauseEmbed(p: SgSitePause, opts: { updated: boolean; currentStatus: string }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`⏸️ SiteGuard site ${opts.updated ? "pause updated" : "paused"}: ${p.siteLabel}`.slice(0, 256))
    .setColor(0xf1c40f)
    .setDescription(
      "No alerts, reminders, emails, tickets or phone calls for this site. " +
      "Other sites are unaffected. The site is still checked, so its state stays current and is shown on resume.",
    )
    .addFields(
      { name: "By", value: `<@${p.pausedById}>`, inline: true },
      {
        name: "Until",
        value: p.resumeAt ? `${discordTime(p.resumeAt)}, then resumes automatically` : "Someone runs `/sg-pause site-resume`",
        inline: true,
      },
    )
    .setTimestamp();
  if (p.reason) embed.addFields({ name: "Reason", value: p.reason.slice(0, 1024) });
  embed.addFields({ name: "Current status", value: opts.currentStatus.slice(0, 1024) });
  return embed;
}

/** Public notice that a site's alerts are active again (manual or automatic). */
export function sgSiteResumeEmbed(
  p: SgSitePause,
  opts: { auto: boolean; userId?: string; currentStatus: string; down: boolean; now?: number },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`▶️ SiteGuard site ${opts.auto ? "auto-resumed" : "resumed"}: ${p.siteLabel}`.slice(0, 256))
    .setColor(opts.down ? 0xe74c3c : 0x2ecc71)
    .setDescription("Alerts for this site are active again.")
    .setTimestamp();
  if (opts.userId) embed.addFields({ name: "By", value: `<@${opts.userId}>`, inline: true });
  embed.addFields(
    { name: "Paused by", value: `<@${p.pausedById}>`, inline: true },
    { name: "Paused for", value: formatDuration((opts.now ?? Date.now()) - p.pausedAt), inline: true },
  );
  if (p.reason) embed.addFields({ name: "Reason", value: p.reason.slice(0, 1024) });
  embed.addFields({ name: "Current status", value: opts.currentStatus.slice(0, 1024) });
  return embed;
}

/** Lines for `/sg-pause status`. */
export function sgSitePauseLines(pauses: SgSitePause[], now = Date.now()): string[] {
  return pauses.map((p) => {
    let line = `⏸️ **${p.siteLabel}**`;
    if (p.resumeAt !== null && p.resumeAt <= now) line += " - ending now";
    else line += p.resumeAt ? ` - until ${discordTime(p.resumeAt)}` : " - until `/sg-pause site-resume`";
    line += ` · by <@${p.pausedById}>`;
    if (p.reason) line += ` · ${p.reason.slice(0, 120)}`;
    return line;
  });
}
