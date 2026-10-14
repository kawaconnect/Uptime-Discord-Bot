/**
 * /wp - WordPress operations: failover, backups, restores, permissions.
 *
 * Everything is reachable from the control panel (`/wp panel`: buttons and
 * select menus with confirmation steps) and from slash subcommands. Every
 * action checks the delegated permissions (services/permissions.ts) and is
 * executed by the node agent (services/wpops.ts); the bot never touches DNS
 * or files itself.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { CAPABILITIES, can, capabilitiesOf, grant, isAdminUser, listGrants, memberRoleIds, revoke, type Capability } from "../services/permissions.js";
import { getNode, getNodes, saveNodes, wpops, WpopsClient, WpopsError, fmtAgo, fmtBytes, type Selection, type WpPlan } from "../services/wpops.js";

const EPH = { flags: MessageFlags.Ephemeral } as const;
const COLOR = { ok: 0x2ecc71, warn: 0xf39c12, bad: 0xe74c3c, info: 0x3498db, red: 0xc0392b } as const;

// ------------------------------------------------------------ pending UI state

interface Pending {
  userId: string;
  node: string;
  kind: "failover" | "rollback" | "restore" | "pull" | "delete";
  sel: Selection & { set?: string; stack?: string; source?: string; label?: string; entities?: string[] };
  plan?: WpPlan;
  expires: number;
}
const pending = new Map<string, Pending>();

function remember(p: Omit<Pending, "expires">): string {
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  const token = randomBytes(6).toString("hex");
  pending.set(token, { ...p, expires: Date.now() + 15 * 60_000 });
  return token;
}

function actorOf(i: Interaction): string {
  return `discord:${i.user.username}#${i.user.id}`;
}

async function denied(i: RepliableInteraction, cap: Capability): Promise<void> {
  const msg = `You need the **${cap}** permission for that. An admin can grant it with \`/wp perms grant\`.`;
  if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] });
  else await i.reply({ content: msg, ...EPH });
}

function nodeOrDefault(name?: string | null): string {
  if (name) return getNode(name).name;
  const d = wpops.defaultNode();
  if (!d) throw new WpopsError("no WordPress nodes configured (`/wp node add`)");
  return d.name;
}

function client(node: string): WpopsClient { return wpops.client(node); }

// -------------------------------------------------------------- slash command

export const wpCommand = new SlashCommandBuilder()
  .setName("wp")
  .setDescription("WordPress operations: failover, backups, restores")
  .addSubcommand((s) => s.setName("panel").setDescription("Post the WordPress control panel (buttons) in this channel"))
  .addSubcommand((s) => s.setName("status").setDescription("Nodes, active failovers, tunnels, latest backups"))
  .addSubcommand((s) => s.setName("sites").setDescription("Sites in the inventory and where they point").addBooleanOption((o) => o.setName("live").setDescription("Query Cloudflare DNS now")))
  .addSubcommandGroup((g) => g.setName("failover").setDescription("Move sites to the backup node, or back")
    .addSubcommand((s) => s.setName("down").setDescription("Switch every site that is currently DOWN to the backup").addStringOption((o) => o.setName("to").setDescription("Target node")))
    .addSubcommand((s) => s.setName("all").setDescription("Switch ALL sites to the backup").addStringOption((o) => o.setName("to").setDescription("Target node")))
    .addSubcommand((s) => s.setName("site").setDescription("Switch one site to the backup").addStringOption((o) => o.setName("site").setDescription("Site slug").setRequired(true).setAutocomplete(true)).addStringOption((o) => o.setName("to").setDescription("Target node")))
    .addSubcommand((s) => s.setName("rollback").setDescription("Return sites to their primary").addStringOption((o) => o.setName("site").setDescription("Site slug (omit for all)").setAutocomplete(true)).addStringOption((o) => o.setName("node").setDescription("Node holding the override"))))
  .addSubcommandGroup((g) => g.setName("backup").setDescription("Backups pulled to the nodes")
    .addSubcommand((s) => s.setName("now").setDescription("Pull a fresh backup from a source now").addStringOption((o) => o.setName("source").setDescription("Source origin (e.g. azure)")).addStringOption((o) => o.setName("node").setDescription("Node")))
    .addSubcommand((s) => s.setName("list").setDescription("List pulled backup sets").addStringOption((o) => o.setName("node").setDescription("Node")))
    .addSubcommand((s) => s.setName("schedule").setDescription("Show or set the schedule").addStringOption((o) => o.setName("set").setDescription("weekly:sun:03:30 | daily:03:30 | off")).addIntegerOption((o) => o.setName("retain").setDescription("Weekly sets to keep per source").setMinValue(1).setMaxValue(100)).addStringOption((o) => o.setName("node").setDescription("Node")))
    .addSubcommand((s) => s.setName("keep").setDescription("Mark a set as kept (or not)").addStringOption((o) => o.setName("set").setDescription("Set id (source/set)").setRequired(true)).addBooleanOption((o) => o.setName("keep").setDescription("Keep? (default yes)")).addStringOption((o) => o.setName("node").setDescription("Node"))))
  .addSubcommand((s) => s.setName("restore").setDescription("Apply a pulled backup set to a node stack").addStringOption((o) => o.setName("set").setDescription("Set id (source/set)").setRequired(true)).addStringOption((o) => o.setName("sites").setDescription("Comma-separated site slugs (omit = all sites)")).addStringOption((o) => o.setName("stack").setDescription("Stack (default main)")).addStringOption((o) => o.setName("node").setDescription("Node")))
  .addSubcommand((s) => s.setName("jobs").setDescription("Recent agent jobs").addStringOption((o) => o.setName("id").setDescription("Job id for details/log")).addStringOption((o) => o.setName("node").setDescription("Node")))
  .addSubcommandGroup((g) => g.setName("perms").setDescription("Who may use these commands (admin)")
    .addSubcommand((s) => s.setName("grant").setDescription("Grant a capability").addStringOption((o) => o.setName("capability").setDescription("view, failover, backup, restore, admin").setRequired(true).addChoices(...CAPABILITIES.map((c) => ({ name: c, value: c })))).addUserOption((o) => o.setName("user").setDescription("User")).addRoleOption((o) => o.setName("role").setDescription("Role")))
    .addSubcommand((s) => s.setName("revoke").setDescription("Revoke a capability (or all)").addUserOption((o) => o.setName("user").setDescription("User")).addRoleOption((o) => o.setName("role").setDescription("Role")).addStringOption((o) => o.setName("capability").setDescription("Capability (omit = all)").addChoices(...CAPABILITIES.map((c) => ({ name: c, value: c })))))
    .addSubcommand((s) => s.setName("list").setDescription("List grants")))
  .addSubcommandGroup((g) => g.setName("node").setDescription("Node agents (admin)")
    .addSubcommand((s) => s.setName("add").setDescription("Add or update a node agent").addStringOption((o) => o.setName("name").setDescription("Origin name from the inventory (e.g. web02)").setRequired(true)).addStringOption((o) => o.setName("url").setDescription("Agent URL").setRequired(true)).addStringOption((o) => o.setName("token").setDescription("Agent token (wpops token rotate)").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a node").addStringOption((o) => o.setName("name").setDescription("Node name").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List nodes")))
  .addSubcommandGroup((g) => g.setName("setup").setDescription("Settings (admin)")
    .addSubcommand((s) => s.setName("channel").setDescription("Channel for WordPress ops notifications").addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName("email").setDescription("E-mail WordPress ops notifications (uses /setup smtp)").addBooleanOption((o) => o.setName("enabled").setDescription("On/off").setRequired(true))));

// ------------------------------------------------------------------ handlers

export async function handleWpCommand(i: ChatInputCommandInteraction): Promise<void> {
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand();
  try {
    if (!group) {
      switch (sub) {
        case "panel": return await cmdPanel(i);
        case "status": return await cmdStatus(i);
        case "sites": return await cmdSites(i);
        case "restore": return await cmdRestore(i);
        case "jobs": return await cmdJobs(i);
      }
    }
    if (group === "failover") return await cmdFailover(i, sub);
    if (group === "backup") return await cmdBackup(i, sub);
    if (group === "perms") return await cmdPerms(i, sub);
    if (group === "node") return await cmdNode(i, sub);
    if (group === "setup") return await cmdSetup(i, sub);
    await i.reply({ content: "Unknown subcommand.", ...EPH });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sub, group }, "/wp failed");
    if (i.deferred || i.replied) await i.editReply({ content: `❌ ${msg}`, embeds: [], components: [] });
    else await i.reply({ content: `❌ ${msg}`, ...EPH });
  }
}

export async function handleWpAutocomplete(i: Interaction): Promise<void> {
  if (!i.isAutocomplete() || i.commandName !== "wp") return;
  const focused = i.options.getFocused(true);
  if (focused.name !== "site") return;
  const q = focused.value.toLowerCase();
  const choices = [...wpops.sites().values()].filter((s) => s.slug.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 25)
    .map((s) => ({ name: `${s.name} (${s.slug})`, value: s.slug }));
  await i.respond(choices);
}

// ------------------------------------------------------------------ status

function statusEmbed(): EmbedBuilder {
  const e = new EmbedBuilder().setTitle("WordPress operations").setColor(COLOR.info).setTimestamp();
  const overrides = wpops.activeOverrides();
  if (overrides.length) {
    const bySite = new Map<string, { node: string; domains: string[]; since: number }>();
    for (const o of overrides) {
      const k = `${o.override.site}@${o.node}`;
      const cur = bySite.get(k) ?? { node: o.node, domains: [], since: o.override.switched_at };
      cur.domains.push(o.domain);
      bySite.set(k, cur);
    }
    e.setColor(COLOR.red);
    e.addFields({ name: `🔴 FAILOVER ACTIVE - ${bySite.size} site(s) on backup`, value: [...bySite.entries()].map(([k, v]) => `• **${k.split("@")[0]}** → ${v.node} (${v.domains.length} domains, since <t:${v.since}:R>)`).join("\n").slice(0, 1000) });
  } else {
    e.addFields({ name: "✅ No failover active", value: "All sites point at their primary." });
  }
  for (const snap of wpops.snapshots.values()) {
    const st = snap.status;
    if (!st || snap.error) { e.addFields({ name: `⚠️ ${snap.node.name}`, value: `agent unreachable: ${snap.error || "no data"}` }); continue; }
    const tunnelsOk = st.tunnels.filter((t) => t.ready).length;
    const stacks = Object.entries(st.stacks).map(([n, s]) => `${s.healthy ? "🟢" : "🔴"} ${n} (${s.mode})`).join(", ");
    const latest = Object.values(st.backups.latest).map((b) => `${b.id} - ${fmtBytes(b.size)}, ${fmtAgo(b.pulled_at)}`).join("\n") || "none pulled yet";
    const sched = st.backups.schedule;
    e.addFields({
      name: `🖥️ ${snap.node.name} (agent ${st.version})`,
      value: [
        `Stacks: ${stacks}`,
        `Tunnels ready: ${tunnelsOk}/${st.tunnels.length}${tunnelsOk < st.tunnels.length ? ` (missing: ${st.tunnels.filter((t) => !t.ready).map((t) => t.account).join(", ")})` : ""}`,
        `Backups: ${st.backups.sets} sets, ${fmtBytes(st.backups.disk.free)} free - schedule \`${sched.schedule}\` (keep ${sched.retain_sets}), next ${sched.next_run ? `<t:${sched.next_run}:R>` : "-"}`,
        `Latest:\n${latest}`,
        st.jobs.active.length ? `⏳ Running: ${st.jobs.active.map((j) => `${j.kind} (${j.id})`).join(", ")}` : "",
      ].filter(Boolean).join("\n").slice(0, 1020),
    });
  }
  if (wpops.snapshots.size === 0) e.setDescription("No node agents configured. Admin: `/wp node add <name> <url> <token>`.");
  const down = wpops.downSiteSlugs();
  if (down.length) e.addFields({ name: `🚨 Sites currently down (${down.length})`, value: down.map((d) => `• ${d.slug} - ${d.reason}`).join("\n").slice(0, 1000) });
  return e;
}

async function cmdStatus(i: ChatInputCommandInteraction): Promise<void> {
  if (!can(i, "view")) return denied(i, "view");
  await i.deferReply(EPH);
  await wpops.poll();
  await i.editReply({ embeds: [statusEmbed()] });
}

async function cmdSites(i: ChatInputCommandInteraction): Promise<void> {
  if (!can(i, "view")) return denied(i, "view");
  await i.deferReply(EPH);
  const node = nodeOrDefault();
  if (i.options.getBoolean("live")) {
    const { sites } = await client(node).sitesLive();
    const lines = sites.map((s) => `${s.ok ? "🟢" : s.override ? "🔴" : "🟡"} \`${s.domain}\` → ${s.current ?? s.error}${s.override ? ` (override ${s.override})` : ""}`);
    await i.editReply({ embeds: [new EmbedBuilder().setTitle("Sites - live DNS").setDescription(lines.join("\n").slice(0, 4000)).setColor(COLOR.info)] });
    return;
  }
  const sites = [...wpops.sites().values()];
  const lines = sites.map((s) => `${wpops.isSiteInFailover(s.slug) ? "🔴" : "🟢"} **${s.name}** (\`${s.slug}\`) primary **${s.primary}** - ${s.domains.join(", ")}`);
  await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Sites (${sites.length})`).setDescription(lines.join("\n").slice(0, 4000) || "inventory not loaded yet").setColor(COLOR.info)] });
}

// ---------------------------------------------------------------- failover

function planEmbed(plan: WpPlan, title: string): EmbedBuilder {
  const e = new EmbedBuilder().setTitle(title).setColor(plan.changes.length ? COLOR.warn : COLOR.info);
  const sw = plan.changes.map((c) => `• \`${c.domain}\` ${c.from_origin} → **${c.to_origin}** (${c.stack})`).join("\n");
  e.addFields({ name: `Will switch ${plan.summary.switch} domain(s) to ${plan.to}`, value: sw.slice(0, 1020) || "nothing" });
  if (plan.noop.length) e.addFields({ name: `Unchanged (${plan.noop.length})`, value: plan.noop.map((n) => `• ${n.domain}: ${n.reason}`).join("\n").slice(0, 1020) });
  if (plan.refused.length) e.addFields({ name: `⛔ Refused (${plan.refused.length})`, value: plan.refused.map((r) => `• ${r.site}/${r.domain}: ${r.reason}`).join("\n").slice(0, 1020) });
  return e;
}

function confirmRow(token: string, label: string, danger = true): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wp:confirm:${token}`).setLabel(label).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wp:cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

/** Build a plan and ask for confirmation (slash and panel share this). */
async function proposeFailover(i: RepliableInteraction, sel: Selection, node: string): Promise<void> {
  const plan = await client(node).plan(sel, actorOf(i));
  if (!plan.changes.length) {
    await i.editReply({ embeds: [planEmbed(plan, "Failover: nothing to do")], components: [] });
    return;
  }
  const token = remember({ userId: i.user.id, node, kind: "failover", sel, plan });
  await i.editReply({
    embeds: [planEmbed(plan, "Confirm failover").setFooter({ text: "DNS changes on live domains. Rollback is available afterwards." })],
    components: [confirmRow(token, `Switch ${plan.summary.switch} domain(s) now`)],
  });
}

