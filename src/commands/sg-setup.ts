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
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { siteguard, classifySgError } from "../services/siteguard.js";
import { checkSecureUrl } from "../util/url.js";
import { startSgAlerts } from "../services/sgAlerts.js";
import { getTicketConfig, testTicketing } from "../services/tickets.js";


export const sgSetupCommand = new SlashCommandBuilder()
  .setName("sg-setup")
  .setDescription("SiteGuard health monitor setup (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
            { name: "Site down", value: "site_down" },
            { name: "Site recovery", value: "site_recovery" },
            { name: "SSL expiring", value: "ssl_expiring" },
            { name: "WordPress unreachable", value: "wp_unreachable" },
            { name: "Health data stale (WP cron dead)", value: "data_stale" },
            { name: "Repeat reminders while down/unreachable", value: "repeat" },
            { name: "Zammad tickets for incidents", value: "tickets" },
            { name: "@everyone mentions for SG alerts (default: on)", value: "sg_mention" },
            { name: "Email alerts for SG (default: on)", value: "sg_email" },
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
  )
  .addSubcommand((sc) =>
    sc
      .setName("tickets")
      .setDescription("Configure Zammad ticket creation for incidents (site down / WordPress unreachable)")
      .addStringOption((o) => o.setName("url").setDescription("Zammad base URL (e.g. https://help.example.com)").setRequired(true))
      .addStringOption((o) => o.setName("token").setDescription("Zammad API token (ticket.agent permission)").setRequired(true))
      .addStringOption((o) => o.setName("group").setDescription("Zammad group for new tickets (default: Users)"))
      .addStringOption((o) => o.setName("customer").setDescription("Customer email to file tickets under"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("repeat")
      .setDescription("Minutes between reminder alerts while a site stays down / WordPress stays unreachable (0 = off)")
      .addIntegerOption((o) => o.setName("minutes").setDescription("Reminder interval in minutes (default 30)").setRequired(true).setMinValue(0).setMaxValue(1440))
  );

export async function handleSgSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: ADMINS_ONLY, ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "alerts": return await handleSgAlertsSetup(interaction);
      case "alerts-toggle": return await handleSgAlertsToggle(interaction);
      case "show": return await handleSgShowSetup(interaction);
      case "connect": return await handleSgConnect(interaction);
      case "disconnect": return await handleSgDisconnect(interaction);
      case "tickets": return await handleSgTickets(interaction);
      case "repeat": return await handleSgRepeat(interaction);
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

  // @everyone mention toggle for SiteGuard (default: ON)
  if (type === "sg_mention") {
    if (state === "on") {
      deleteSetting("SG_ALERT_MENTION_ENABLED"); // default is on
      await interaction.reply({ content: "\u2705 @everyone mentions **enabled** for SiteGuard alerts (default).", ephemeral: true });
    } else {
      setSetting("SG_ALERT_MENTION_ENABLED", "false");
      await interaction.reply({ content: "\u274C @everyone mentions **disabled** for SiteGuard alerts.", ephemeral: true });
    }
    logger.info({ type, state }, "SG mention toggle updated");
    return;
  }

  // Email toggle for SiteGuard (default: ON)
  if (type === "sg_email") {
    if (state === "on") {
      deleteSetting("SG_ALERT_EMAIL_ENABLED"); // default is on
      await interaction.reply({ content: "\u2705 Email alerts **enabled** for SiteGuard alerts (default).", ephemeral: true });
    } else {
      setSetting("SG_ALERT_EMAIL_ENABLED", "false");
      await interaction.reply({ content: "\u274C Email alerts **disabled** for SiteGuard alerts.", ephemeral: true });
    }
    logger.info({ type, state }, "SG email toggle updated");
    return;
  }

  if (type === "tickets") {
    if (state === "on") deleteSetting("TICKETS_ENABLED"); else setSetting("TICKETS_ENABLED", "false");
    await interaction.reply({ content: state === "on" ? "\u2705 Zammad ticket creation **enabled** (when Zammad is configured)." : "\u274C Zammad ticket creation **disabled**.", ephemeral: true });
    return;
  }

  // Standard SiteGuard alert toggles (default: ON)
  const key = `SG_ALERT_${type.toUpperCase()}_ENABLED`;

  if (state === "on") {
    deleteSetting(key);
    await interaction.reply({ content: `\u2705 SiteGuard **${type.replace(/_/g, " ")}** alerts enabled.`, ephemeral: true });
  } else {
    setSetting(key, "false");
    await interaction.reply({ content: `\u274C SiteGuard **${type.replace(/_/g, " ")}** alerts disabled.`, ephemeral: true });
  }
  logger.info({ type, state }, "SG alert toggle updated");
}

async function handleSgShowSetup(interaction: ChatInputCommandInteraction) {
  const alertChannel = getSetting("SG_ALERT_CHANNEL_ID");
  const config = env();

  const siteDownEnabled = getSetting("SG_ALERT_SITE_DOWN_ENABLED") !== "false";
  const siteRecoveryEnabled = getSetting("SG_ALERT_SITE_RECOVERY_ENABLED") !== "false";
  const sslExpiringEnabled = getSetting("SG_ALERT_SSL_EXPIRING_ENABLED") !== "false";
  const wpUnreachableEnabled = getSetting("SG_ALERT_WP_UNREACHABLE_ENABLED") !== "false";
  const mentionEnabled = getSetting("SG_ALERT_MENTION_ENABLED") !== "false";
  const emailEnabled = getSetting("SG_ALERT_EMAIL_ENABLED") !== "false";

  const summary = siteguard.data ? siteguard.getSummary() : null;
  const statusChannel = getSetting("STATUS_CHANNEL_ID");
  const ticketCfg = getTicketConfig();
  const repeatMin = parseInt(getSetting("SG_ALERT_REPEAT_MIN") ?? String(config.SG_ALERT_REPEAT_MIN ?? 30), 10);

  const lines = [
    "**SiteGuard Health Monitor Configuration:**",
    "",
    `**WordPress Endpoint:** ${siteguard.getUrl() ?? "*not configured*"}`,
    `**Connection:** ${siteguard.isConfigured ? (siteguard.reachable ? "\u{1F7E2} Reachable" : "\u{1F534} Unreachable") : "\u26AA Not configured"}`,
    summary ? `**Sites:** ${summary.operational}/${summary.total} operational` : "",
    siteguard.data ? `**SiteGuard Version:** ${siteguard.data.version}` : "",
    `**Poll Interval:** ${(config.SG_HEALTH_POLL_MS ?? 60000) / 1000}s`,
    "",
    `**Alert Channel:** ${alertChannel ? `<#${alertChannel}>` : (statusChannel ? `*not set - falling back to status channel <#${statusChannel}>* (use \`/sg-setup alerts\`)` : "\u{1F6A8} **NOT SET and no status channel - alerts cannot be delivered!** Use `/sg-setup alerts`")}`,
    `**Reminders while down:** ${repeatMin > 0 ? `every ${repeatMin} min` : "off"}`,
    `**Zammad tickets:** ${ticketCfg ? `\u2705 ${ticketCfg.baseUrl} (group ${ticketCfg.group})` : "\u26AA not configured - use `/sg-setup tickets`"}`,
    "",
    "**Alert Types:**",
    `  Site down: ${siteDownEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  Site recovery: ${siteRecoveryEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  SSL expiring: ${sslExpiringEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  WP unreachable: ${wpUnreachableEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    "",
    "**Notification Channels:**",
    `  @everyone mentions: ${mentionEnabled ? "\u2705 enabled (default)" : "\u274C disabled"}`,
    `  Email alerts: ${emailEnabled ? "\u2705 enabled (default)" : "\u274C disabled"}`,
  ];

  await interaction.reply({ content: lines.filter(Boolean).join("\n"), ephemeral: true });
}

async function handleSgConnect(interaction: ChatInputCommandInteraction) {
  const url = interaction.options.getString("url", true).trim();
  const apiKey = interaction.options.getString("api_key", true).trim();

  // The API key goes out as a bearer token: https only (http for local dev hosts).
  const checked = checkSecureUrl(url);
  if (!checked.ok) {
    await interaction.reply({ content: checked.error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Test first, so a rejected key does not replace a working configuration.
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? "Timeout after 15s" : err.message) : String(err);
    saveAndStart(interaction, url, apiKey);
    await interaction.editReply(
      `\u26A0\uFE0F Could not reach the endpoint: ${msg}\n\n` +
      `Config saved anyway - the bot is polling and will alert while it stays unreachable. Make sure the WordPress site is accessible from this server.`
    );
    return;
  }

  if (response.status === 401 || response.status === 403) {
    await interaction.editReply(`\u274C **Authentication failed** (HTTP ${response.status}). Check the API key and try again. Nothing was changed.`);
    return;
  }

  if (!response.ok) {
    let body: unknown = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    const err = classifySgError(response.status, body, response.statusText);
    saveAndStart(interaction, url, apiKey);
    await interaction.editReply(
      `\u26A0\uFE0F Connected but SiteGuard answered: ${err.message}\n\n` +
      `Config saved - the bot is polling and will report when it starts working.`
    );
    return;
  }

  let data: any = null;
  try { data = await response.json(); } catch { /* handled below */ }
  saveAndStart(interaction, url, apiKey);
  if (!data || !Array.isArray(data.sites)) {
    await interaction.editReply(
      `\u26A0\uFE0F The endpoint answered HTTP ${response.status} but not with SiteGuard health data (no sites list). ` +
      `Check the URL (it should end in /wp-json/sgbackup/v1/health). Config saved; the bot is polling.`
    );
    return;
  }
  await interaction.editReply(
    `\u2705 **Connected to SiteGuard!**\n\n` +
    `**Endpoint:** ${url}\n` +
    `**Version:** ${data.version ?? "unknown"}\n` +
    `**Sites detected:** ${data.sites.length}\n` +
    `**Overall status:** ${String(data.status ?? "unknown").toUpperCase()}\n\n` +
    `Use \`/sg-setup alerts #channel\` for alerts. Status board is unified - use \`/setup status #channel\`.`
  );
}

/**
 * Store the endpoint and (re)start polling. Alerts are attached first
 * (idempotent), so even a failing first poll is announced.
 */
function saveAndStart(interaction: ChatInputCommandInteraction, url: string, apiKey: string): void {
  setSetting("SG_HEALTH_URL", url);
  setSetting("SG_HEALTH_API_KEY", apiKey);
  startSgAlerts(interaction.client);
  siteguard.restart();
  logger.info({ url }, "SG health endpoint configured via slash command");
}

async function handleSgTickets(interaction: ChatInputCommandInteraction) {
  const url = interaction.options.getString("url", true).trim().replace(/\/+$/, "");
  const token = interaction.options.getString("token", true).trim();
  const group = interaction.options.getString("group")?.trim();
  const customer = interaction.options.getString("customer")?.trim();

  // The token goes out in an Authorization header: https only, except for
  // local dev hosts and in-cluster service names.
  const checked = checkSecureUrl(url, { allowClusterHttp: true });
  if (!checked.ok) {
    await interaction.reply({ content: `Zammad URL: ${checked.error}`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  setSetting("ZAMMAD_BASE_URL", url);
  setSetting("ZAMMAD_API_TOKEN", token);
  if (group) setSetting("ZAMMAD_TICKET_GROUP", group); else deleteSetting("ZAMMAD_TICKET_GROUP");
  if (customer) setSetting("ZAMMAD_TICKET_CUSTOMER", customer); else deleteSetting("ZAMMAD_TICKET_CUSTOMER");
  deleteSetting("TICKETS_ENABLED");

  const test = await testTicketing();
  await interaction.editReply(test.ok
    ? `\u2705 **Zammad ticketing configured.** ${test.message}\n\nA ticket is opened when a site goes down or WordPress becomes unreachable, and closed on recovery.`
    : `\u26A0\uFE0F Settings saved but the Zammad test failed: ${test.message}\n\nCheck the URL and token; tickets will be attempted anyway.`);
  logger.info({ url, group: group ?? "Users" }, "Zammad ticketing configured via slash command");
}

async function handleSgRepeat(interaction: ChatInputCommandInteraction) {
  const minutes = interaction.options.getInteger("minutes", true);
  setSetting("SG_ALERT_REPEAT_MIN", String(minutes));
  await interaction.reply({
    content: minutes > 0
      ? `\u2705 Reminder alerts every **${minutes} min** while a site stays down or WordPress stays unreachable.`
      : "\u274C Reminder alerts disabled (a single alert per incident).",
    ephemeral: true,
  });
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
