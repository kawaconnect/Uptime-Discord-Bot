/**
 * SiteGuard setup commands - admin-only configuration for the
 * WordPress health monitoring module. Independent from Kuma setup.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setSetting, deleteSetting, getSetting } from "../db/index.js";
import { env } from "../util/env.js";
import { siteguard } from "../services/siteguard.js";
import { startSgStatusBoard } from "../services/sgStatusBoard.js";
import { startSgAlerts } from "../services/sgAlerts.js";

function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length === 0 || ids.includes(userId);
}

export const sgSetupCommand = new SlashCommandBuilder()
  .setName("sg-setup")
  .setDescription("SiteGuard health monitor setup (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Set the SiteGuard status board channel")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for the SG status board").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("alerts")
      .setDescription("Set the SiteGuard alert channel")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for SG alerts").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("alerts-toggle")
      .setDescription("Toggle SiteGuard alert types")
      .addStringOption((o) =>
        o.setName("type").setDescription("Alert type").setRequired(true)
          .addChoices(
            { name: "Site down (@everyone)", value: "site_down" },
            { name: "Site recovery", value: "site_recovery" },
            { name: "SSL expiring", value: "ssl_expiring" },
            { name: "WordPress unreachable (@everyone)", value: "wp_unreachable" },
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
    sc.setName("show").setDescription("Show SiteGuard monitor configuration")
  )
  .addSubcommand((sc) =>
    sc
      .setName("connect")
      .setDescription("Connect to a SiteGuard WordPress health endpoint")
      .addStringOption((o) =>
        o.setName("url").setDescription("Health endpoint URL (e.g. https://example.com/wp-json/sgbackup/v1/health)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("api_key").setDescription("API key from SiteGuard plugin Health Monitor tab").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc.setName("disconnect").setDescription("Disconnect from the SiteGuard health endpoint")
  );

export async function handleSgSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "You are not authorised to use SG setup commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "status": return await handleSgStatusSetup(interaction);
      case "alerts": return await handleSgAlertsSetup(interaction);
      case "alerts-toggle": return await handleSgAlertsToggle(interaction);
      case "show": return await handleSgShowSetup(interaction);
      case "connect": return await handleSgConnect(interaction);
      case "disconnect": return await handleSgDisconnect(interaction);
      default:
        await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
    }
  } catch (err) {
    logger.error({ sub, err }, "SG setup command error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${msg}`);
    } else {
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

async function handleSgStatusSetup(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("channel", true);
  setSetting("SG_STATUS_CHANNEL_ID", channel.id);
  await interaction.reply({
    content: `SiteGuard status board channel set to <#${channel.id}>. The health status embed will appear shortly.`,
    ephemeral: true,
  });
  logger.info({ channelId: channel.id }, "SG status channel configured");
}

async function handleSgAlertsSetup(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel("channel", true);
  setSetting("SG_ALERT_CHANNEL_ID", channel.id);
  await interaction.reply({
    content: `SiteGuard alert channel set to <#${channel.id}>. Alerts for site outages and SSL warnings will be sent there.`,
    ephemeral: true,
  });
  logger.info({ channelId: channel.id }, "SG alert channel configured");
}

async function handleSgAlertsToggle(interaction: ChatInputCommandInteraction) {
  const type = interaction.options.getString("type", true);
  const state = interaction.options.getString("state", true);
  const key = `SG_ALERT_${type.toUpperCase()}_ENABLED`;

  if (state === "on") {
    deleteSetting(key);
    await interaction.reply({ content: `\u2705 SiteGuard **${type.replace("_", " ")}** alerts enabled.`, ephemeral: true });
  } else {
    setSetting(key, "false");
    await interaction.reply({ content: `\u274C SiteGuard **${type.replace("_", " ")}** alerts disabled.`, ephemeral: true });
  }
  logger.info({ type, state }, "SG alert toggle updated");
}

async function handleSgShowSetup(interaction: ChatInputCommandInteraction) {
  const statusChannel = getSetting("SG_STATUS_CHANNEL_ID");
  const alertChannel = getSetting("SG_ALERT_CHANNEL_ID");
  const config = env();

  const siteDownEnabled = getSetting("SG_ALERT_SITE_DOWN_ENABLED") !== "false";
  const siteRecoveryEnabled = getSetting("SG_ALERT_SITE_RECOVERY_ENABLED") !== "false";
  const sslExpiringEnabled = getSetting("SG_ALERT_SSL_EXPIRING_ENABLED") !== "false";
  const wpUnreachableEnabled = getSetting("SG_ALERT_WP_UNREACHABLE_ENABLED") !== "false";

  const summary = siteguard.data ? siteguard.getSummary() : null;

  const lines = [
    "**SiteGuard Health Monitor Configuration:**",
    "",
    `**WordPress Endpoint:** ${siteguard.getUrl() ?? "*not configured*"}`,
    `**Connection:** ${siteguard.isConfigured ? (siteguard.reachable ? "\u{1F7E2} Reachable" : "\u{1F534} Unreachable") : "\u26AA Not configured"}`,
    summary ? `**Sites:** ${summary.operational}/${summary.total} operational` : "",
    siteguard.data ? `**SiteGuard Version:** ${siteguard.data.version}` : "",
    `**Poll Interval:** ${(config.SG_HEALTH_POLL_MS ?? 60000) / 1000}s`,
    "",
    `**Status Board Channel:** ${statusChannel ? `<#${statusChannel}>` : "*not set - use `/sg-setup status`*"}`,
    `**Alert Channel:** ${alertChannel ? `<#${alertChannel}>` : "*not set - use `/sg-setup alerts`*"}`,
    "",
    "**Alert Types:**",
    `  Site down: ${siteDownEnabled ? "\u2705 enabled (@everyone)" : "\u274C disabled"}`,
    `  Site recovery: ${siteRecoveryEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  SSL expiring: ${sslExpiringEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  WP unreachable: ${wpUnreachableEnabled ? "\u2705 enabled (@everyone)" : "\u274C disabled"}`,
  ];

  await interaction.reply({ content: lines.filter(Boolean).join("\n"), ephemeral: true });
}

async function handleSgConnect(interaction: ChatInputCommandInteraction) {
  const url = interaction.options.getString("url", true).trim();
  const apiKey = interaction.options.getString("api_key", true).trim();

  // Validate URL format
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      await interaction.reply({ content: "URL must use http:// or https://", ephemeral: true });
      return;
    }
  } catch {
    await interaction.reply({ content: "Invalid URL format.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Store in DB
  setSetting("SG_HEALTH_URL", url);
  setSetting("SG_HEALTH_API_KEY", apiKey);

  // Test connection
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403) {
      await interaction.editReply(`\u274C **Authentication failed** (HTTP ${response.status}). Check the API key and try again.`);
      deleteSetting("SG_HEALTH_URL");
      deleteSetting("SG_HEALTH_API_KEY");
      return;
    }

    if (!response.ok) {
      await interaction.editReply(`\u26A0\uFE0F Connected but got HTTP ${response.status}. The endpoint may not be set up correctly. Config saved - will retry on next poll.`);
    } else {
      const data = await response.json() as any;
      const siteCount = data.sites?.length ?? 0;
      const version = data.version ?? "unknown";

      // Start or restart the monitor
      siteguard.restart();

      // Start services if not already running (first-time connect via slash command)
      siteguard.once("updated", () => {
        startSgStatusBoard(interaction.client);
        startSgAlerts(interaction.client);
      });

      await interaction.editReply(
        `\u2705 **Connected to SiteGuard!**\n\n` +
        `**Endpoint:** ${url}\n` +
        `**Version:** ${version}\n` +
        `**Sites detected:** ${siteCount}\n` +
        `**Overall status:** ${data.status?.toUpperCase() ?? "UNKNOWN"}\n\n` +
        `Use \`/sg-setup status #channel\` to set up the status board, and \`/sg-setup alerts #channel\` for alerts.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(
      `\u26A0\uFE0F Could not reach the endpoint: ${msg}\n\n` +
      `Config saved anyway - the bot will retry polling. Make sure the WordPress site is accessible from this server.`
    );
    // Still restart with saved config
    siteguard.restart();
    siteguard.once("updated", () => {
      startSgStatusBoard(interaction.client);
      startSgAlerts(interaction.client);
    });
  }

  logger.info({ url }, "SG health endpoint configured via slash command");
}

async function handleSgDisconnect(interaction: ChatInputCommandInteraction) {
  deleteSetting("SG_HEALTH_URL");
  deleteSetting("SG_HEALTH_API_KEY");
  siteguard.stop();

  await interaction.reply({
    content: "\u2705 SiteGuard health monitor disconnected. Polling stopped.\n\nTo reconnect, use `/sg-setup connect <url> <api_key>`.",
    ephemeral: true,
  });
  logger.info("SG health endpoint disconnected via slash command");
}
