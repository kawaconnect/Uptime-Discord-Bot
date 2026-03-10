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
        name: "Status",
        value: [
          "`/status` - Quick summary (up/down/pending counts)",
          "`/monitors` - List all monitors with current state",
          "`/monitor <name>` - Detailed info for a specific monitor",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Setup (admin only)",
        value: [
          "`/setup status <channel>` - Set the auto-updating status board channel",
          "`/setup alerts <channel>` - Set the @everyone alert channel",
          "`/setup timezone <tz>` - Set bot timezone (e.g. America/New_York)",
          "`/setup show` - Show current configuration",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Auto Features",
        value: [
          "**Status Board** - Auto-updating embed in the configured channel showing all monitors",
          "**Alerts** - @everyone when a monitor goes DOWN, recovery notice when it comes back UP",
          "**Disconnect Alert** - @everyone if connection to Uptime Kuma is lost for 30+ seconds",
          "**Bot Presence** - Shows X/Y services up in the member list",
        ].join("\n"),
        inline: false,
      }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
