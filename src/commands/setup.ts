import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setSetting, deleteSetting, getSetting } from "../db/index.js";
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { kuma } from "../services/kuma.js";
import { siteguard } from "../services/siteguard.js";
import { configureSmtp, getSmtpConfig, isSmtpConfigured, sendTestEmail } from "../services/email.js";


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
      .setDescription("Set the channel for Kuma alerts (down/disconnect)")
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
            { name: "Down alerts (service goes down)", value: "down" },
            { name: "Recovery alerts (service comes back up)", value: "recovery" },
            { name: "Disconnect alerts (Kuma connection lost)", value: "disconnect" },
            { name: "@everyone mentions for Kuma alerts (default: off)", value: "kuma_mention" },
            { name: "Email alerts for Kuma (default: off)", value: "kuma_email" },
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
    sc
      .setName("smtp")
      .setDescription("Configure SMTP email alerts")
      .addStringOption((o) =>
        o.setName("host").setDescription("SMTP host (e.g. smtp.gmail.com or k8s relay IP)").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("port").setDescription("SMTP port (25 for relay, 587 for STARTTLS, 465 for SSL)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("from").setDescription("Sender email address").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("to").setDescription("Recipient emails (comma-separated)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("user").setDescription("SMTP username (omit for unauthenticated relay)").setRequired(false)
      )
      .addStringOption((o) =>
        o.setName("pass").setDescription("SMTP password (omit for unauthenticated relay)").setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("secure").setDescription("Use SSL/TLS? (true for port 465, false otherwise)").setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc.setName("smtp-test").setDescription("Send a test email to verify SMTP configuration")
  )
  .addSubcommand((sc) =>
    sc.setName("smtp-clear").setDescription("Remove SMTP configuration and disable email alerts")
  )
  .addSubcommand((sc) =>
    sc.setName("show").setDescription("Show current bot configuration")
  );

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: ADMINS_ONLY, ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "status": return await handleStatusSetup(interaction);
      case "alerts": return await handleAlertsSetup(interaction);
      case "timezone": return await handleTimezoneSetup(interaction);
      case "alerts-toggle": return await handleAlertsToggle(interaction);
      case "smtp": return await handleSmtpSetup(interaction);
      case "smtp-test": return await handleSmtpTest(interaction);
      case "smtp-clear": return await handleSmtpClear(interaction);
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
    content: `Alert channel set to <#${channel.id}>. Kuma alerts will be sent there.`,
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

  // Special toggles that use different DB keys and different defaults
  if (type === "kuma_mention") {
    // Default: OFF - store "true" to enable, delete to go back to default (off)
    if (state === "on") {
      setSetting("KUMA_ALERT_MENTION_ENABLED", "true");
      await interaction.reply({ content: "\u2705 @everyone mentions **enabled** for Kuma alerts.", ephemeral: true });
    } else {
      deleteSetting("KUMA_ALERT_MENTION_ENABLED");
      await interaction.reply({ content: "\u274C @everyone mentions **disabled** for Kuma alerts.", ephemeral: true });
    }
    logger.info({ type, state }, "Kuma mention toggle updated");
    return;
  }

  if (type === "kuma_email") {
    // Default: OFF - store "true" to enable, delete to go back to default (off)
    if (state === "on") {
      setSetting("KUMA_ALERT_EMAIL_ENABLED", "true");
      await interaction.reply({ content: "\u2705 Email alerts **enabled** for Kuma alerts.", ephemeral: true });
    } else {
      deleteSetting("KUMA_ALERT_EMAIL_ENABLED");
      await interaction.reply({ content: "\u274C Email alerts **disabled** for Kuma alerts.", ephemeral: true });
    }
    logger.info({ type, state }, "Kuma email toggle updated");
    return;
  }

  // Standard Kuma alert toggles (default: ON)
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

async function handleSmtpSetup(interaction: ChatInputCommandInteraction) {
  const host = interaction.options.getString("host", true).trim();
  const port = interaction.options.getInteger("port", true);
  const from = interaction.options.getString("from", true).trim();
  const to = interaction.options.getString("to", true).trim();
  const user = interaction.options.getString("user")?.trim();
  const pass = interaction.options.getString("pass")?.trim();
  const secure = interaction.options.getBoolean("secure") ?? (port === 465);

  setSetting("SMTP_HOST", host);
  setSetting("SMTP_PORT", String(port));
  setSetting("SMTP_SECURE", String(secure));
  setSetting("SMTP_FROM", from);
  setSetting("SMTP_TO", to);

  if (user) setSetting("SMTP_USER", user);
  else deleteSetting("SMTP_USER");
  if (pass) setSetting("SMTP_PASS", pass);
  else deleteSetting("SMTP_PASS");

  configureSmtp();

  await interaction.reply({
    content:
      `\u2705 **SMTP configured!**\n\n` +
      `**Host:** ${host}:${port} (${secure ? "SSL" : "STARTTLS/plain"})\n` +
      `**From:** ${from}\n` +
      `**To:** ${to}\n` +
      `**Auth:** ${user ? "yes" : "relay (no auth)"}\n\n` +
      `Use \`/setup smtp-test\` to verify. Email alerts are enabled by default for SiteGuard, disabled for Kuma.`,
    ephemeral: true,
  });
  logger.info({ host, port, from, to, auth: !!user }, "SMTP configured via slash command");
}

async function handleSmtpTest(interaction: ChatInputCommandInteraction) {
  if (!isSmtpConfigured()) {
    await interaction.reply({
      content: "SMTP is not configured. Use `/setup smtp` to set it up first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await sendTestEmail();
    const config = getSmtpConfig()!;
    await interaction.editReply(`\u2705 Test email sent to **${config.to}**. Check your inbox.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`\u274C Failed to send test email: ${msg}`);
  }
}

async function handleSmtpClear(interaction: ChatInputCommandInteraction) {
  for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_TO"]) {
    deleteSetting(key);
  }
  configureSmtp(); // will set transporter to null

  await interaction.reply({
    content: "\u2705 SMTP configuration removed. Email alerts disabled.",
    ephemeral: true,
  });
  logger.info("SMTP configuration cleared");
}

async function handleShowSetup(interaction: ChatInputCommandInteraction) {
  const statusChannel = getSetting("STATUS_CHANNEL_ID");
  const alertChannel = getSetting("ALERT_CHANNEL_ID");
  const timezone = getSetting("TIMEZONE");
  const summary = kuma.connected ? kuma.getSummary() : null;
  const sgSummary = siteguard.data ? siteguard.getSummary() : null;

  const downEnabled = getSetting("ALERT_DOWN_ENABLED") !== "false";
  const recoveryEnabled = getSetting("ALERT_RECOVERY_ENABLED") !== "false";
  const disconnectEnabled = getSetting("ALERT_DISCONNECT_ENABLED") !== "false";
  const kumaMentionEnabled = getSetting("KUMA_ALERT_MENTION_ENABLED") === "true";
  const kumaEmailEnabled = getSetting("KUMA_ALERT_EMAIL_ENABLED") === "true";

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
    "**Kuma Alert Types:**",
    `  Down alerts: ${downEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  Recovery alerts: ${recoveryEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  Disconnect alerts: ${disconnectEnabled ? "\u2705 enabled" : "\u274C disabled"}`,
    `  @everyone mentions: ${kumaMentionEnabled ? "\u2705 enabled" : "\u274C disabled (default)"}`,
    `  Email alerts: ${kumaEmailEnabled ? "\u2705 enabled" : "\u274C disabled (default)"}`,
  ];

  // SiteGuard summary if connected
  if (siteguard.isConfigured) {
    const sgAlertChannel = getSetting("SG_ALERT_CHANNEL_ID");
    const sgMentionEnabled = getSetting("SG_ALERT_MENTION_ENABLED") !== "false";
    const sgEmailEnabled = getSetting("SG_ALERT_EMAIL_ENABLED") !== "false";

    lines.push(
      "",
      `**SiteGuard:** ${siteguard.reachable ? "\u{1F7E2} Reachable" : "\u{1F534} Unreachable"}`,
      sgSummary ? `**Sites:** ${sgSummary.operational}/${sgSummary.total} operational` : "",
      `**SG Alert Channel:** ${sgAlertChannel ? `<#${sgAlertChannel}>` : "*not set - use `/sg-setup alerts`*"}`,
      `  @everyone mentions: ${sgMentionEnabled ? "\u2705 enabled (default)" : "\u274C disabled"}`,
      `  Email alerts: ${sgEmailEnabled ? "\u2705 enabled (default)" : "\u274C disabled"}`,
    );
  }

  // SMTP config
  const smtp = getSmtpConfig();
  lines.push("");
  if (smtp) {
    lines.push(
      "**SMTP Email:**",
      `  Host: ${smtp.host}:${smtp.port} (${smtp.secure ? "SSL" : "plain"})`,
      `  From: ${smtp.from}`,
      `  To: ${smtp.to}`,
      `  Auth: ${smtp.user ? "yes" : "relay (no auth)"}`,
    );
  } else {
    lines.push("**SMTP Email:** *not configured - use `/setup smtp`*");
  }

  await interaction.reply({ content: lines.filter(Boolean).join("\n"), ephemeral: true });
}
