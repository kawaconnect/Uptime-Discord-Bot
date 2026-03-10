import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from "discord.js";
import { logger } from "../util/logger.js";
import { kuma, MonitorStatus, statusEmoji, statusLabel, statusColor } from "../services/kuma.js";
import { updateStatusBoard } from "../services/statusBoard.js";

// ---------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show current service status summary");

export const monitorsCommand = new SlashCommandBuilder()
  .setName("monitors")
  .setDescription("List all monitors and their current state")
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Filter: all, up, down, paused, maintenance")
      .setRequired(false)
      .addChoices(
        { name: "All", value: "all" },
        { name: "Down only", value: "down" },
        { name: "Up only", value: "up" },
        { name: "Paused only", value: "paused" },
        { name: "Maintenance", value: "maintenance" },
      )
  );

export const monitorCommand = new SlashCommandBuilder()
  .setName("monitor")
  .setDescription("Show details for a specific monitor")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor name").setRequired(true).setAutocomplete(true)
  );

export const pauseCommand = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pause a monitor")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor name").setRequired(true).setAutocomplete(true)
  );

export const resumeCommand = new SlashCommandBuilder()
  .setName("resume")
  .setDescription("Resume a paused monitor")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor name").setRequired(true).setAutocomplete(true)
  );

export const downtimeCommand = new SlashCommandBuilder()
  .setName("downtime")
  .setDescription("Show all currently down monitors");

export const refreshCommand = new SlashCommandBuilder()
  .setName("refresh")
  .setDescription("Force refresh the status board embed");

// ---------------------------------------------------------------
// Autocomplete handler (shared for monitor name fields)
// ---------------------------------------------------------------

export async function handleMonitorAutocomplete(
  interaction: AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused();
  const matches = kuma.searchMonitors(focused, 25);

  await interaction.respond(
    matches.map((m) => {
      const status = kuma.latestStatus.get(m.id);
      const emoji = !m.active ? "\u23F8" : status !== undefined ? (status === MonitorStatus.UP ? "\u2705" : status === MonitorStatus.DOWN ? "\u274C" : "\u26A0") : "\u2753";
      return {
        name: `${emoji} ${m.name}`.slice(0, 100),
        value: String(m.id),
      };
    })
  );
}

// ---------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------

function ensureConnected(interaction: ChatInputCommandInteraction): boolean {
  if (!kuma.connected) {
    interaction.reply({
      content: "\u26A0\uFE0F Not connected to Uptime Kuma. Check bot logs.",
      ephemeral: true,
    }).catch(() => {});
    return false;
  }
  return true;
}

function resolveMonitor(interaction: ChatInputCommandInteraction) {
  const value = interaction.options.getString("name", true);

  // Try as ID first (from autocomplete)
  const byId = kuma.monitors.get(Number(value));
  if (byId) return byId;

  // Fall back to name search
  const matches = kuma.searchMonitors(value, 1);
  return matches[0] ?? null;
}

