import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
// SG commands are always available (connect via /sg-setup connect)

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show all available bot commands");

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Uptime Kuma Bot - Commands")
    .setColor(0x7289da)
    .addFields(
      {
        name: "Monitoring",
        value: [
          "`/status` - Quick summary with up/down counts",
          "`/monitors [filter]` - List all monitors (filter: all, up, down, paused, maintenance)",
          "`/monitor <name>` - Detailed info for a specific monitor (autocomplete)",
          "`/downtime` - Show all currently down services",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Actions",
        value: [
          "`/pause <name> [duration] [reason]` - Pause a monitor or a whole group in Kuma; with a duration (30m, 2h, 1d) it resumes by itself (admin only, autocomplete)",
          "`/resume <name>` - Resume a paused monitor or group (admin only, autocomplete)",
          "`/paused` - List paused monitors, who paused them, why and until when",
          "`/refresh` - Force refresh the status board embed",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Setup (admin only)",
        value: [
          "`/setup status <channel>` - Set the unified status board channel (Kuma + SiteGuard)",
          "`/setup alerts <channel>` - Set the Kuma alert channel",
          "`/setup timezone <tz>` - Set bot timezone (e.g. America/New_York)",
          "`/setup alerts-toggle <type> <on|off>` - Toggle alert types, @everyone, email for Kuma",
          "`/setup smtp <host> <port> <from> <to> [user] [pass]` - Configure SMTP email",
          "`/setup smtp-test` - Send a test email",
          "`/setup smtp-clear` - Remove SMTP configuration",
          "`/setup show` - Show current configuration",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Auto Features",
        value: [
          "**Status Board** - Unified embed showing Kuma monitors + WordPress health (configure with `/setup status`)",
          "**Down Alerts** - When a monitor goes DOWN (Kuma: no @everyone by default, SG: @everyone by default)",
          "**Recovery Alerts** - Notice when a service comes back UP",
          "**Disconnect Alert** - If connection to Uptime Kuma is lost 30+ seconds",
          "**Email Alerts** - SMTP email alongside Discord (SG: on by default, Kuma: off by default)",
          "**Bot Presence** - Shows combined X/Y services up in the member list",
        ].join("\n"),
        inline: false,
      }
    );

  // SiteGuard Health Monitor commands (always available - connect via /sg-setup connect)
  embed.addFields(
      {
        name: "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
        value: "**SiteGuard Health Monitor**",
        inline: false,
      },
      {
        name: "WordPress Health",
        value: [
          "`/sg-status` - WordPress multisite health summary",
          "`/sg-monitors [filter]` - List all subsites (filter: all, operational, degraded, down)",
          "`/sg-downtime` - Show currently down WordPress subsites",
          "`/sg-refresh` - Force refresh the status board",
        ].join("\n"),
        inline: false,
      },
      {
        name: "SiteGuard Setup (admin only)",
        value: [
          "`/sg-setup connect <url> <api_key>` - Connect to a SiteGuard WordPress endpoint",
          "`/sg-setup disconnect` - Disconnect from the health endpoint",
          "`/sg-setup alerts <channel>` - Set the SiteGuard alert channel",
          "`/sg-setup alerts-toggle <type> <on|off>` - Toggle alert types, @everyone, email for SG",
          "`/sg-setup show` - Show SiteGuard configuration",
        ].join("\n"),
        inline: false,
      },
      {
        name: "SiteGuard Auto Features",
        value: [
          "**Site Down Alerts** - @everyone when a WordPress site goes down (configurable)",
          "**Recovery Alerts** - Notice when a site comes back up",
          "**SSL Expiry Warnings** - Alert when certificates are expiring soon",
          "**WP Unreachable** - @everyone if the WordPress health endpoint can't be reached",
          "**Email Alerts** - Enabled by default for SiteGuard (configure SMTP with `/setup smtp`)",
        ].join("\n"),
        inline: false,
      }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
