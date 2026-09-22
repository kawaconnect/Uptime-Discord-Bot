/**
 * Phone acknowledgement closes the alert's ticket.
 *
 * When somebody presses 1 on an alert call, the PBX marks the alert
 * acknowledged and the next report from this bot learns who did it and when.
 * That is a person saying "I have this", so the ticket the alert raised is
 * closed with a note, and the alert channel is told.
 *
 * Which ticket:
 *   - SiteGuard conditions (sg:*): the incident ticket this bot opened and
 *     tracks by key.
 *   - Uptime Kuma monitors (kuma:monitor:<id>): Kuma emails Zammad itself,
 *     so the ticket is found by title ("<monitor name> Down ...") among open
 *     tickets created since the outage began.
 *
 * Off switch: setting PHONE_ACK_CLOSES_TICKET=false.
 */

import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { logger } from "../util/logger.js";
import { getSetting, getSettingOrEnv } from "../db/index.js";
import { onPhoneAcknowledged, PhoneAck, downSince } from "./phone.js";
import { closeIncidentTicketOnAck, closeMatchingTickets, ticketUrl, isTicketingConfigured } from "./tickets.js";
import { kuma } from "./kuma.js";

let registered = false;

export function isAckClosesTicketEnabled(): boolean {
  return getSettingOrEnv("PHONE_ACK_CLOSES_TICKET") !== "false";
}

export function registerAckTicketClosing(client: Client): void {
  if (registered) return;
  registered = true;
  onPhoneAcknowledged(async (ack) => {
    if (!isAckClosesTicketEnabled() || !isTicketingConfigured()) return;
    const when = new Date(ack.at * 1000).toLocaleString("en-US", { timeZone: "America/New_York" });
    const note = `<p>Phone alert acknowledged by <b>${escapeHtml(ack.by)}</b> at ${escapeHtml(when)}. Closing on acknowledgement.</p>`;
    const closed = await closeForKey(ack, note);
    if (closed.length === 0) {
      logger.info({ key: ack.key }, "Phone acknowledgement: no open ticket to close");
      return;
    }
    const lines = closed.map((c) => `#${c.number} - ${ticketUrl(c.id)}`).join("\n");
    const embed = new EmbedBuilder()
      .setTitle("📞 Alert acknowledged by phone")
      .setDescription(`**${escapeMd(ack.by)}** pressed 1 for \`${ack.key}\`.\nClosed: ${lines}`)
      .setColor(0x2ecc71)
      .setTimestamp(new Date(ack.at * 1000));
    await post(client, embed);
  });
}

async function closeForKey(ack: PhoneAck, note: string): Promise<Array<{ id: number; number: string }>> {
  if (ack.key.startsWith("sg:")) {
    const rec = await closeIncidentTicketOnAck(ack.key, note);
    return rec ? [rec] : [];
  }
  const m = /^kuma:monitor:(\d+)$/.exec(ack.key);
  if (m) {
    const monitor = kuma.monitors.get(Number(m[1]));
    if (!monitor?.name) return [];
    const since = downSince(ack.key) ?? Date.now() - 6 * 60 * 60_000;
    return closeMatchingTickets(`${monitor.name} Down`, since, note);
  }
  return [];
}

async function post(client: Client, embed: EmbedBuilder): Promise<void> {
  const channelId = getSetting("ALERT_CHANNEL_ID") ?? getSetting("SG_ALERT_CHANNEL_ID") ?? getSetting("STATUS_CHANNEL_ID");
  if (!channelId) return;
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.warn({ err }, "Failed to post acknowledgement notice");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function escapeMd(s: string): string {
  return s.replace(/[*_`~]/g, "\\$&");
}
