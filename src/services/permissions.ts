/**
 * Delegated permissions for the WordPress operations commands.
 *
 * Capabilities: view, failover, backup, restore, admin. ADMIN_USER_IDS always
 * hold every capability; everyone else needs a grant for their user id or for
 * a role they hold, per guild. Grants are stored in data/bot.db.
 */

import type { GuildMember, Interaction } from "discord.js";
import { database } from "../db/index.js";
import { env } from "../util/env.js";

export const CAPABILITIES = ["view", "failover", "backup", "restore", "admin"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Grant {
  guild_id: string;
  principal_type: "user" | "role";
  principal_id: string;
  capability: Capability;
  granted_by: string;
  granted_at: number;
}

let ready = false;

function ensure(): void {
  if (ready) return;
  database().exec(`
    CREATE TABLE IF NOT EXISTS wp_permissions (
      guild_id       TEXT NOT NULL,
      principal_type TEXT NOT NULL,
      principal_id   TEXT NOT NULL,
      capability     TEXT NOT NULL,
      granted_by     TEXT NOT NULL,
      granted_at     INTEGER NOT NULL,
      PRIMARY KEY (guild_id, principal_type, principal_id, capability)
    );
  `);
  ready = true;
}

export function isAdminUser(userId: string): boolean {
  return env().ADMIN_USER_IDS.includes(userId);
}

export function grant(g: Omit<Grant, "granted_at">): void {
  ensure();
  database()
    .prepare(`INSERT INTO wp_permissions (guild_id, principal_type, principal_id, capability, granted_by, granted_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(guild_id, principal_type, principal_id, capability) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
    .run(g.guild_id, g.principal_type, g.principal_id, g.capability, g.granted_by, Date.now());
}

export function revoke(guildId: string, principalType: "user" | "role", principalId: string, capability?: Capability): number {
  ensure();
  const r = capability
    ? database().prepare("DELETE FROM wp_permissions WHERE guild_id = ? AND principal_type = ? AND principal_id = ? AND capability = ?").run(guildId, principalType, principalId, capability)
    : database().prepare("DELETE FROM wp_permissions WHERE guild_id = ? AND principal_type = ? AND principal_id = ?").run(guildId, principalType, principalId);
  return r.changes;
}

export function listGrants(guildId: string): Grant[] {
  ensure();
  return database().prepare("SELECT * FROM wp_permissions WHERE guild_id = ? ORDER BY principal_type, principal_id, capability").all(guildId) as Grant[];
}

/** Capabilities a member holds (direct + role grants + admin). */
export function capabilitiesOf(guildId: string, userId: string, roleIds: string[]): Set<Capability> {
  ensure();
  const out = new Set<Capability>();
  if (isAdminUser(userId)) { for (const c of CAPABILITIES) out.add(c); return out; }
  const rows = database()
    .prepare(`SELECT capability FROM wp_permissions WHERE guild_id = ? AND (
                (principal_type = 'user' AND principal_id = ?) OR
                (principal_type = 'role' AND principal_id IN (${roleIds.map(() => "?").join(",") || "''"}))
              )`)
    .all(guildId, userId, ...roleIds) as { capability: Capability }[];
  for (const r of rows) out.add(r.capability);
  if (out.has("admin")) for (const c of CAPABILITIES) out.add(c);
  if (out.size > 0) out.add("view");
  return out;
}

export function memberRoleIds(interaction: Interaction): string[] {
  const member = interaction.member as GuildMember | null;
  const roles = member?.roles;
  if (!roles) return [];
  // GuildMember#roles is a manager in guild context; APIInteractionGuildMember carries an array.
  const cache = (roles as { cache?: Map<string, unknown> }).cache;
  if (cache) return [...cache.keys()];
  return Array.isArray(roles) ? (roles as string[]) : [];
}

export function can(interaction: Interaction, capability: Capability): boolean {
  if (!interaction.guildId) return isAdminUser(interaction.user.id);
  return capabilitiesOf(interaction.guildId, interaction.user.id, memberRoleIds(interaction)).has(capability);
}
