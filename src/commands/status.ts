import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../util/logger.js";
import { isAdmin, ADMINS_ONLY } from "../util/admin.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { kuma, MonitorStatus, statusEmoji, statusLabel, statusColor, type KumaMonitor } from "../services/kuma.js";
import {
  monitorChoices,
  resolveMonitorStrict,
  parseDuration,
  formatDuration,
  discordTime,
  pauseWithSchedule,
  resumeAndClear,
  pauseEmbed,
  resumeEmbed,
  pausedLines,
  pruneStalePauses,
  listPauses,
  getPause,
  MAX_PAUSE_MS,
  type ChoiceMode,
} from "../services/monitorPauses.js";
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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDescription("Pause a monitor or group in Uptime Kuma, optionally for a set time (admin only)")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor or group (type to search)").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName("duration")
      .setDescription("Resume automatically after e.g. 30m, 2h, 1d, 1h30m (blank = until /resume)")
      .setRequired(false)
      .setMaxLength(20)
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Why, so the channel knows (e.g. ISP maintenance)").setRequired(false).setMaxLength(300)
  );

export const resumeCommand = new SlashCommandBuilder()
  .setName("resume")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDescription("Resume a paused monitor or group (admin only)")
  .addStringOption((o) =>
    o.setName("name").setDescription("Monitor or group (type to search)").setRequired(true).setAutocomplete(true)
  );

export const pausedCommand = new SlashCommandBuilder()
  .setName("paused")
  .setDescription("List paused monitors: who paused them, why, and when they resume");

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
  const mode: ChoiceMode =
    interaction.commandName === "pause" ? "pause" : interaction.commandName === "resume" ? "resume" : "any";
  await interaction.respond(monitorChoices(kuma.monitors, kuma.latestStatus, focused, mode, 25));
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

/**
 * Admin gate, Kuma connection and monitor lookup shared by /pause and
 * /resume. Answers the interaction (ephemerally) and returns null on failure.
 */
async function adminMonitorTarget(interaction: ChatInputCommandInteraction): Promise<KumaMonitor | null> {
  // Pausing a Kuma monitor silences its alerts and phone escalation, so it is
  // an admin action (hidden from non-Manage-Server members by default, and
  // checked against ADMIN_USER_IDS here).
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: ADMINS_ONLY, ephemeral: true });
    return null;
  }
  if (!ensureConnected(interaction)) return null;
  const found = resolveMonitorStrict(kuma.monitors, interaction.options.getString("name", true));
  if ("error" in found) {
    await interaction.reply({ content: found.error, ephemeral: true });
    return null;
  }
  return found.monitor;
}

/** Post the public confirmation; the ephemeral reply already carries the outcome. */
async function announce(interaction: ChatInputCommandInteraction, embed: EmbedBuilder): Promise<void> {
  try {
    await interaction.followUp({ embeds: [embed], allowedMentions: NO_MENTIONS });
  } catch (err) {
    logger.warn({ err }, "Could not post the pause/resume confirmation in the channel");
  }
}

export async function handlePauseCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const monitor = await adminMonitorTarget(interaction);
  if (!monitor) return;

  const durationText = interaction.options.getString("duration")?.trim() || null;
  let durationMs: number | null = null;
  if (durationText) {
    durationMs = parseDuration(durationText);
    if (durationMs === null) {
      await interaction.reply({
        content: `Could not read the duration "${durationText.slice(0, 20)}". Use e.g. 30m, 2h, 1d or 1h30m.`,
        ephemeral: true,
      });
      return;
    }
    if (durationMs > MAX_PAUSE_MS) {
      await interaction.reply({
        content: `The longest pause is ${formatDuration(MAX_PAUSE_MS)}. For longer, use a maintenance window in Uptime Kuma.`,
        ephemeral: true,
      });
      return;
    }
  }
  const reason = interaction.options.getString("reason")?.trim().slice(0, 300) || null;

  await interaction.deferReply({ ephemeral: true });
  const out = await pauseWithSchedule({
    monitorId: monitor.id,
    durationMs,
    reason,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    channelId: interaction.channelId ?? null,
  });
  if (!out.ok) {
    await interaction.editReply(out.error ?? "Failed to pause.");
    return;
  }

  const until = out.resumeAt ? ` until ${discordTime(out.resumeAt)}` : "";
  const extra = out.paused.length > 1 ? ` and ${out.paused.length - 1} monitor${out.paused.length === 2 ? "" : "s"} in it` : "";
  await interaction.editReply(
    `\u23F8\uFE0F ${out.updated ? "Updated the pause of" : "Paused"} **${monitor.name}**${extra}${until}.` +
    (out.failed.length > 0 ? `\n\u26A0\uFE0F Could not pause: ${out.failed.map((f) => f.monitor.name).join(", ")}` : "")
  );
  await announce(interaction, pauseEmbed(out, interaction.user.id, reason ?? getPause(monitor.id)?.reason ?? null));
}

export async function handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const monitor = await adminMonitorTarget(interaction);
  if (!monitor) return;

  await interaction.deferReply({ ephemeral: true });
  const out = await resumeAndClear(monitor.id);
  if (!out.ok) {
    await interaction.editReply(out.error ?? "Failed to resume.");
    return;
  }
  const extra = out.resumed.length > 1 ? ` and ${out.resumed.length - 1} monitor${out.resumed.length === 2 ? "" : "s"} in it` : "";
  await interaction.editReply(
    `\u25B6\uFE0F Resumed **${monitor.name}**${extra}.` +
    (out.failed.length > 0 ? `\n\u26A0\uFE0F Could not resume: ${out.failed.map((f) => f.monitor.name).join(", ")}` : "")
  );
  await announce(interaction, resumeEmbed(out, { userId: interaction.user.id }));
}

export async function handlePausedCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ensureConnected(interaction)) return;
  pruneStalePauses();
  const lines = pausedLines(kuma.monitors, listPauses());
  if (lines.length === 0) {
    await interaction.reply({ content: "No monitors are paused.", ephemeral: true });
    return;
  }
  let description = lines.join("\n");
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n*... ${lines.length} total*`;
  }
  const embed = new EmbedBuilder()
    .setTitle(`\u23F8\uFE0F Paused monitors (${lines.length})`)
    .setDescription(description)
    .setColor(0xf1c40f)
    .setFooter({ text: "Admins: /pause <name> [duration] [reason], /resume <name>" })
    .setTimestamp(new Date());
  await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: NO_MENTIONS });
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
