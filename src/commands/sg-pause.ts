/**
 * /sg-pause - suspend SiteGuard monitoring during planned maintenance, for
 * every site (`on` / `off`) or for one site (`site` / `site-resume`, with an
 * optional duration after which it resumes by itself).
 *
 * Pausing suppresses every outward effect: Discord alerts, Zammad tickets and
 * phone calls. The poller keeps running, so site state stays current and a
 * recovery is still detected - it just does not tell anyone while paused.
 *
 * Deliberately a separate command from /sg-setup: this is an operational
 * action taken in a hurry, not configuration, and it should be obvious in the
 * command list.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { logger } from "../util/logger.js";
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { isSgPaused, setSgPaused, sgSiteStatusLine, announceSiteResume } from "../services/sgAlerts.js";
import { siteguard, sgSiteLabel } from "../services/siteguard.js";
import { markUp } from "../services/phone.js";
import { parseDuration, formatDuration, MAX_PAUSE_MS } from "../services/monitorPauses.js";
import {
  mergeSgSites,
  resolveSgSite,
  sgSiteChoices,
  getSitePause,
  saveSitePause,
  deleteSitePause,
  listSitePauses,
  isSgSitePaused,
  sgSitePauseEmbed,
  sgSitePauseLines,
  type SgSiteRef,
} from "../services/sgSitePauses.js";


export const sgPauseCommand = new SlashCommandBuilder()
  .setName("sg-pause")
  .setDescription("Pause or resume SiteGuard monitoring (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("on")
      .setDescription("Pause SiteGuard alerts, tickets and phone calls")
      .addStringOption((o) =>
        o
          .setName("reason")
          .setDescription("Why, so the channel knows (e.g. host migration)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc.setName("off").setDescription("Resume SiteGuard monitoring"),
  )
  .addSubcommand((sc) =>
    sc.setName("status").setDescription("Show whether SiteGuard monitoring is paused, and which sites are"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("site")
      .setDescription("Pause alerts for one site, optionally for a set time")
      .addStringOption((o) =>
        o.setName("site").setDescription("Site (type to search by name or URL)").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("duration")
          .setDescription("Resume automatically after e.g. 30m, 2h, 1d, 1h30m (blank = until site-resume)")
          .setRequired(false)
          .setMaxLength(20),
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Why, so the channel knows (e.g. theme update)").setRequired(false).setMaxLength(300),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("site-resume")
      .setDescription("Resume alerts for one paused site")
      .addStringOption((o) =>
        o.setName("site").setDescription("Paused site (type to search)").setRequired(true).setAutocomplete(true),
      ),
  );

/** Sites the bot knows (latest poll + remembered ones) plus any paused site no longer listed. */
function allSites(): SgSiteRef[] {
  const sites = mergeSgSites(siteguard.sites, siteguard.knownSites);
  for (const p of listSitePauses()) {
    if (!sites.some((s) => s.site_id === p.siteId)) sites.push({ site_id: p.siteId, url: p.siteUrl, domain: "" });
  }
  return sites;
}

export async function handleSgSiteAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  const mode = sub === "site" ? "pause" : sub === "site-resume" ? "resume" : "any";
  await interaction.respond(sgSiteChoices(allSites(), String(interaction.options.getFocused() ?? ""), mode));
}