async function proposeRollback(i: RepliableInteraction, sel: Selection, node: string): Promise<void> {
  const ovs = wpops.activeOverrides().filter((o) => o.node === node && (sel.all || (sel.sites ?? []).includes(o.override.site)));
  if (!ovs.length) {
    await i.editReply({ content: "No active override matches that selection.", embeds: [], components: [] });
    return;
  }
  const token = remember({ userId: i.user.id, node, kind: "rollback", sel });
  const e = new EmbedBuilder().setTitle("Confirm rollback to primary").setColor(COLOR.warn)
    .setDescription(ovs.map((o) => `• \`${o.domain}\` → back to **${o.override.from}** (site ${o.override.site})`).join("\n").slice(0, 4000));
  await i.editReply({ embeds: [e], components: [confirmRow(token, `Restore ${ovs.length} domain(s)`, false)] });
}

async function cmdFailover(i: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (!can(i, "failover")) return denied(i, "failover");
  await i.deferReply(EPH);
  if (sub === "rollback") {
    const site = i.options.getString("site");
    const node = nodeOrDefault(i.options.getString("node"));
    return proposeRollback(i, site ? { sites: [site] } : { all: true }, node);
  }
  const to = i.options.getString("to") ?? undefined;
  const node = nodeOrDefault(to);
  if (sub === "all") return proposeFailover(i, { all: true, to: node }, node);
  if (sub === "site") return proposeFailover(i, { sites: [i.options.getString("site", true)], to: node }, node);
  const down = wpops.downSiteSlugs();
  if (!down.length) {
    await i.editReply({ content: "No site is currently down according to SiteGuard or the bot's probes. Nothing to switch.", components: [] });
    return;
  }
  return proposeFailover(i, { sites: down.map((d) => d.slug), to: node }, node);
}

