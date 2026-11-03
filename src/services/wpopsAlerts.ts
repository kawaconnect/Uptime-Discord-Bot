/**
 * Discord + e-mail notifications for WordPress node events:
 * backups pulled / failed, restores applied, failover applied / rolled back,
 * node agent unreachable / back. Posts go to WP_ALERT_CHANNEL_ID, falling
 * back to the SiteGuard alert channel, the Kuma alert channel, then the
 * status board channel. E-mail uses the bot's SMTP settings (/setup smtp).
 * None of them go out during a maintenance window (/maintenance); each one
 * held back is logged and counted in the window's summary.
 */

import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting } from "../db/index.js";
import { discordQueue } from "../queue/index.js";
import { isSmtpConfigured, sendAlertEmail } from "./email.js";
import { wpops, fmtBytes, type WpEvent, type WpJob } from "./wpops.js";
import type { NodeSgSite } from "./nodeSites.js";
import { suppressedByMaintenance } from "./maintenance.js";

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
  if (suppressedByMaintenance("wpops", { subject })) return;
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
    if (job.kind === "registry.refresh") return;   // routine; the sites themselves are reported below
    const ok = job.status === "succeeded";
    // Backup pulls: nothing per job. A scheduled run is reported once, by the
    // agent's run summary (backup.run_failed) and only when something failed.
    // A pull someone started by hand gets one Discord line, never an e-mail.
    if (job.kind === "backup.pull") {
      if (job.actor === "scheduler") return;
      const r0 = (job.result ?? {}) as Record<string, unknown>;
      const t = ok ? `✅ ${node}: ${describeJob(job)} finished` : `❌ ${node}: ${describeJob(job)} FAILED`;
      const d = ok ? `Set \`${r0.set}\` - ${fmtBytes(Number(r0.bytes ?? 0))}` : `Error: ${(job.error || "unknown").slice(0, 500)}`;
      void post(client, new EmbedBuilder().setTitle(t).setDescription(d).setColor(ok ? COLOR.ok : COLOR.bad).setTimestamp(), "", "", false);
      return;
    }
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

  // Sites joining or leaving a node's registry: one short notice per node and
  // poll (never e-mailed). They are monitored (or dropped) automatically.
  wpops.on("sitesChanged", (node: string, added: NodeSgSite[], removed: NodeSgSite[]) => {
    const name = (s: NodeSgSite) => `\`${s.uid}\` ${s.url}${s.slug ? ` (${s.slug})` : ""}`;
    const lines: string[] = [];
    if (added.length) lines.push(`**Now monitored (${added.length}):**`, ...added.slice(0, 15).map((s) => `• ${name(s)}`));
    if (added.length > 15) lines.push(`… ${added.length - 15} more`);
    if (removed.length) lines.push(`**No longer on the node (${removed.length}):**`, ...removed.slice(0, 15).map((s) => `• ${name(s)}`));
    if (removed.length > 15) lines.push(`… ${removed.length - 15} more`);
    const title = `🗂️ ${node}: ${added.length ? `${added.length} site(s) added` : ""}${added.length && removed.length ? ", " : ""}${removed.length ? `${removed.length} removed` : ""}`;
    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join("\n").slice(0, 4000)).setColor(COLOR.info).setTimestamp();
    void post(client, embed, `[WordPress ops] ${title}`, "", false);
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
    case "backup.pulled":
      // One per source per run: never posted or e-mailed (see backup.run_failed).
      return;
    case "backup.failed": {
      // Older agents report each failed source separately: Discord only, no e-mail.
      const embed = new EmbedBuilder().setTitle(`❌ ${node}: scheduled backup from ${ev.source ?? "?"} failed`).setDescription(String(ev.subject ?? "")).setColor(COLOR.bad).setTimestamp(ev.ts * 1000);
      await post(client, embed, "", "", false);
      return;
    }
    case "backup.run_failed": {
      // Agents from WPMultisiteDocker 0.0.12: one summary per scheduled run, sent only on failure.
      const failed = Array.isArray(ev.failed) ? (ev.failed as { source: string; error?: string }[]) : [];
      const total = Number(ev.total ?? 0);
      const lines = failed.slice(0, 25).map((f) => `• **${f.source}**: ${String(f.error ?? "").slice(0, 150)}`);
      if (failed.length > 25) lines.push(`… ${failed.length - 25} more`);
      const title = `❌ ${node}: nightly backup - ${failed.length} of ${total} source(s) failed`;
      const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join("\n").slice(0, 4000) || String(ev.subject ?? "")).setColor(COLOR.bad).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] ${title}`, `<h2>${esc(title)}</h2><pre>${esc(lines.join("\n"))}</pre>`);
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
    case "disk.low": {
      const gb = (n: unknown) => `${Math.round(Number(n ?? 0) / 2 ** 30)} GB`;
      const embed = new EmbedBuilder().setTitle(`\u{1F4BE}\u26A0\uFE0F ${node}: LOW DISK - ${ev.label ?? ev.path}`)
        .setDescription([`${gb(ev.free)} free of ${gb(ev.total)} (${ev.free_pct}%) on \`${ev.path}\``,
          "Backup pulls and restores on this node are refused until space is freed.",
          "Free space: **/wp backup list** then delete old sets, or lower the retention with **/wp backup schedule**."].join("\n"))
        .setColor(COLOR.bad).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] LOW DISK on ${node}: ${gb(ev.free)} free`, `<p>${esc(ev.subject)}</p><p>${gb(ev.free)} free of ${gb(ev.total)} on ${esc(ev.path)}. Pulls and restores are refused until space is freed.</p>`);
      return;
    }
    case "disk.ok": {
      const gb = (n: unknown) => `${Math.round(Number(n ?? 0) / 2 ** 30)} GB`;
      const embed = new EmbedBuilder().setTitle(`\u{1F4BE}\u2705 ${node}: disk space recovered - ${ev.label ?? ev.path}`)
        .setDescription(`${gb(ev.free)} free of ${gb(ev.total)} (${ev.free_pct}%) on \`${ev.path}\``).setColor(COLOR.ok).setTimestamp(ev.ts * 1000);
      await post(client, embed, `[WordPress ops] disk space recovered on ${node}`, `<p>${esc(ev.subject)}</p>`);
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
