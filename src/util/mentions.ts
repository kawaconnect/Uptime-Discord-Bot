import type { MessageMentionOptions } from "discord.js";

/**
 * allowedMentions presets. Alert text carries data from outside the bot
 * (Kuma heartbeat messages, monitor names, SiteGuard errors), so no message
 * may resolve mentions from its content except the explicit @everyone ping
 * on alerts that are meant to page. The client also defaults to NO_MENTIONS.
 */
export const NO_MENTIONS: MessageMentionOptions = { parse: [] };
export const EVERYONE_ONLY: MessageMentionOptions = { parse: ["everyone"] };

/** Mentions for a message whose content is either "@everyone" or empty. */
export function mentionsFor(content: string | undefined): MessageMentionOptions {
  return content === "@everyone" ? EVERYONE_ONLY : NO_MENTIONS;
}