// ------------------------------------------------------------------ backup

async function cmdBackup(i: ChatInputCommandInteraction, sub: string): Promise<void> {
  const cap: Capability = sub === "list" ? "view" : "backup";
  if (!can(i, cap)) return denied(i, cap);
  await i.deferReply(EPH);
  const node = nodeOrDefault(i.options.getString("node"));
  const c = client(node);
  if (sub === "list") {
    const { sets } = await c.backups();
    if (!sets.length) { await i.editReply("No backup sets pulled yet."); return; }
    const lines = sets.slice(0, 25).map((s) => `${s.complete ? "💾" : "⏳"} \`${s.id}\` - ${fmtBytes(s.size)}, ${s.sites} sites, ${fmtAgo(s.pulled_at)}${s.keep ? " 📌" : ""}${s.applied.length ? ` ✅ applied ${s.applied.length}×` : ""}${s.label ? ` - ${s.label}` : ""}`);
    await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Backup sets on ${node}`).setDescription(lines.join("\n").slice(0, 4000)).setColor(COLOR.info)] });
    return;
  }
  if (sub === "schedule") {
    const set = i.options.getString("set"); const retain = i.options.getInteger("retain");
    const info = set || retain !== null ? await c.setSchedule({ schedule: set ?? undefined, retain: retain ?? undefined }, actorOf(i)) : await c.schedule();
    await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Backup schedule on ${node}`).setColor(COLOR.info).setDescription([
      `Schedule: \`${info.schedule}\``, `Retention: keep **${info.retain_sets}** sets per source`,
      `Sources: ${info.sources?.length ? info.sources.join(", ") : "all with a sync API"}`,
      `Next run: ${info.next_run ? `<t:${info.next_run}:F>` : "-"}`, `Last run: ${info.last_run ? `<t:${info.last_run}:R>` : "never"}`,
    ].join("\n"))] });
    return;
  }
  if (sub === "keep") {
    await c.keep(i.options.getString("set", true), i.options.getBoolean("keep") ?? true, actorOf(i));
    await i.editReply(`Updated keep flag on \`${i.options.getString("set", true)}\`.`);
    return;
  }
  // now
  const source = i.options.getString("source") ?? await defaultSource(node);
  const { job } = await c.pull(source, `manual by ${i.user.username}`, actorOf(i));
  await i.editReply(`⏳ Pull from **${source}** started on **${node}** (job \`${job}\`). You'll get a notification when it finishes.`);
}

