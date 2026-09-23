/**
 * /phone - inspect and configure phone escalation.
 *
 * Every alert category has its own toggle so a noisy one can be silenced
 * without losing the rest. Defaults are all on: a phone call is the last
 * line of defence and silently not calling is the worst failure mode here.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../util/logger.js";
import {
  CALL_KINDS,
  type CallKind,
  callKindStates,
  setCallEnabledFor,
  isPhoneEscalationEnabled,
} from "../services/phone.js";
import { getSettingOrEnv } from "../db/index.js";
import { env } from "../util/env.js";

// Same rule as /setup, /sg-setup and /sg-pause: an empty ADMIN_USER_IDS
// allows everyone who can see the command.
function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length === 0 || ids.includes(userId);
}

const kindChoices = (Object.keys(CALL_KINDS) as CallKind[]).map((k) => ({
  name: CALL_KINDS[k],
  value: k,
}));

export const phoneCommand = new SlashCommandBuilder()
  .setName("phone")
  .setDescription("Phone call escalation settings")
  .addSubcommand((sc) =>
    sc.setName("show").setDescription("Show which alerts trigger a phone call"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("toggle")
      .setDescription("Turn phone calls on or off for one alert type")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Alert type")
          .setRequired(true)
          .addChoices(...kindChoices),
      )
      .addStringOption((o) =>
        o
          .setName("state")
          .setDescription("Enable or disable")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
      ),
  );

export async function handlePhoneCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "toggle") {
    // Turning a call type off silences the last line of defence, so it is
    // restricted to admins (same rule as /setup, /sg-setup and /sg-pause).
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({
        content: "You are not permitted to change phone escalation settings.",
        ephemeral: true,
      });
      return;
    }
    const kind = interaction.options.getString("type", true) as CallKind;
    const on = interaction.options.getString("state", true) === "on";
    setCallEnabledFor(kind, on);
    logger.info(
      { kind, enabled: on, user: interaction.user.tag },
      "Phone escalation toggled",
    );
    await interaction.reply({
      content: `Phone calls for **${CALL_KINDS[kind]}** are now **${on ? "on" : "off"}**.`,
      ephemeral: true,
    });
    return;
  }

  const master = isPhoneEscalationEnabled();
  const url = getSettingOrEnv("PBX_ALERT_URL") || "not set";
  const lines = callKindStates()
    .map((s) => `${s.enabled ? "📞" : "🔕"} ${s.label}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Phone escalation")
    .setColor(master ? 0x2ecc71 : 0x95a5a6)
    .setDescription(
      master
        ? "Enabled. The PBX decides when a call is due and drives the escalation chain."
        : "**Disabled.** No alert will ring a phone, whatever the toggles below say.",
    )
    .addFields(
      { name: "Alert types", value: lines || "none" },
      { name: "PBX connector", value: url },
    )
    .setFooter({
      text: "Timing, quiet hours and the call order are configured on the PBX, not here.",
    });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
