/**
 * Discord + e-mail notifications for WordPress node events:
 * backups pulled / failed, restores applied, failover applied / rolled back,
 * node agent unreachable / back. Posts go to WP_ALERT_CHANNEL_ID, falling
 * back to the SiteGuard alert channel, the Kuma alert channel, then the
 * status board channel. E-mail uses the bot's SMTP settings (/setup smtp).
 */

import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting } from "../db/index.js";
import { discordQueue } from "../queue/index.js";
import { isSmtpConfigured, sendAlertEmail } from "./email.js";
import { wpops, fmtBytes, type WpEvent, type WpJob } from "./wpops.js";

const COLOR = { ok: 0x2ecc71, warn: 0xf39c12, bad: 0xe74c3c, info: 0x3498db } as const;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function channel(client: Client): Promise<TextChannel | null> {
  const id = getSetting("WP_ALERT_CHANNEL_ID") ?? getSetting("SG_ALERT_CHANNEL_ID") ?? getSetting("ALERT_CHANNEL_ID") ?? getSetting("STATUS_CHANNEL_ID");
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(id);
    return ch && ch.isTextBased() ? (ch as TextChannel) : null;
  } catch (err) {
    logger.warn({ err, id }, "wpops alert channel not available");
    return null;
  }
}

function emailEnabled(): boolean {
  return getSetting("WP_ALERT_EMAIL_ENABLED") !== "false" && isSmtpConfigured();
}

async function post(client: Client, embed: EmbedBuilder, subject: string, html: string, email = true): Promise<void> {
  const ch = await channel(client);
  if (ch) {
    try {
      await discordQueue.add(() => ch.send({ embeds: [embed] }));
    } catch (err) {
      logger.error({ err }, "wpops alert post failed");
    }
  } else {
    logger.error({ subject }, "wpops alert: no channel configured (/wp setup channel)");
  }
  if (email && emailEnabled()) await sendAlertEmail(subject, html);
}

function describeJob(j: WpJob): string {
  const p = j.params as Record<string, unknown>;
  switch (j.kind) {
    case "backup.pull": return `backup pull from **${p.source}**${p.label ? ` (${p.label})` : ""}`;
    case "restore.apply": return `restore of **${p.set}** onto stack **${p.stack}** (${p.all ? "all sites" : (p.sites as string[] | undefined)?.join(", ") || "-"})`;
    case "failover.apply": return `failover to **${p.to}** (${(p.domains as string[] | undefined)?.length ?? 0} domains)`;
    case "failover.rollback": return `failover rollback (${p.all ? "all" : (p.sites as string[] | undefined)?.join(", ") || (p.domains as string[] | undefined)?.join(", ") || "selection"})`;
    default: return j.kind;
  }
}