async function defaultSource(node: string): Promise<string> {
  const snap = wpops.snapshots.get(node);
  const sched = snap?.status?.backups.schedule;
  if (sched?.sources?.length) return sched.sources[0];
  const inv = await client(node).inventory();
  const withApi = Object.entries(inv.origins).filter(([, o]) => (o as { sync_api?: boolean }).sync_api).map(([n]) => n);
  if (!withApi.length) throw new WpopsError("no backup source has a sync API configured in the inventory");
  return withApi[0];
}

// ----------------------------------------------------------------- restore

async function proposeRestore(i: RepliableInteraction, node: string, set: string, stack: string, sites: string[] | undefined): Promise<void> {
  const { sets } = await client(node).backups();
  const s = sets.find((x) => x.id === set);
  if (!s) throw new WpopsError(`no such set on ${node}: ${set}`);
  if (!s.complete) throw new WpopsError(`${set} is not completely pulled`);
  const token = remember({ userId: i.user.id, node, kind: "restore", sel: { set, stack, sites, all: !sites?.length } });
  const e = new EmbedBuilder().setTitle("Confirm restore").setColor(COLOR.warn).setDescription([
    `Set: \`${set}\` (${fmtBytes(s.size)}, ${s.sites} sites, pulled ${fmtAgo(s.pulled_at)}${s.label ? `, ${s.label}` : ""})`,
    `Target: **${node}** stack **${stack}**`,
    `Scope: ${sites?.length ? sites.map((x) => `\`${x}\``).join(", ") : "**ALL sites** (whole network)"}`,
    "", "SiteGuard takes a pre-restore backup first. The live site content on the target is replaced.",
  ].join("\n"));
  await i.editReply({ embeds: [e], components: [confirmRow(token, "Apply this backup")] });
}

async function cmdRestore(i: ChatInputCommandInteraction): Promise<void> {
  if (!can(i, "restore")) return denied(i, "restore");
  await i.deferReply(EPH);
  const node = nodeOrDefault(i.options.getString("node"));
  const sites = (i.options.getString("sites") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  await proposeRestore(i, node, i.options.getString("set", true), i.options.getString("stack") ?? "main", sites.length ? sites : undefined);
}

// -------------------------------------------------------------------- jobs

async function cmdJobs(i: ChatInputCommandInteraction): Promise<void> {
  if (!can(i, "view")) return denied(i, "view");
  await i.deferReply(EPH);
  const node = nodeOrDefault(i.options.getString("node"));
  const id = i.options.getString("id");
  const c = client(node);
  if (id) {
    const j = await c.job(id);
    const { log } = await c.jobLog(id, 30);
    await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Job ${j.id} - ${j.kind} - ${j.status}`).setColor(j.status === "failed" ? COLOR.bad : j.terminal ? COLOR.ok : COLOR.info)
      .setDescription(`By ${j.actor}, created <t:${j.created}:R>${j.error ? `\nError: ${j.error.slice(0, 300)}` : ""}\n\`\`\`\n${(log || "(no log)").slice(-1700)}\n\`\`\``)] });
    return;
  }
  const { jobs } = await c.jobs(15);
  const icon = (s: string) => (s === "succeeded" ? "✅" : s === "failed" ? "❌" : "⏳");
  await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Jobs on ${node}`).setColor(COLOR.info).setDescription(jobs.map((j) => `${icon(j.status)} \`${j.id}\` ${j.kind} - ${j.actor} <t:${j.created}:R>`).join("\n") || "none")] });
}

