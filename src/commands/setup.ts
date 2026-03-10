import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setSetting, deleteSetting, getSetting } from "../db/index.js";
import { env } from "../util/env.js";
import { kuma } from "../services/kuma.js";

function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length === 0 || ids.includes(userId);
}

export const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Bot setup commands (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Set the channel for the auto-updating status board")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for the status board").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("alerts")
      .setDescription("Set the channel for @everyone alerts (down/disconnect)")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for alerts").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("timezone")
      .setDescription("Set the bot's default timezone")
      .addStringOption((o) =>
        o.setName("tz").setDescription("IANA timezone (e.g. America/New_York)").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("alerts-toggle")
      .setDescription("Enable or disable specific alert types")
      .addStringOption((o) =>
        o.setName("type").setDescription("Alert type").setRequired(true)
          .addChoices(
            { name: "Down alerts (@everyone when service goes down)", value: "down" },
            { name: "Recovery alerts (service comes back up)", value: "recovery" },
            { name: "Disconnect alerts (@everyone when Kuma connection lost)", value: "disconnect" },
          )
      )
      .addStringOption((o) =>
        o.setName("state").setDescription("Enable or disable").setRequired(true)
          .addChoices(
            { name: "Enable", value: "on" },
            { name: "Disable", value: "off" },
          )
      )
  )
  .addSubcommand((sc) =>
    sc.setName("show").setDescription("Show current bot configuration")
  );

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "You are not authorised to use setup commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "status": return await handleStatusSetup(interaction);
      case "alerts": return await handleAlertsSetup(interaction);
      case "timezone": return await handleTimezoneSetup(interaction);
      case "alerts-toggle": return await handleAlertsToggle(interaction);
      case "show": return await handleShowSetup(interaction);
      default:
        await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
    }
  } catch (err) {
    logger.error({ sub, err }, "Setup command error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${msg}`);
    } else {
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

async function handleStatusSetup(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("channel", true);
  setSetting("STATUS_CHANNEL_ID", channel.id);
  await interaction.reply({
    content: `Status board channel set to <#${channel.id}>. The status embed will appear shortly.`,
    ephemeral: true,
  });
  logger.info({ channelId: channel.id }, "Status channel configured");
}

async function handleAlertsSetup(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("channel", true);
  setSetting("ALERT_CHANNEL_ID", channel.id);
  await interaction.reply({
    content: `Alert channel set to <#${channel.id}>. @everyone alerts for outages will be sent there.`,
    ephemeral: true,
  });
  logger.info({ channelId: channel.id }, "Alert channel configured");
}

async function handleTimezoneSetup(interaction: ChatInputCommandInteraction) {
  const tz = interaction.options.getString("tz", true).trim();

  try {
    new Date().toLocaleString("en-US", { timeZone: tz });
  } catch {
    await interaction.reply({
      content: `Invalid timezone: \`${tz}\`. Use IANA format like \`America/New_York\`.`,
      ephemeral: true,
    });
    return;
  }

  setSetting("TIMEZONE", tz);
  const now = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  await interaction.reply({ content: `Timezone set to **${tz}**. Current time: ${now}`, ephemeral: true });
  logger.info({ tz }, "Timezone updated");
}

async function handleAlertsToggle(interaction: ChatInputCommandInteraction) {
  const type = interaction.options.getString("type", true);
  const state = interaction.options.getString("state", true);
  const key = `ALERT_${type.toUpperCase()}_ENABLED`;

  if (state === "on") {
    deleteSetting(key); // Default is enabled, so remove override
    await interaction.reply({ content: `\u2705 **${type}** alerts enabled.`, ephemeral: true });
  } else {
    setSetting(key, "false");
    await interaction.reply({ content: `\u274C **${type}** alerts disabled.`, ephemeral: true });
  }
  logger.info({ type, state }, "Alert toggle updated");
}

async function handleShowSetup(interaction: ChatInputCommandInteraction) {
  const statusChannel = getSetting("STATUS_CHANNEL_ID");
  const alertChannel = getSetting("ALERT_CHANNEL_ID");
  const timezone = getSetting("TIMEZONE");
  const summary = kuma.connected ? kuma.getSummary() : null;

  const downEnabled = getSetting("ALERT_DOWN_ENABLED") !== "false";
  const recoveryEnabled = getSetting("ALERT_RECOVERY_ENABLED") !== "false";
  const disconnectEnabled = getSetting("ALERT_DISCONNECT_ENABLED") !== "false";

  const lines = [
    "**Bot Configuration:**",
    "",
    `**Uptime Kuma:** ${kuma.connected ? `\u{1F7E2} Connected (v${kuma.serverInfo.version ?? "?"})` : "\u{1F534} Disconnected"}`,
    summary ? `**Monitors:** ${summary.up}/${summary.active} up (${summary.total} total)` : "",
    "",
    `**Status Board Channel:** ${statusChannel ? `<#${statusChannel}>` : "*not set - use `/setup status`*"}`,
    `**Alert Channel:** ${alertChannel ? `<#${alertChannel}>` : "*not set - use `/setup alerts`*"}`,
    `**Timezone:** ${timezone ?? "*system default*"}`,
    "",
    "**Alert Types:**",
    `  Down alerts: ${downEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  Recovery alerts: ${recoveryEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  Disconnect alerts: ${disconnectEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
  ];

  await interaction.reply({ content: lines.filter(Boolean).join("\n"), ephemeral: true });
}