export function startWpopsAlerts(client: Client): void {
  wpops.on("event", (node: string, ev: WpEvent) => {
    void handleEvent(client, node, ev).catch((err) => logger.error({ err, node, ev }, "wpops event handling failed"));
  });

  wpops.on("jobFinished", (node: string, job: WpJob) => {
    const ok = job.status === "succeeded";
    const r = (job.result ?? {}) as Record<string, unknown>;
    const failed = Array.isArray(r.failed) ? (r.failed as unknown[]) : [];
    const title = ok && failed.length === 0 ? `✅ ${node}: ${describeJob(job)} finished` : `❌ ${node}: ${describeJob(job)} ${ok ? "finished with errors" : "FAILED"}`;
    const lines: string[] = [];
    if (job.error) lines.push(`Error: ${job.error.slice(0, 500)}`);
    if (job.kind === "backup.pull" && ok) {
      lines.push(`Set: \`${r.set}\` - ${fmtBytes(Number(r.bytes ?? 0))}, ${r.files} files, ${r.sites} sites`);
      lines.push("Not applied. Use **/wp restore** (or the panel) to apply it.");
      if (Array.isArray(r.pruned) && r.pruned.length) lines.push(`Pruned: ${(r.pruned as string[]).join(", ")}`);
    }
    if (job.kind === "failover.apply" || job.kind === "failover.rollback") {
      const done = Array.isArray(r.done) ? (r.done as { domain: string; status: string }[]) : [];
      lines.push(`Done: ${done.map((d) => `${d.domain} (${d.status})`).join(", ") || "none"}`);
      if (failed.length) lines.push(`Failed: ${failed.map((f) => JSON.stringify(f)).join("; ").slice(0, 800)}`);
    }
    if (job.kind === "restore.apply" && ok) lines.push(`Restored set \`${r.set}\` onto **${r.stack}**.`);
    lines.push(`Job \`${job.id}\` by ${job.actor}`);
    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join("\n")).setColor(ok && failed.length === 0 ? COLOR.ok : COLOR.bad).setTimestamp();
    const html = `<h2>${esc(title)}</h2><pre>${esc(lines.join("\n"))}</pre>`;
    void post(client, embed, `[WordPress ops] ${title.replace(/[*`]/g, "")}`, html);
    // Failover state changed: refresh the board right away.
    if (job.kind.startsWith("failover")) void wpops.poll();
  });

  wpops.on("nodeUnreachable", (node: string, msg: string) => {
    const embed = new EmbedBuilder().setTitle(`⚠️ WordPress node ${node} unreachable`).setDescription(msg.slice(0, 500)).setColor(COLOR.warn).setTimestamp();
    void post(client, embed, `[WordPress ops] node ${node} unreachable`, `<p>${esc(msg)}</p>`);
  });
  wpops.on("nodeReachable", (node: string) => {
    const embed = new EmbedBuilder().setTitle(`✅ WordPress node ${node} reachable again`).setColor(COLOR.ok).setTimestamp();
    void post(client, embed, `[WordPress ops] node ${node} reachable again`, "<p>Agent is answering again.</p>", false);
  });
  logger.info("wpops alerts started");
}

async function handleEvent(client: Client, node: string, ev: WpEvent): Promise<void> {
  // Job completions are reported through jobFinished (richer); here we cover
  // the scheduler and anything that happened without a job the bot watched.
  switch (ev.kind) {
    case "backup.pulled": {
      if (!ev.scheduled && wpopsSawJob(ev)) return;
      const embed = new EmbedBuilder()
        .setTitle(`💾 ${node}: backup pulled from ${ev.source ?? "?"}`)
        .setDescription([`Set: \`${ev.set}\` - ${fmtBytes(Number(ev.bytes ?? 0))}, ${ev.files} files, ${ev.sites} sites`,
          "Not applied. Use **/wp restore** (or the panel) to apply it.",
          Array.isArray(ev.pruned) && (ev.pruned as string[]).length ? `Pruned: ${(ev.pruned as string[]).join(", ")}` : ""].filter(Boolean).join("\n"))
        .setColor(COLOR.ok).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] backup pulled on ${node}: ${ev.set}`, `<p>${esc(ev.subject)}</p><p>Set ${esc(ev.set)}, ${fmtBytes(Number(ev.bytes ?? 0))}. Not applied automatically.</p>`);
      return;
    }
    case "backup.failed": {
      const embed = new EmbedBuilder().setTitle(`❌ ${node}: scheduled backup from ${ev.source ?? "?"} failed`).setDescription(String(ev.subject ?? "")).setColor(COLOR.bad).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] scheduled backup FAILED on ${node}`, `<p>${esc(ev.subject)}</p><pre>${esc(ev.body ?? "")}</pre>`);
      return;
    }
    case "failover.applied": {
      const domains = Array.isArray(ev.domains) ? (ev.domains as string[]) : [];
      const failed = Array.isArray(ev.failed) ? (ev.failed as unknown[]) : [];
      const embed = new EmbedBuilder()
        .setTitle(`🚑 FAILOVER on ${node}: ${domains.length} domain(s) now on the backup${failed.length ? ` (${failed.length} failed)` : ""}`)
        .setDescription([`To: **${ev.to}**`, domains.map((d) => `• ${d}`).join("\n") || "none", failed.length ? `Failed: ${JSON.stringify(failed).slice(0, 600)}` : "", `By ${ev.actor ?? "?"}`].filter(Boolean).join("\n"))
        .setColor(COLOR.bad).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] FAILOVER applied on ${node}`, `<p>${esc(ev.subject)}</p><pre>${esc(domains.join("\n"))}</pre>`);
      void wpops.poll();
      return;
    }
    case "failover.rolledback": {
      const domains = Array.isArray(ev.domains) ? (ev.domains as string[]) : [];
      const failed = Array.isArray(ev.failed) ? (ev.failed as unknown[]) : [];
      const embed = new EmbedBuilder()
        .setTitle(`↩️ Rollback on ${node}: ${domains.length} domain(s) back on primary${failed.length ? ` (${failed.length} failed)` : ""}`)
        .setDescription([domains.map((d) => `• ${d}`).join("\n") || "none", failed.length ? `Failed: ${JSON.stringify(failed).slice(0, 600)}` : "", `By ${ev.actor ?? "?"}`].filter(Boolean).join("\n"))
        .setColor(COLOR.ok).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] rollback on ${node}`, `<p>${esc(ev.subject)}</p><pre>${esc(domains.join("\n"))}</pre>`);
      void wpops.poll();
      return;
    }
    case "restore.applied": {
      const embed = new EmbedBuilder().setTitle(`🧩 ${node}: backup applied on stack ${ev.stack ?? "?"}`)
        .setDescription(`Set \`${ev.set}\` restored (${Array.isArray(ev.sites) ? (ev.sites as string[]).join(", ") : ev.sites ?? "all sites"}).`).setColor(COLOR.ok).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] backup applied on ${node}`, `<p>${esc(ev.subject)}</p>`);
      return;
    }
    case "scheduler.error":
    case "api.error": {
      const embed = new EmbedBuilder().setTitle(`⚠️ ${node}: agent error`).setDescription(String(ev.error ?? ev.subject ?? "").slice(0, 500)).setColor(COLOR.warn).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] agent error on ${node}`, `<p>${esc(ev.error ?? "")}</p>`, false);
      return;
    }
    default:
      return;
  }
}

/** Events produced by jobs the bot already announced through jobFinished are skipped. */
function wpopsSawJob(ev: WpEvent): boolean {
  const set = String(ev.set ?? "");
  for (const snap of wpops.snapshots.values()) {
    for (const j of snap.status?.jobs.recent ?? []) {
      const r = (j.result ?? {}) as Record<string, unknown>;
      if (j.kind === "backup.pull" && r.set === set && j.actor !== "scheduler") return true;
    }
  }
  return false;
}