// ------------------------------------------------------------------- perms

async function cmdPerms(i: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (!i.guildId) { await i.reply({ content: "Guild only.", ...EPH }); return; }
  if (!can(i, "admin")) return denied(i, "admin");
  if (sub === "list") {
    const rows = listGrants(i.guildId);
    const lines = rows.map((r) => `• ${r.principal_type === "user" ? `<@${r.principal_id}>` : `<@&${r.principal_id}>`} - **${r.capability}** (by <@${r.granted_by}> <t:${Math.floor(r.granted_at / 1000)}:d>)`);
    const admins = i.client.application?.id ? "" : "";
    await i.reply({ embeds: [new EmbedBuilder().setTitle("WordPress ops permissions").setColor(COLOR.info).setDescription((lines.join("\n") || "No grants yet.") + `\n\nAdmins (always everything): ${wpops ? "" : ""}${admins}${(process.env.ADMIN_USER_IDS ?? "").split(",").filter(Boolean).map((id) => `<@${id.trim()}>`).join(", ") || "none"}`)], ...EPH });
    return;
  }
  const user = i.options.getUser("user"); const role = i.options.getRole("role");
  if (!user && !role) { await i.reply({ content: "Give a user or a role.", ...EPH }); return; }
  const principal_type = user ? "user" : "role"; const principal_id = user ? user.id : role!.id;
  const who = user ? `<@${user.id}>` : `<@&${role!.id}>`;
  if (sub === "grant") {
    const capability = i.options.getString("capability", true) as Capability;
    grant({ guild_id: i.guildId, principal_type, principal_id, capability, granted_by: i.user.id });
    await i.reply({ content: `Granted **${capability}** to ${who}.`, ...EPH });
    return;
  }
  const capability = (i.options.getString("capability") ?? undefined) as Capability | undefined;
  const n = revoke(i.guildId, principal_type, principal_id, capability);
  await i.reply({ content: n ? `Revoked ${capability ?? "all capabilities"} from ${who}.` : `${who} had no matching grant.`, ...EPH });
}

// -------------------------------------------------------------------- nodes

async function cmdNode(i: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (!isAdminUser(i.user.id) && !can(i, "admin")) return denied(i, "admin");
  if (sub === "list") {
    const nodes = getNodes();
    await i.reply({ content: nodes.length ? nodes.map((n) => `• **${n.name}** - ${n.url}`).join("\n") : "No nodes configured.", ...EPH });
    return;
  }
  if (sub === "remove") {
    const name = i.options.getString("name", true);
    saveNodes(getNodes().filter((n) => n.name !== name));
    wpops.snapshots.delete(name);
    await i.reply({ content: `Removed node ${name}.`, ...EPH });
    return;
  }
  await i.deferReply(EPH);
  const name = i.options.getString("name", true).trim();
  const url = i.options.getString("url", true).trim().replace(/\/$/, "");
  const token = i.options.getString("token", true).trim();
  const probe = new WpopsClient({ name, url, token });
  const h = await probe.health();
  const st = await probe.status();
  if (h.node !== name) throw new WpopsError(`agent at ${url} calls itself '${h.node}', not '${name}'`);
  const nodes = getNodes().filter((n) => n.name !== name);
  nodes.push({ name, url, token });
  saveNodes(nodes);
  await wpops.poll();
  await i.editReply(`Node **${name}** saved (agent ${h.version}, ${Object.keys(st.stacks).length} stack(s), ${st.sites} sites in inventory).`);
}