async function handleSitePause(interaction: ChatInputCommandInteraction): Promise<void> {
  const found = resolveSgSite(allSites(), interaction.options.getString("site", true));
  if ("error" in found) {
    await interaction.reply({ content: found.error, ephemeral: true });
    return;
  }
  const site = found.site;

  const durationText = interaction.options.getString("duration")?.trim() || null;
  let durationMs: number | null = null;
  if (durationText) {
    durationMs = parseDuration(durationText);
    if (durationMs === null) {
      await interaction.reply({
        content: `Could not read the duration "${durationText.slice(0, 20)}". Use e.g. 30m, 2h, 1d or 1h30m.`,
        ephemeral: true,
      });
      return;
    }
    if (durationMs > MAX_PAUSE_MS) {
      await interaction.reply({ content: `The longest pause is ${formatDuration(MAX_PAUSE_MS)}.`, ephemeral: true });
      return;
    }
  }
  const reason = interaction.options.getString("reason")?.trim().slice(0, 300) || null;

  const now = Date.now();
  const label = sgSiteLabel(site);
  const existing = isSgSitePaused(site.site_id, now) ? getSitePause(site.site_id) : null;
  if (existing && !durationMs && !reason) {
    await interaction.reply({
      content: `Alerts for ${label} are already paused. Give a duration or reason to change the pause, or use \`/sg-pause site-resume\`.`,
      ephemeral: true,
    });
    return;
  }

  const pause = {
    siteId: site.site_id,
    siteLabel: label,
    siteUrl: site.url,
    pausedBy: interaction.user.tag,
    pausedById: interaction.user.id,
    reason: reason ?? existing?.reason ?? null,
    pausedAt: existing?.pausedAt ?? now,
    // Changing only the reason keeps the end time.
    resumeAt: durationMs ? now + durationMs : existing?.resumeAt ?? null,
    channelId: interaction.channelId ?? null,
  };
  saveSitePause(pause);
  // Stop a phone escalation for this site that may already be running.
  await markUp(`sg:site:${site.site_id}`).catch(() => undefined);
  await markUp(`sg:ssl:${site.site_id}`).catch(() => undefined);
  logger.warn(
    { siteId: site.site_id, site: label, by: interaction.user.tag, resumeAt: pause.resumeAt, reason: pause.reason ?? undefined, updated: !!existing },
    "SiteGuard site alerts paused",
  );

  await interaction.reply({
    embeds: [sgSitePauseEmbed(pause, { updated: !!existing, currentStatus: sgSiteStatusLine(site.site_id).line })],
    allowedMentions: NO_MENTIONS,
  });
}

async function handleSiteResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const found = resolveSgSite(allSites(), interaction.options.getString("site", true));
  if ("error" in found) {
    await interaction.reply({ content: found.error, ephemeral: true });
    return;
  }
  const site = found.site;
  const pause = getSitePause(site.site_id);
  if (!pause) {
    await interaction.reply({ content: `Alerts for ${sgSiteLabel(site)} are not paused.`, ephemeral: true });
    return;
  }
  deleteSitePause(site.site_id);
  logger.warn({ siteId: site.site_id, site: pause.siteLabel, by: interaction.user.tag }, "SiteGuard site alerts resumed");
  await announceSiteResume(interaction.client, pause, {
    auto: false,
    userId: interaction.user.id,
    send: async (embed) => { await interaction.reply({ embeds: [embed], allowedMentions: NO_MENTIONS }); },
  });
}

export async function handleSgPauseCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content: ADMINS_ONLY,
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "site") return handleSitePause(interaction);
  if (sub === "site-resume") return handleSiteResume(interaction);

  if (sub === "status") {
    const paused = isSgPaused();
    const now = Date.now();
    const sitePauses = listSitePauses();
    const embed = new EmbedBuilder()
      .setTitle("SiteGuard monitoring")
      .setColor(paused || sitePauses.length > 0 ? 0xf1c40f : 0x2ecc71)
      .setDescription(
        paused
          ? "**Paused.** No alerts, tickets or phone calls will be raised. Monitoring is still running, so recoveries are still tracked."
          : sitePauses.length > 0
            ? "**Active**, except for the sites below."
            : "**Active.** Outages will alert, open tickets and ring phones.",
      );
    if (sitePauses.length > 0) {
      let value = sgSitePauseLines(sitePauses, now).join("\n");
      if (value.length > 1024) value = value.slice(0, 1000) + "\n...";
      embed.addFields({ name: `Paused sites (${sitePauses.length})`, value });
    }
    await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: NO_MENTIONS });
    return;
  }

  const pause = sub === "on";
  setSgPaused(pause);
  const reason = interaction.options.getString("reason");
  logger.warn(
    { paused: pause, by: interaction.user.tag, reason: reason ?? undefined },
    "SiteGuard monitoring paused state changed",
  );

  // Announced publicly on purpose: a silenced monitor everyone has forgotten
  // about is worse than the outage it was meant to catch.
  const embed = new EmbedBuilder()
    .setTitle(pause ? "SiteGuard monitoring paused" : "SiteGuard monitoring resumed")
    .setColor(pause ? 0xf1c40f : 0x2ecc71)
    .setDescription(
      pause
        ? "Alerts, tickets and phone calls are suppressed until someone runs `/sg-pause off`."
        : "Alerts, tickets and phone calls are active again" +
          (listSitePauses().length > 0 ? ", except for sites paused individually (`/sg-pause status`)." : "."),
    )
    .addFields({ name: "By", value: interaction.user.tag, inline: true })
    .setTimestamp();
  if (pause && reason) embed.addFields({ name: "Reason", value: reason });

  await interaction.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
}
