/**
 * /maintenance - silence every alert and phone call for a set time, e.g.
 * while hypervisors are being upgraded.
 *
 *   /maintenance start duration:2h reason:"proxmox upgrades"
 *   /maintenance end
 *   /maintenance status
 *
 * Admin only (ADMIN_USER_IDS), like /sg-pause; status is open to anyone who
 * can see the command. Start and end each post one notice to the alert
 * channel; the person running the command gets a private confirmation.
 * See services/maintenance.ts for what is suppressed and how.
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { parseDuration, formatDuration, discordTime } from "../services/monitorPauses.js";
import {
  MAX_MAINTENANCE_MS,
  getMaintenance,
  maintenanceStartEmbed,
  maintenanceEndEmbed,
  maintenanceStatusEmbed,
} from "../services/maintenance.js";
import { startMaintenance, endMaintenance } from "../services/maintenanceRun.js";

export const maintenanceCommand = new SlashCommandBuilder()
  .setName("maintenance")
  .setDescription("Pause all alerts and phone calls for a maintenance window (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("start")
      .setDescription("Pause all alerts, pings, e-mails, tickets and phone calls for a set time")
      .addStringOption((o) =>
        o
          .setName("duration")
          .setDescription("How long, e.g. 30m, 2h, 1h30m, 1d (alerts resume by themselves after it)")
          .setRequired(true)
          .setMaxLength(20),
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Why, so the channel knows (e.g. proxmox upgrades)").setRequired(false).setMaxLength(300),
      ),
  )
  .addSubcommand((sc) =>
    sc.setName("end").setDescription("End the maintenance window now; anything still down alerts normally"),
  )
  .addSubcommand((sc) =>
    sc.setName("status").setDescription("Show whether a maintenance window is active, until when, and what it held back"),
  );

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const durationText = interaction.options.getString("duration", true).trim();
  const durationMs = parseDuration(durationText);
  if (durationMs === null) {
    await interaction.reply({
      content: `Could not read the duration "${durationText.slice(0, 20)}". Use e.g. 30m, 2h, 1d or 1h30m.`,
      ephemeral: true,
    });
    return;
  }
  if (durationMs > MAX_MAINTENANCE_MS) {
    await interaction.reply({ content: `The longest maintenance window is ${formatDuration(MAX_MAINTENANCE_MS)}.`, ephemeral: true });
    return;
  }
  const reason = interaction.options.getString("reason")?.trim().slice(0, 300) || null;

  const out = await startMaintenance(interaction.client, {
    durationMs,
    reason,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    channelId: interaction.channelId ?? null,
  });

  if (!out.posted) {
    // No alert channel: the notice must still be seen, so it goes here, publicly.
    await interaction.reply({ embeds: [maintenanceStartEmbed(out.window, { updated: out.updated, userId: interaction.user.id })], allowedMentions: NO_MENTIONS });
    return;
  }
  await interaction.reply({
    content: `${out.updated ? "Maintenance window updated" : "Maintenance window started"}: alerts and phone calls are paused until ${discordTime(out.window.endsAt)}. Announced in the alert channel.`,
    ephemeral: true,
  });
}

async function handleEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const out = await endMaintenance(interaction.client, { userId: interaction.user.id });
  if (!out) {
    await interaction.reply({ content: "No maintenance window is active.", ephemeral: true });
    return;
  }
  if (!out.posted) {
    await interaction.reply({
      embeds: [maintenanceEndEmbed(out.window, { auto: false, userId: interaction.user.id, now: Date.now(), stillDown: out.stillDown })],
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  await interaction.reply({
    content:
      `Maintenance window ended: alerts and phone calls are active again. ${out.window.suppressed} alert${out.window.suppressed === 1 ? " was" : "s were"} suppressed` +
      (out.stillDown.length > 0 ? `; ${out.stillDown.length} still down, alerting normally now.` : "."),
    ephemeral: true,
  });
}

export async function handleMaintenanceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "status") {
    await interaction.reply({ embeds: [maintenanceStatusEmbed(getMaintenance())], ephemeral: true, allowedMentions: NO_MENTIONS });
    return;
  }

  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: ADMINS_ONLY, ephemeral: true });
    return;
  }

  if (sub === "start") return handleStart(interaction);
  if (sub === "end") return handleEnd(interaction);
  await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
}
