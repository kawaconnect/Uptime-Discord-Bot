import { Client, Events } from "discord.js";
import { logger } from "../util/logger.js";

export function onReady(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "Discord client ready");
  });
}
