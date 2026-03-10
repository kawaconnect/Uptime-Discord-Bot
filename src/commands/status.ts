import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { kuma, MonitorStatus, statusEmoji, statusLabel } from "../services/kuma.js";

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show current monitor status summary");

export const monitorsCommand = new SlashCommandBuilder()
  .setName("monitors")
  .setDescription("List all monitors and their current state");

export const monitorCommand = new SlashCommandBuilder()
  .setName("monitor")
  .setDescription("Show details for a specific monitor")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor name (partial match)").setRequired(true)
  );

export async function handleStatusCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!kuma.connected) {
    await interaction.reply({
      content: "\u26A0\uFE0F Not connected to Uptime Kuma.",
      ephemeral: true,
    });
    return;
  }

  const summary = kuma.getSummary();
  const active = summary.total - summary.paused;

  let color = 0x2ecc71;
  if (summary.down > 0) color = 0xe74c3c;
  else if (summary.pending > 0) color = 0xf39c12;

  const embed = new EmbedBuilder()
    .setTitle(`Service Status (${summary.up}/${active})`)
    .setColor(color)
    .addFields(
      { name: `${statusEmoji(MonitorStatus.UP)} Up`, value: String(summary.up), inline: true },
      { name: `${statusEmoji(MonitorStatus.DOWN)} Down`, value: String(summary.down), inline: true },
      { name: `${statusEmoji(MonitorStatus.PENDING)} Pending`, value: String(summary.pending), inline: true },
      { name: `${statusEmoji(MonitorStatus.MAINTENANCE)} Maintenance`, value: String(summary.maintenance), inline: true },
      { name: "\u23F8\uFE0F Paused", value: String(summary.paused), inline: true },
      { name: "Total", value: String(summary.total), inline: true },
    )
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleMonitorsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!kuma.connected) {
    await interaction.reply({
      content: "\u26A0\uFE0F Not connected to Uptime Kuma.",
      ephemeral: true,
    });
    return;
  }

  const monitors = [...kuma.monitors.values()]
    .filter((m) => m.type !== "group")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (monitors.length === 0) {
    await interaction.reply({ content: "No monitors configured.", ephemeral: true });
    return;
  }

  const lines: string[] = [];
  for (const monitor of monitors) {
    if (!monitor.active) {
      lines.push(`\u23F8\uFE0F ${monitor.name} - *paused*`);
      continue;
    }
    const status = kuma.latestStatus.get(monitor.id);
    const emoji = status !== undefined ? statusEmoji(status) : "\u26AA";
    const label = status !== undefined ? statusLabel(status) : "UNKNOWN";
    const ping = kuma.avgPing.get(monitor.id);
    const pingStr = ping && ping > 0 ? ` (${Math.round(ping)}ms)` : "";
    lines.push(`${emoji} ${monitor.name} - ${label}${pingStr}`);
  }

  let description = lines.join("\n");
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n*... ${monitors.length} total*`;
  }

  const embed = new EmbedBuilder()
    .setTitle("All Monitors")
    .setDescription(description)
    .setColor(0x7289da)
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleMonitorCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!kuma.connected) {
    await interaction.reply({
      content: "\u26A0\uFE0F Not connected to Uptime Kuma.",
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString("name", true).toLowerCase();
  const match = [...kuma.monitors.values()].find((m) =>
    m.name.toLowerCase().includes(query)
  );

  if (!match) {
    await interaction.reply({
      content: `No monitor found matching "${query}".`,
      ephemeral: true,
    });
    return;
  }

  const status = kuma.latestStatus.get(match.id);
  const emoji = status !== undefined ? statusEmoji(status) : "\u26AA";
  const label = status !== undefined ? statusLabel(status) : "UNKNOWN";
  const ping = kuma.avgPing.get(match.id);
  const uptime = kuma.uptimeMap.get(match.id);

  const fields = [
    { name: "Status", value: `${emoji} ${label}`, inline: true },
    { name: "Type", value: match.type, inline: true },
    { name: "Active", value: match.active ? "Yes" : "Paused", inline: true },
  ];

  if (match.url) fields.push({ name: "URL", value: match.url, inline: false });
  if (match.hostname) fields.push({ name: "Host", value: `${match.hostname}${match.port ? `:${match.port}` : ""}`, inline: true });
  if (ping !== undefined) fields.push({ name: "Avg Ping", value: `${Math.round(ping)}ms`, inline: true });
  if (uptime !== undefined) fields.push({ name: "Uptime (24h)", value: `${(uptime * 100).toFixed(2)}%`, inline: true });
  if (match.interval) fields.push({ name: "Check Interval", value: `${match.interval}s`, inline: true });
  if (match.tags.length > 0) {
    fields.push({
      name: "Tags",
      value: match.tags.map((t) => t.name).join(", "),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(match.name)
    .setDescription(match.description || null)
    .setColor(status === MonitorStatus.UP ? 0x2ecc71 : status === MonitorStatus.DOWN ? 0xe74c3c : 0xf39c12)
    .addFields(fields)
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
