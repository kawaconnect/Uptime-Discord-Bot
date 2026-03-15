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
          "`/pause <name>` - Pause a monitor (autocomplete)",
          "`/resume <name>` - Resume a paused monitor (autocomplete)",
          "`/refresh` - Force refresh the status board embed",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Setup (admin only)",
        value: [
          "`/setup status <channel>` - Set the auto-updating status board channel",
          "`/setup alerts <channel>` - Set the @everyone alert channel",
          "`/setup timezone <tz>` - Set bot timezone (e.g. America/New_York)",
          "`/setup alerts-toggle <type> <on|off>` - Enable/disable alert types",
          "`/setup show` - Show current configuration",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Auto Features",
        value: [
          "**Status Board** - Auto-updating embed showing all monitors (configure with `/setup status`)",
          "**Down Alerts** - @everyone when a monitor goes DOWN",
          "**Recovery Alerts** - Notice when a service comes back UP",
          "**Disconnect Alert** - @everyone if connection to Uptime Kuma is lost 30+ seconds",
          "**Bot Presence** - Shows X/Y services up in the member list",
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
          "`/sg-refresh` - Force refresh the SiteGuard status board",
        ].join("\n"),
        inline: false,
      },
      {
        name: "SiteGuard Setup (admin only)",
        value: [
          "`/sg-setup connect <url> <api_key>` - Connect to a SiteGuard WordPress endpoint",
          "`/sg-setup disconnect` - Disconnect from the health endpoint",
          "`/sg-setup status <channel>` - Set the SiteGuard status board channel",
          "`/sg-setup alerts <channel>` - Set the SiteGuard alert channel",
          "`/sg-setup alerts-toggle <type> <on|off>` - Toggle SiteGuard alert types",
          "`/sg-setup show` - Show SiteGuard configuration",
        ].join("\n"),
        inline: false,
      },
      {
        name: "SiteGuard Auto Features",
        value: [
          "**Health Board** - Auto-updating embed showing WordPress site health (configure with `/sg-setup status`)",
          "**Site Down Alerts** - @everyone when a WordPress site goes down",
          "**Recovery Alerts** - Notice when a site comes back up",
          "**SSL Expiry Warnings** - Alert when certificates are expiring soon",
          "**WP Unreachable** - @everyone if the WordPress health endpoint can't be reached",
        ].join("\n"),
        inline: false,
      }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
