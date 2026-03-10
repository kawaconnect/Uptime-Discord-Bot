import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";

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

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