export async function handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;

  const summary = kuma.getSummary();
  let color = 0x2ecc71;
  if (summary.down > 0) color = 0xe74c3c;
  else if (summary.pending > 0) color = 0xf39c12;

  const downList = kuma.getDownMonitors();
  let downSection = "";
  if (downList.length > 0) {
    downSection = "\n\n**Currently Down:**\n" +
      downList.map((d) => `${statusEmoji(MonitorStatus.DOWN)} ${d.monitor.name}`).join("\n");
  }

  const embed = new EmbedBuilder()
    .setTitle(`Service Status (${summary.up}/${summary.active})`)
    .setDescription(
      `${statusEmoji(MonitorStatus.UP)} **${summary.up}** up` +
      `  |  ${statusEmoji(MonitorStatus.DOWN)} **${summary.down}** down` +
      `  |  ${statusEmoji(MonitorStatus.PENDING)} **${summary.pending}** pending` +
      (summary.maintenance > 0 ? `  |  ${statusEmoji(MonitorStatus.MAINTENANCE)} **${summary.maintenance}** maintenance` : "") +
      (summary.paused > 0 ? `  |  \u23F8\uFE0F **${summary.paused}** paused` : "") +
      downSection
    )
    .setColor(color)
    .setFooter({ text: `${summary.total} monitors total` })
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleMonitorsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;

  const filter = interaction.options.getString("filter") ?? "all";

  let monitors = [...kuma.monitors.values()]
    .filter((m) => m.type !== "group")
    .sort((a, b) => a.name.localeCompare(b.name));

  switch (filter) {
    case "down":
      monitors = monitors.filter((m) => m.active && kuma.latestStatus.get(m.id) === MonitorStatus.DOWN);
      break;
    case "up":
      monitors = monitors.filter((m) => m.active && kuma.latestStatus.get(m.id) === MonitorStatus.UP);
      break;
    case "paused":
      monitors = monitors.filter((m) => !m.active);
      break;
    case "maintenance":
      monitors = monitors.filter((m) => kuma.latestStatus.get(m.id) === MonitorStatus.MAINTENANCE);
      break;
  }

  if (monitors.length === 0) {
    await interaction.reply({ content: `No monitors match filter "${filter}".`, ephemeral: true });
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
    .setTitle(`Monitors (${filter})`)
    .setDescription(description)
    .setColor(0x7289da)
    .setFooter({ text: `${monitors.length} monitors` })
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleMonitorCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;

  const monitor = resolveMonitor(interaction);
  if (!monitor) {
    await interaction.reply({ content: "Monitor not found.", ephemeral: true });
    return;
  }

  const status = kuma.latestStatus.get(monitor.id);
  const emoji = status !== undefined ? statusEmoji(status) : "\u26AA";
  const label = status !== undefined ? statusLabel(status) : "UNKNOWN";
  const ping = kuma.avgPing.get(monitor.id);
  const uptime = kuma.uptime24h.get(monitor.id);
  const color = status !== undefined ? statusColor(status) : 0x95a5a6;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Status", value: `${emoji} ${label}`, inline: true },
    { name: "Type", value: monitor.type, inline: true },
    { name: "Active", value: monitor.active ? "Yes" : "Paused", inline: true },
  ];

  if (monitor.url) fields.push({ name: "URL", value: monitor.url, inline: false });
  if (monitor.hostname) fields.push({ name: "Host", value: `${monitor.hostname}${monitor.port ? `:${monitor.port}` : ""}`, inline: true });
  if (ping !== undefined && ping > 0) fields.push({ name: "Avg Ping (24h)", value: `${Math.round(ping)}ms`, inline: true });
  if (uptime !== undefined) fields.push({ name: "Uptime (24h)", value: `${(uptime * 100).toFixed(2)}%`, inline: true });
  fields.push({ name: "Check Interval", value: `${monitor.interval}s`, inline: true });
  fields.push({ name: "Max Retries", value: String(monitor.maxretries ?? 0), inline: true });
  if (monitor.tags.length > 0) {
    fields.push({ name: "Tags", value: monitor.tags.map((t) => `\`${t.name}\``).join(" "), inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle(monitor.name)
    .setDescription(monitor.description || null)
    .setColor(color)
    .addFields(fields)
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handlePauseCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const monitor = resolveMonitor(interaction);
  if (!monitor) {
    await interaction.editReply("Monitor not found.");
    return;
  }

  if (!monitor.active) {
    await interaction.editReply(`${monitor.name} is already paused.`);
    return;
  }

  const res = await kuma.pauseMonitor(monitor.id);
  if (res.ok) {
    await interaction.editReply(`\u23F8\uFE0F Paused **${monitor.name}**.`);
    logger.info({ monitorId: monitor.id, name: monitor.name, user: interaction.user.tag }, "Monitor paused");
  } else {
    await interaction.editReply(`Failed to pause: ${res.msg ?? "unknown error"}`);
  }
}

export async function handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  const monitor = resolveMonitor(interaction);
  if (!monitor) {
    await interaction.editReply("Monitor not found.");
    return;
  }

  if (monitor.active) {
    await interaction.editReply(`${monitor.name} is already active.`);
    return;
  }

  const res = await kuma.resumeMonitor(monitor.id);
  if (res.ok) {
    await interaction.editReply(`\u25B6\uFE0F Resumed **${monitor.name}**.`);
    logger.info({ monitorId: monitor.id, name: monitor.name, user: interaction.user.tag }, "Monitor resumed");
  } else {
    await interaction.editReply(`Failed to resume: ${res.msg ?? "unknown error"}`);
  }
}

export async function handleDowntimeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;

  const downList = kuma.getDownMonitors();

  if (downList.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle("\u{1F7E2} All Services Operational")
      .setDescription("No monitors are currently down.")
      .setColor(0x2ecc71)
      .setTimestamp(new Date());
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const lines = downList.map((d) => {
    const ping = kuma.avgPing.get(d.monitor.id);
    return `${statusEmoji(MonitorStatus.DOWN)} **${d.monitor.name}**\n  Type: ${d.monitor.type} | URL: ${d.monitor.url || d.monitor.hostname || "N/A"}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`\u{1F534} ${downList.length} Service${downList.length > 1 ? "s" : ""} Down`)
    .setDescription(lines.join("\n\n"))
    .setColor(0xe74c3c)
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleRefreshCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    await updateStatusBoard(interaction.client);
    await interaction.editReply("\u2705 Status board refreshed.");
  } catch (err) {
    logger.error({ err }, "Failed to refresh status board");
    await interaction.editReply("Failed to refresh status board.");
  }
}
