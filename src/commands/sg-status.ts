/**
 * SiteGuard slash commands for querying WordPress multisite health.
 * Completely independent from Uptime Kuma commands.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { siteguard, sgStatusEmoji, sgStatusColor, SgStatus, type SgSite } from "../services/siteguard.js";
import { updateStatusBoard } from "../services/statusBoard.js";

// ---------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------

export const sgStatusCommand = new SlashCommandBuilder()
  .setName("sg-status")
  .setDescription("Show WordPress multisite health summary");

export const sgMonitorsCommand = new SlashCommandBuilder()
  .setName("sg-monitors")
  .setDescription("List all WordPress subsites and their health")
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Filter by status")
      .setRequired(false)
      .addChoices(
        { name: "All", value: "all" },
        { name: "Operational", value: "operational" },
        { name: "Degraded", value: "degraded" },
        { name: "Down", value: "down" },
      )
  );

export const sgDowntimeCommand = new SlashCommandBuilder()
  .setName("sg-downtime")
  .setDescription("Show all currently down WordPress subsites");

export const sgRefreshCommand = new SlashCommandBuilder()
  .setName("sg-refresh")
  .setDescription("Force refresh the SiteGuard status board");

// ---------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------

export async function handleSgStatusCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!siteguard.data) {
    await interaction.reply({
      content: "No health data available yet. The SiteGuard monitor may still be initialising.",
      ephemeral: true,
    });
    return;
  }

  const summary = siteguard.getSummary();
  const data = siteguard.data;

  let color = sgStatusColor(SgStatus.OPERATIONAL);
  if (summary.down > 0) color = sgStatusColor(SgStatus.DOWN);
  else if (summary.degraded > 0) color = sgStatusColor(SgStatus.DEGRADED);

  const lines: string[] = [
    `${sgStatusEmoji(SgStatus.OPERATIONAL)} **${summary.operational}** operational`,
  ];
  if (summary.degraded > 0) lines.push(`${sgStatusEmoji(SgStatus.DEGRADED)} **${summary.degraded}** degraded`);
  if (summary.down > 0) lines.push(`${sgStatusEmoji(SgStatus.DOWN)} **${summary.down}** down`);
  lines.push(`**Total:** ${summary.total} sites`);

  if (data.checked_at > 0) {
    lines.push(`\nLast checked: <t:${data.checked_at}:R>`);
  }
  if (data.check_interval) {
    lines.push(`Check interval: every ${Math.round(data.check_interval / 60)} minutes`);
  }

  if (!siteguard.reachable) {
    lines.push("\n\u26A0\uFE0F **WordPress endpoint is currently unreachable**");
  }

  // Show down sites if any
  const downSites = siteguard.getDownSites();
  if (downSites.length > 0) {
    lines.push("\n**Down sites:**");
    for (const site of downSites) {
      const failures = site.consecutive_failures > 1 ? ` (${site.consecutive_failures} consecutive)` : "";
      lines.push(`${sgStatusEmoji("down")} ${site.domain} - ${site.error || "No response"}${failures}`);
    }
  }

  // Show SSL warnings
  const sslExpiring = siteguard.getSslExpiring();
  if (sslExpiring.length > 0) {
    lines.push("\n**SSL expiring soon:**");
    for (const site of sslExpiring) {
      lines.push(`\u26A0\uFE0F ${site.domain} - ${site.ssl_expiry_days} days remaining`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`WordPress Health - ${data.status.toUpperCase()}`)
    .setDescription(lines.join("\n"))
    .setColor(color)
    .setFooter({ text: `SiteGuard v${data.version}` })
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleSgMonitorsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!siteguard.data) {
    await interaction.reply({
      content: "No health data available yet.",
      ephemeral: true,
    });
    return;
  }

  const filter = interaction.options.getString("filter") ?? "all";
  let sites = siteguard.sites;

  if (filter !== "all") {
    sites = sites.filter((s) => s.status === filter);
  }

  if (sites.length === 0) {
    await interaction.reply({
      content: `No sites matching filter: **${filter}**`,
      ephemeral: true,
    });
    return;
  }

  const sorted = [...sites].sort((a, b) => a.domain.localeCompare(b.domain));
  const lines: string[] = [];

  for (const site of sorted) {
    const emoji = sgStatusEmoji(site.status);
    const responseMs = Math.round(site.response_time * 1000);
    const ssl = site.ssl_expiry_days >= 0 ? ` | SSL: ${site.ssl_expiry_days}d` : "";
    lines.push(`${emoji} **${site.domain}** - ${site.http_code || "ERR"} | ${responseMs}ms${ssl}`);
    if (site.error) {
      lines.push(`  \u2514 ${site.error}`);
    }
  }

  let description = lines.join("\n");
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n*... ${sorted.length} sites total*`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`WordPress Sites - ${filter === "all" ? "All" : filter.charAt(0).toUpperCase() + filter.slice(1)} (${sorted.length})`)
    .setDescription(description)
    .setColor(0x7289da)
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleSgDowntimeCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const downSites = siteguard.getDownSites();

  if (downSites.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`${sgStatusEmoji(SgStatus.OPERATIONAL)} All WordPress Sites Operational`)
      .setDescription("No sites are currently reporting issues.")
      .setColor(sgStatusColor(SgStatus.OPERATIONAL))
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const lines: string[] = [];
  for (const site of downSites) {
    lines.push(
      `${sgStatusEmoji("down")} **${site.domain}**\n` +
      `  URL: ${site.url}\n` +
      `  HTTP: ${site.http_code || "N/A"} | Error: ${site.error || "No response"}\n` +
      `  Last checked: <t:${site.last_check}:R>`
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`${sgStatusEmoji(SgStatus.DOWN)} ${downSites.length} WordPress Site${downSites.length > 1 ? "s" : ""} Down`)
    .setDescription(lines.join("\n\n"))
    .setColor(sgStatusColor(SgStatus.DOWN))
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleSgRefreshCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Force a fresh poll
  await siteguard.poll();

  // Update the status board
  await updateStatusBoard(interaction.client);

  const summary = siteguard.getSummary();
  await interaction.editReply(
    `SiteGuard status board refreshed. ${summary.operational}/${summary.total} sites operational.`
  );
}