async function cmdSetup(i: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (!can(i, "admin")) return denied(i, "admin");
  if (sub === "channel") {
    const ch = i.options.getChannel("channel", true);
    setSetting("WP_ALERT_CHANNEL_ID", ch.id);
    await i.reply({ content: `WordPress ops notifications go to <#${ch.id}>.`, ...EPH });
    return;
  }
  setSetting("WP_ALERT_EMAIL_ENABLED", i.options.getBoolean("enabled", true) ? "true" : "false");
  await i.reply({ content: `E-mail notifications ${i.options.getBoolean("enabled", true) ? "enabled" : "disabled"}.`, ...EPH });
}

// -------------------------------------------------------------------- panel

export function panelComponents(): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const b = (id: string, label: string, style: ButtonStyle, emoji?: string) => {
    const x = new ButtonBuilder().setCustomId(`wp:btn:${id}`).setLabel(label).setStyle(style);
    if (emoji) x.setEmoji(emoji);
    return x;
  };
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      b("status", "Status", ButtonStyle.Secondary, "📊"),
      b("fo_down", "Failover DOWN sites", ButtonStyle.Danger, "🚑"),
      b("fo_all", "Failover ALL sites", ButtonStyle.Danger, "🔥"),
      b("fo_site", "Failover one site…", ButtonStyle.Primary, "🎯"),
      b("rollback", "Rollback to primary", ButtonStyle.Success, "↩️"),
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      b("backups", "Backups", ButtonStyle.Secondary, "💾"),
      b("pull", "Pull backup now", ButtonStyle.Primary, "⬇️"),
      b("restore", "Apply backup…", ButtonStyle.Danger, "🧩"),
      b("jobs", "Jobs", ButtonStyle.Secondary, "🧾"),
      b("help", "Help", ButtonStyle.Secondary, "❓"),
    ),
  ];
}

export function panelEmbed(): EmbedBuilder {
  const s = wpops.summary();
  const ov = wpops.activeOverrides();
  const e = new EmbedBuilder().setTitle("🛠️ WordPress control panel").setColor(ov.length ? COLOR.red : COLOR.info)
    .setDescription([
      ov.length ? `🔴 **FAILOVER ACTIVE** - ${new Set(ov.map((o) => o.override.site)).size} site(s) served by backup. Use **Rollback** when the primary is healthy again.` : "✅ All sites on their primary.",
      `Nodes: ${s.reachable}/${s.nodes} reachable · tunnels ready ${s.tunnelsReady}/${s.tunnels} · latest backup ${fmtAgo(s.latestBackup)}`,
      "",
      "**Failover DOWN sites** switches only what SiteGuard/the bot sees as down. **Failover ALL** moves every site. Every action asks for confirmation and only people with the right permission can confirm.",
    ].join("\n"))
    .setFooter({ text: "Buttons stay usable; permissions are checked on every click." });
  return e;
}

async function cmdPanel(i: ChatInputCommandInteraction): Promise<void> {
  if (!can(i, "view")) return denied(i, "view");
  await i.deferReply();
  await wpops.poll();
  const msg = await i.editReply({ embeds: [panelEmbed()], components: panelComponents() });
  setSetting("WP_PANEL_MESSAGE", JSON.stringify({ channelId: msg.channelId, messageId: msg.id }));
}

/** Re-render the panel message (called when overrides change). */
export async function refreshPanel(clientRef: { channels: { fetch(id: string): Promise<unknown> } }): Promise<void> {
  const raw = getSetting("WP_PANEL_MESSAGE");
  if (!raw) return;
  try {
    const { channelId, messageId } = JSON.parse(raw) as { channelId: string; messageId: string };
    const ch = await clientRef.channels.fetch(channelId) as { isTextBased?: () => boolean; messages?: { fetch(id: string): Promise<{ edit(o: unknown): Promise<unknown> }> } } | null;
    if (!ch?.isTextBased?.() || !ch.messages) return;
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ embeds: [panelEmbed()], components: panelComponents() });
  } catch (err) {
    logger.debug({ err }, "panel refresh skipped");
  }
}

// --------------------------------------------------------------- components

function siteSelect(customId: string, placeholder: string, multi = false, onlyOverridden = false): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  let sites = [...wpops.sites().values()];
  if (onlyOverridden) {
    const ov = new Set(wpops.activeOverrides().map((o) => o.override.site));
    sites = sites.filter((s) => ov.has(s.slug));
  }
  if (!sites.length) return null;
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
    .addOptions(sites.slice(0, 25).map((s) => ({ label: s.name.slice(0, 100), value: s.slug, description: s.domains[0]?.slice(0, 100) })));
  if (multi) menu.setMinValues(1).setMaxValues(Math.min(25, sites.length));
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

