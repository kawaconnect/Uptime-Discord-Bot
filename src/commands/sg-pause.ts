/**
 * /sg-pause - suspend SiteGuard monitoring during planned maintenance.
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
} from "discord.js";
import { logger } from "../util/logger.js";
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { isSgPaused, setSgPaused } from "../services/sgAlerts.js";


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
    sc.setName("status").setDescription("Show whether SiteGuard monitoring is paused"),
  );

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

  if (sub === "status") {
    const paused = isSgPaused();
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("SiteGuard monitoring")
          .setColor(paused ? 0xf1c40f : 0x2ecc71)
          .setDescription(
            paused
              ? "**Paused.** No alerts, tickets or phone calls will be raised. Monitoring is still running, so recoveries are still tracked."
              : "**Active.** Outages will alert, open tickets and ring phones.",
          ),
      ],
      ephemeral: true,
    });
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
        : "Alerts, tickets and phone calls are active again.",
    )
    .addFields({ name: "By", value: interaction.user.tag, inline: true })
    .setTimestamp();
  if (pause && reason) embed.addFields({ name: "Reason", value: reason });

  await interaction.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
}
