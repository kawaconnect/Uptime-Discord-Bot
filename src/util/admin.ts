import { env } from "./env.js";

/**
 * Whether a Discord user may run admin commands (/setup, /sg-setup,
 * /sg-pause, /pause, /resume, /phone toggle).
 *
 * Only user IDs listed in ADMIN_USER_IDS are admins. An empty list means
 * nobody is: the commands answer "Admins only." instead of opening up to
 * every member who can see them.
 */
export function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length > 0 && ids.includes(userId);
}

export const ADMINS_ONLY = "Admins only.";
