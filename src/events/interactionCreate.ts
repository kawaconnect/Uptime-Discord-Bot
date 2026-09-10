import { Client, Events } from "discord.js";
import { logger } from "../util/logger.js";
import { handleSetupCommand } from "../commands/setup.js";
import { handleHelpCommand } from "../commands/help.js";
import {
  handleStatusCommand,
  handleMonitorsCommand,
  handleMonitorCommand,
  handlePauseCommand,
  handleResumeCommand,
  handleDowntimeCommand,
  handleRefreshCommand,
  handleMonitorAutocomplete,
} from "../commands/status.js";
import { handleSgSetupCommand } from "../commands/sg-setup.js";
import {
  handleSgStatusCommand,
  handleSgMonitorsCommand,
  handleSgDowntimeCommand,
  handleSgRefreshCommand,
} from "../commands/sg-status.js";
import { handlePhoneCommand } from "../commands/phone.js";
import { handleSgPauseCommand } from "../commands/sg-pause.js";

export function onInteractionCreate(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle autocomplete
    if (interaction.isAutocomplete()) {
      try {
        await handleMonitorAutocomplete(interaction);
      } catch (err) {
        logger.debug({ err }, "Autocomplete error");
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "setup": await handleSetupCommand(interaction); break;
        case "help": await handleHelpCommand(interaction); break;
        case "status": await handleStatusCommand(interaction); break;
        case "monitors": await handleMonitorsCommand(interaction); break;
        case "monitor": await handleMonitorCommand(interaction); break;
        case "pause": await handlePauseCommand(interaction); break;
        case "resume": await handleResumeCommand(interaction); break;
        case "downtime": await handleDowntimeCommand(interaction); break;
        case "refresh": await handleRefreshCommand(interaction); break;
        case "phone": await handlePhoneCommand(interaction); break;
        // SiteGuard commands
        case "sg-setup": await handleSgSetupCommand(interaction); break;
        case "sg-status": await handleSgStatusCommand(interaction); break;
        case "sg-monitors": await handleSgMonitorsCommand(interaction); break;
        case "sg-downtime": await handleSgDowntimeCommand(interaction); break;
        case "sg-refresh": await handleSgRefreshCommand(interaction); break;
        case "sg-pause": await handleSgPauseCommand(interaction); break;
        default:
          await interaction.reply({ content: "Unknown command.", ephemeral: true });
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
        // Interaction expired
      }
    }
  });
}
