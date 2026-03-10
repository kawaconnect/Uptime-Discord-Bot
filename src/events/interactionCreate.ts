import { Client, Events } from "discord.js";
import { logger } from "../util/logger.js";
import { handleSetupCommand } from "../commands/setup.js";
import { handleHelpCommand } from "../commands/help.js";
import {
  handleStatusCommand,
  handleMonitorsCommand,
  handleMonitorCommand,
} from "../commands/status.js";

export function onInteractionCreate(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "setup":
          await handleSetupCommand(interaction);
          break;
        case "help":
          await handleHelpCommand(interaction);
          break;
        case "status":
          await handleStatusCommand(interaction);
          break;
        case "monitors":
          await handleMonitorsCommand(interaction);
          break;
        case "monitor":
          await handleMonitorCommand(interaction);
          break;
        default:
          await interaction.reply({
            content: "Unknown command.",
            ephemeral: true,
          });
      }
    } catch (err) {
      logger.error({ command: interaction.commandName, err }, "Command error");
      const msg = err instanceof Error ? err.message : "An error occurred";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(`Error: ${msg}`);
        } else {
          await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
        }
      } catch {
        // Can't respond - interaction expired
      }
    }
  });
}