export async function handleWpButton(i: ButtonInteraction): Promise<void> {
  const [, action, arg] = i.customId.split(":");
  try {
    if (action === "cancel") {
      pending.delete(arg);
      await i.update({ content: "Cancelled.", embeds: [], components: [] });
      return;
    }
    if (action === "confirm") return await confirmAction(i, arg);
    if (action !== "btn") return;
    switch (arg) {
      case "status":
        if (!can(i, "view")) return denied(i, "view");
        await i.deferReply(EPH); await wpops.poll();
        await i.editReply({ embeds: [statusEmbed()] });
        return;
      case "help":
        await i.reply({ ...EPH, embeds: [new EmbedBuilder().setTitle("WordPress ops - how it works").setColor(COLOR.info).setDescription([
          "**Failover DOWN sites** - moves only the sites SiteGuard or the bot currently sees as down to the backup node (DNS → Cloudflare tunnel). Confirmation shows exactly which domains.",
          "**Failover ALL sites** - same for every site in the inventory.",
          "**Failover one site…** - pick a site from the list.",
          "**Rollback to primary** - restores the original DNS records that were saved when the failover happened.",
          "**Backups** - sets the node pulled from the primary (weekly by default; `/wp backup schedule`). They are never applied automatically.",
          "**Pull backup now** / **Apply backup…** - start a pull, or apply a pulled set to all sites or chosen sites.",
          "Permissions: `/wp perms grant @user|@role <view|failover|backup|restore|admin>`.",
        ].join("\n\n"))] });
        return;
      case "fo_down": {
        if (!can(i, "failover")) return denied(i, "failover");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        const down = wpops.downSiteSlugs();
        if (!down.length) { await i.editReply("No site is currently down. Nothing to switch."); return; }
        return await proposeFailover(i, { sites: down.map((d) => d.slug), to: node }, node);
      }
      case "fo_all": {
        if (!can(i, "failover")) return denied(i, "failover");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        return await proposeFailover(i, { all: true, to: node }, node);
      }
      case "fo_site": {
        if (!can(i, "failover")) return denied(i, "failover");
        const row = siteSelect("wp:sel:fo_site", "Pick the site to fail over");
        if (!row) { await i.reply({ content: "Inventory not loaded yet.", ...EPH }); return; }
        await i.reply({ content: "Which site?", components: [row], ...EPH });
        return;
      }
      case "rollback": {
        if (!can(i, "failover")) return denied(i, "failover");
        const ov = wpops.activeOverrides();
        if (!ov.length) { await i.reply({ content: "No failover is active.", ...EPH }); return; }
        const row = siteSelect("wp:sel:rollback", "Pick sites to roll back (or choose all below)", true, true);
        const allRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new ButtonBuilder().setCustomId("wp:btn:rollback_all").setLabel("Roll back ALL overrides").setStyle(ButtonStyle.Success));
        await i.reply({ content: "Roll back which sites?", components: row ? [row, allRow] : [allRow], ...EPH });
        return;
      }
      case "rollback_all": {
        if (!can(i, "failover")) return denied(i, "failover");
        await i.deferUpdate();
        const nodes = [...new Set(wpops.activeOverrides().map((o) => o.node))];
        return await proposeRollback(i, { all: true }, nodes[0] ?? nodeOrDefault());
      }
      case "backups": {
        if (!can(i, "view")) return denied(i, "view");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        const { sets } = await client(node).backups();
        const lines = sets.slice(0, 25).map((s) => `${s.complete ? "💾" : "⏳"} \`${s.id}\` - ${fmtBytes(s.size)}, ${s.sites} sites, ${fmtAgo(s.pulled_at)}${s.keep ? " 📌" : ""}${s.applied.length ? " ✅ applied" : ""}${s.label ? ` - ${s.label}` : ""}`);
        const st = wpops.snapshots.get(node)?.status;
        await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Backup sets on ${node}`).setColor(COLOR.info).setDescription((lines.join("\n") || "none pulled yet").slice(0, 3800) + (st ? `\n\nSchedule \`${st.backups.schedule.schedule}\`, keep ${st.backups.schedule.retain_sets}, next ${st.backups.schedule.next_run ? `<t:${st.backups.schedule.next_run}:R>` : "-"}` : ""))] });
        return;
      }
      case "pull": {
        if (!can(i, "backup")) return denied(i, "backup");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        const source = await defaultSource(node);
        const token = remember({ userId: i.user.id, node, kind: "pull", sel: { source } });
        await i.editReply({ content: `Pull a fresh full backup from **${source}** to **${node}** now? This creates a backup on the source and downloads it; it is not applied.`, components: [confirmRow(token, "Start pull", false)] });
        return;
      }
      case "restore": {
        if (!can(i, "restore")) return denied(i, "restore");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        const { sets } = await client(node).backups();
        const complete = sets.filter((s) => s.complete).slice(0, 25);
        if (!complete.length) { await i.editReply("No complete backup set on the node yet."); return; }
        const menu = new StringSelectMenuBuilder().setCustomId("wp:sel:restore_set").setPlaceholder("Pick the backup set")
          .addOptions(complete.map((s) => ({ label: s.id.slice(0, 100), value: s.id, description: `${fmtBytes(s.size)} · ${s.sites} sites · ${fmtAgo(s.pulled_at)}${s.label ? ` · ${s.label}` : ""}`.slice(0, 100) })));
        await i.editReply({ content: "Which set?", components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)] });
        return;
      }
      case "jobs": {
        if (!can(i, "view")) return denied(i, "view");
        await i.deferReply(EPH);
        const node = nodeOrDefault();
        const { jobs } = await client(node).jobs(12);
        const icon = (s: string) => (s === "succeeded" ? "✅" : s === "failed" ? "❌" : "⏳");
        await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Jobs on ${node}`).setColor(COLOR.info).setDescription(jobs.map((j) => `${icon(j.status)} \`${j.id}\` ${j.kind} - ${j.actor} <t:${j.created}:R>${j.error ? ` - ${j.error.slice(0, 80)}` : ""}`).join("\n") || "none")] });
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, customId: i.customId }, "wp button failed");
    if (i.deferred || i.replied) await i.editReply({ content: `❌ ${msg}`, embeds: [], components: [] });
    else await i.reply({ content: `❌ ${msg}`, ...EPH });
  }
}

