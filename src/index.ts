import "dotenv/config";
import { join } from "node:path";
import { REST, Routes } from "discord.js";
import { loadEnv, env } from "./util/env.js";
import { logger } from "./util/logger.js";
import { initDb, closeDb } from "./db/index.js";
import { createClient } from "./client.js";
import { startWebServer } from "./web/server.js";
import { kuma } from "./services/kuma.js";
import { startStatusBoard, stopStatusBoard, updateStatusBoard } from "./services/statusBoard.js";
import { startAlerts, stopAlerts } from "./services/alerts.js";
import { startPauseScheduler, stopPauseScheduler } from "./services/monitorPauses.js";
import { phoneCommand } from "./commands/phone.js";
import { sgPauseCommand } from "./commands/sg-pause.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { startMaintenanceScheduler, stopMaintenanceScheduler } from "./services/maintenanceRun.js";
import { wpCommand, refreshPanel } from "./commands/wp.js";
import { wpops } from "./services/wpops.js";
import { startWpopsAlerts } from "./services/wpopsAlerts.js";
import { startPresence, stopPresence } from "./services/presence.js";
import { configureSmtp } from "./services/email.js";
import { setupCommand } from "./commands/setup.js";
import { helpCommand } from "./commands/help.js";
import {
  statusCommand,
  monitorsCommand,
  monitorCommand,
  pauseCommand,
  resumeCommand,
  pausedCommand,
  downtimeCommand,
  refreshCommand,
} from "./commands/status.js";
import { siteguard } from "./services/siteguard.js";
import { startSgAlerts, stopSgAlerts } from "./services/sgAlerts.js";
import { registerAckTicketClosing } from "./services/ackTickets.js";
import { sgSetupCommand } from "./commands/sg-setup.js";
import {
  sgStatusCommand,
  sgMonitorsCommand,
  sgDowntimeCommand,
  sgRefreshCommand,
} from "./commands/sg-status.js";

let server: Awaited<ReturnType<typeof startWebServer>> | null = null;

async function deployCommands() {
  const config = env();
  const commands = [
    setupCommand.toJSON(),
    helpCommand.toJSON(),
    statusCommand.toJSON(),
    monitorsCommand.toJSON(),
    monitorCommand.toJSON(),
    pauseCommand.toJSON(),
    resumeCommand.toJSON(),
    pausedCommand.toJSON(),
    downtimeCommand.toJSON(),
    refreshCommand.toJSON(),
    phoneCommand.toJSON(),
    maintenanceCommand.toJSON(),
  ];

  // SiteGuard commands - always registered so /sg-setup connect can be used
  // to configure the connection at runtime without restarting the bot
  commands.push(
    sgSetupCommand.toJSON(),
    sgStatusCommand.toJSON(),
    sgMonitorsCommand.toJSON(),
    sgDowntimeCommand.toJSON(),
    sgRefreshCommand.toJSON(),
    sgPauseCommand.toJSON(),
    wpCommand.toJSON(),
  );

  const rest = new REST().setToken(config.DISCORD_TOKEN);

  // Commands are registered on one guild only (DISCORD_GUILD_ID is required):
  // the bot keeps a single set of channels and settings, so it serves one server.
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
      { body: commands }
    );
    logger.info({ guildId: config.DISCORD_GUILD_ID, count: commands.length }, "Slash commands deployed to guild");
  } catch (err) {
    logger.error({ err }, "Failed to deploy slash commands");
  }
}

async function main() {
  loadEnv();
  logger.info("Environment validated");
  if (env().ADMIN_USER_IDS.length === 0) {
    logger.warn("ADMIN_USER_IDS is empty: admin commands (/setup, /sg-setup, /sg-pause, /maintenance, /pause, /resume, /phone toggle) are refused for everyone");
  }

  const dbPath = join(process.cwd(), "data", "bot.db");
  initDb(dbPath);

  // Initialize SMTP from DB/env settings
  configureSmtp();

  const client = createClient();
  await client.login(env().DISCORD_TOKEN);

  await deployCommands();

  server = await startWebServer();

  // Auto-resume of timed /pause pauses (schedule kept in data/bot.db).
  // Started before connecting so the first connect triggers a sweep.
  startPauseScheduler(client);
  // End of a /maintenance window (kept in data/bot.db, so it survives restarts).
  startMaintenanceScheduler(client);

  // Connect to Uptime Kuma
  kuma.connect();

  // Start services once connected
  kuma.once("connected", () => {
    logger.info("Uptime Kuma connected - starting services");

    startStatusBoard(client);
    startAlerts(client);
    startPresence(client);

    // Initial status board after monitors populate
    setTimeout(() => {
      updateStatusBoard(client).catch((err) =>
        logger.warn({ err }, "Initial status board update failed")
      );
    }, 5_000);
  });

  // SiteGuard Health Monitor (independent from Kuma)
  // Alert listeners are attached BEFORE the first poll and regardless of its
  // outcome. They used to be wired on the first successful "updated" event, so
  // when WordPress was already unreachable at startup (the exact moment an
  // alert matters most) the "unreachable" event fired into the void.
  startSgAlerts(client);
  registerAckTicketClosing(client);
  if (siteguard.isConfigured) {
    logger.info({ url: siteguard.getUrl() }, "Starting SiteGuard health monitor");
    siteguard.start();
  } else {
    logger.warn("SiteGuard endpoint not configured - node agents (/wp node add) still report their sites; /sg-setup connect <url> <api_key> for a single WordPress");
  }
  // Sites reported by node agents start the monitor by themselves (node-only estates).
  siteguard.enableNodeAutostart();

  // WordPress node agents (failover / backups). Nodes come from the DB
  // (/wp node add) or WPOPS_NODES + WPOPS_TOKEN_<NAME> in the environment.
  startWpopsAlerts(client);
  wpops.on("overridesChanged", () => {
    refreshPanel(client).catch(() => undefined);
    updateStatusBoard(client).catch(() => undefined);
  });
  wpops.start();
  if (!wpops.configured) logger.warn("No WordPress node agents configured - /wp commands are inactive until /wp node add");

  logger.info("Bot started - waiting for Uptime Kuma connection");
}

// ---------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  siteguard.stop();
  wpops.stop();
  stopSgAlerts();
  stopAlerts();
  stopPauseScheduler();
  stopMaintenanceScheduler();
  stopStatusBoard();
  stopPresence();
  kuma.disconnect();
  if (server) { try { await server.close(); } catch { /* ignore */ } }
  closeDb();
  logger.flush();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "Unhandled rejection");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
