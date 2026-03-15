/**
 * SiteGuard status board - persistent message showing WordPress site health.
 * Refreshes every 30 seconds. Independent from the Kuma status board.
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
  Message,
  Events,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { siteguard, sgStatusEmoji, sgStatusColor, SgStatus, type SgSite } from "./siteguard.js";
import { discordQueue } from "../queue/index.js";

const SG_STATUS_CHANNEL_KEY = "SG_STATUS_CHANNEL_ID";
const SG_STATUS_MSG_KEY = "SG_STATUS_MESSAGE_ID";
const REFRESH_INTERVAL_MS = 30_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let updating = false;

export function startSgStatusBoard(client: Client): void {
  // Immediate update on status changes
  siteguard.on("updated", () => {
    updateSgStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed to update SG status board on data update")
    );
  });

  // Watch for messages in SG status channel for re-anchoring
  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot) return;
    const channelId = getSetting(SG_STATUS_CHANNEL_KEY);
    if (!channelId || msg.channelId !== channelId) return;
    // Will be re-anchored on next refresh
  });

  // Periodic refresh
  refreshTimer = setInterval(() => {
    if (!siteguard.data) return;
    updateSgStatusBoard(client).catch((err) =>
      logger.warn({ err }, "Failed periodic SG status board refresh")
    );
  }, REFRESH_INTERVAL_MS);

  logger.info({ refreshMs: REFRESH_INTERVAL_MS }, "SiteGuard status board started");
}

export function stopSgStatusBoard(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export async function updateSgStatusBoard(client: Client): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    await doUpdate(client);
  } finally {
    updating = false;
  }
}

async function doUpdate(client: Client): Promise<void> {
  const channelId = getSetting(SG_STATUS_CHANNEL_KEY);
  if (!channelId) return;

  const data = siteguard.data;
  if (!data || data.sites.length === 0) return;

  let channel: TextChannel | null;
  try {
    channel = await client.channels.fetch(channelId) as TextChannel | null;
  } catch (err: any) {
    const status = err?.status ?? err?.httpStatus ?? 0;
    if (status >= 500 || status === 0) {
      logger.warn({ err, status }, "SG status board channel fetch failed (transient)");
      return;
    }
    throw err;
  }
  if (!channel?.isTextBased()) return;

  const embed = buildSgStatusEmbed();
  const oldMsgId = getSetting(SG_STATUS_MSG_KEY);

  if (oldMsgId) {
    try {
      const lastMessages = await channel.messages.fetch({ limit: 1, cache: false });
      const lastMsg = lastMessages.first();

      if (lastMsg?.id === oldMsgId) {
        await discordQueue.add(async () => { await lastMsg!.edit({ embeds: [embed] }); });
        return;
      }

      // Not at bottom - delete and re-send
      logger.info("Re-anchoring SG status board to bottom");
      try {
        const oldMsg = await channel.messages.fetch(oldMsgId);
        await discordQueue.add(async () => { await oldMsg.delete(); });
      } catch { /* already deleted */ }
    } catch (err: any) {
      const status = err?.status ?? err?.httpStatus ?? 0;
      if (status >= 500 || status === 0) {
        logger.warn({ err, status }, "SG status board update failed (transient)");
        return;
      }
      logger.info({ status }, "SG status board message missing, creating new");
    }
  }

  try {
    const msg = await discordQueue.add(async () =>
      channel!.send({ embeds: [embed], flags: 4096 } as any)
    ) as Message | undefined;

    if (msg) {
      setSetting(SG_STATUS_MSG_KEY, msg.id);
    }
  } catch (err) {
    logger.error({ err }, "Failed to create SG status board message");
  }
}

function buildSgStatusEmbed(): EmbedBuilder {
  const data = siteguard.data!;
  const summary = siteguard.getSummary();

  // Overall color
  let color = sgStatusColor(SgStatus.OPERATIONAL);
  if (summary.down > 0) color = sgStatusColor(SgStatus.DOWN);
  else if (summary.degraded > 0) color = sgStatusColor(SgStatus.DEGRADED);

  if (!siteguard.reachable) color = 0xff6600;

  // Header
  const headerParts: string[] = [
    `${sgStatusEmoji(SgStatus.OPERATIONAL)} **${summary.operational}** operational`,
  ];
  if (summary.degraded > 0) headerParts.push(`${sgStatusEmoji(SgStatus.DEGRADED)} **${summary.degraded}** degraded`);
  if (summary.down > 0) headerParts.push(`${sgStatusEmoji(SgStatus.DOWN)} **${summary.down}** down`);

  // Per-site lines
  const lines: string[] = [];
  const sorted = [...data.sites].sort((a, b) => a.domain.localeCompare(b.domain));

  for (const site of sorted) {
    const emoji = sgStatusEmoji(site.status);
    const responseMs = Math.round(site.response_time * 1000);
    const sslStr = site.ssl_expiry_days >= 0 ? `SSL: ${site.ssl_expiry_days}d` : "";
    const parts = [`${emoji} **${site.domain}**`, `${responseMs}ms`];
    if (sslStr) parts.push(sslStr);
    if (site.error) parts.push(`\u26A0 ${site.error}`);
    lines.push(parts.join(" - "));
  }

  let description = lines.join("\n");
  if (description.length > 3800) {
    description = description.slice(0, 3750) + `\n\n*... and more (${data.sites.length} total)*`;
  }

  // Timestamps
  const now = new Date();
  const unixTs = Math.floor(now.getTime() / 1000);
  const tz = getSetting("TIMEZONE");
  let botTimeStr = "";
  if (tz) {
    try {
      botTimeStr = now.toLocaleString("en-US", { timeZone: tz, timeStyle: "short", dateStyle: "short" });
    } catch { /* ignore */ }
  }

  const timeLines = [
    `\n\nLast updated: <t:${unixTs}:T> (your time)`,
    botTimeStr ? `Bot time: **${botTimeStr}** (${tz})` : "",
  ].filter(Boolean).join("\n");

  let unreachableWarning = "";
  if (!siteguard.reachable) {
    unreachableWarning = "\n\n\u26A0\uFE0F **WordPress endpoint unreachable** - data shown may be stale.";
  }

  const checkedAgo = data.checked_at > 0
    ? `Data from <t:${data.checked_at}:R>`
    : "No check data";

  return new EmbedBuilder()
    .setTitle(`WordPress Health (${summary.operational}/${summary.total})`)
    .setDescription(`${headerParts.join("  |  ")}\n\n${description}${timeLines}${unreachableWarning}`)
    .setColor(color)
    .setFooter({ text: `SiteGuard v${data.version} | ${checkedAgo} | Refreshes every 30s` });
}