export async function handleWpSelect(i: StringSelectMenuInteraction): Promise<void> {
  const [, , what, arg] = i.customId.split(":");
  try {
    if (what === "fo_site") {
      if (!can(i, "failover")) return denied(i, "failover");
      await i.deferUpdate();
      const node = nodeOrDefault();
      return await proposeFailover(i, { sites: i.values, to: node }, node);
    }
    if (what === "rollback") {
      if (!can(i, "failover")) return denied(i, "failover");
      await i.deferUpdate();
      const nodes = [...new Set(wpops.activeOverrides().filter((o) => i.values.includes(o.override.site)).map((o) => o.node))];
      return await proposeRollback(i, { sites: i.values }, nodes[0] ?? nodeOrDefault());
    }
    if (what === "restore_set") {
      if (!can(i, "restore")) return denied(i, "restore");
      await i.deferUpdate();
      const set = i.values[0];
      const sitesRow = siteSelect(`wp:sel:restore_sites:${set}`, "Pick sites to restore (or ALL below)", true);
      const allRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new ButtonBuilder().setCustomId(`wp:restore_all:${set}`).setLabel("Restore ALL sites").setStyle(ButtonStyle.Danger));
      await i.editReply({ content: `Set \`${set}\`. Restore which sites?`, components: sitesRow ? [sitesRow, allRow] : [allRow] });
      return;
    }
    if (what === "restore_sites") {
      if (!can(i, "restore")) return denied(i, "restore");
      await i.deferUpdate();
      return await proposeRestore(i, nodeOrDefault(), arg, "main", i.values);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (i.deferred || i.replied) await i.editReply({ content: `❌ ${msg}`, embeds: [], components: [] });
    else await i.reply({ content: `❌ ${msg}`, ...EPH });
  }
}

/** Buttons whose customId carries a payload instead of a pending token. */
export async function handleWpRestoreAll(i: ButtonInteraction): Promise<void> {
  if (!can(i, "restore")) return denied(i, "restore");
  await i.deferUpdate();
  const set = i.customId.slice("wp:restore_all:".length);
  await proposeRestore(i, nodeOrDefault(), set, "main", undefined);
}

async function confirmAction(i: ButtonInteraction, token: string): Promise<void> {
  const p = pending.get(token);
  if (!p || p.expires < Date.now()) {
    await i.update({ content: "This confirmation expired. Start again.", embeds: [], components: [] });
    return;
  }
  if (p.userId !== i.user.id) {
    await i.reply({ content: "Only the person who started this action can confirm it.", ...EPH });
    return;
  }
  const capNeeded: Capability = p.kind === "failover" || p.kind === "rollback" ? "failover" : p.kind === "restore" ? "restore" : "backup";
  if (!can(i, capNeeded)) return denied(i, capNeeded);
  pending.delete(token);
  await i.deferUpdate();
  const c = client(p.node);
  const actor = actorOf(i);
  let text: string;
  if (p.kind === "failover") {
    const r = await c.apply(p.sel, actor);
    text = r.job ? `🚑 Failover started on **${p.node}** (job \`${r.job}\`): ${r.plan.summary.switch} domain(s) → ${r.plan.to}. You'll get a notification when it completes; the status board shows the failover banner.` : `Nothing to switch: ${r.message ?? ""}`;
  } else if (p.kind === "rollback") {
    const r = await c.rollback(p.sel, actor);
    text = `↩️ Rollback started on **${p.node}** (job \`${r.job}\`).`;
  } else if (p.kind === "restore") {
    const r = await c.restore({ set: p.sel.set!, stack: p.sel.stack ?? "main", sites: p.sel.sites, all: p.sel.all }, actor);
    text = `🧩 Restore of \`${p.sel.set}\` started on **${p.node}** (job \`${r.job}\`). This can take a while; you'll be notified.`;
  } else {
    const r = await c.pull(p.sel.source!, p.sel.label ?? `manual by ${i.user.username}`, actor);
    text = `⬇️ Pull from **${p.sel.source}** started on **${p.node}** (job \`${r.job}\`).`;
  }
  await i.editReply({ content: text, embeds: [], components: [] });
  setTimeout(() => { void wpops.poll(); }, 5_000);
}

export function wpUserCapabilities(guildId: string, userId: string, roleIds: string[]): Capability[] {
  return [...capabilitiesOf(guildId, userId, roleIds)];
}

export { memberRoleIds };
