/**
 * Phone escalation - asks the PBX to call a human when something is still down.
 *
 * The bot does not decide when a call is due. It reports, on every tick, that
 * a condition has been active since a given time; the PBX connector applies
 * the delay and quiet-hours policy and drives the escalation chain (primary
 * number, then the backup number if nobody acknowledges). Keeping the policy
 * in one place means the same rules apply to alerts raised from anywhere.
 */

import { logger } from "../util/logger.js";
import { getSettingOrEnv } from "../db/index.js";

/** Conditions currently down, and when we first saw them go down. */
const activeSince = new Map<string, number>();

function config(): { url: string; token: string } | null {
  const url = (getSettingOrEnv("PBX_ALERT_URL") || "").trim().replace(/\/$/, "");
  const token = (getSettingOrEnv("PBX_ALERT_TOKEN") || "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/** Whether phone escalation is switched on. Default: off. */
export function isPhoneEscalationEnabled(): boolean {
  return getSettingOrEnv("PHONE_ESCALATION_ENABLED") === "true" && config() !== null;
}

/** Records that a condition is down, keeping the original start time. */
export function markDown(key: string): number {
  const existing = activeSince.get(key);
  if (existing) return existing;
  const now = Date.now();
  activeSince.set(key, now);
  return now;
}

/** Clears a condition and tells the PBX to drop its cooldown bookkeeping. */
export async function markUp(key: string): Promise<void> {
  if (!activeSince.delete(key)) return;
  const cfg = config();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.debug({ err, key }, "Failed to clear PBX alert state");
  }
}

/** Drops any tracked condition whose key is no longer relevant. */
export function trackedKeys(): string[] {
  return [...activeSince.keys()];
}

/**
 * Reports an active condition to the PBX. Safe to call every tick: the PBX
 * answers "too soon", "cooldown" or "deferred" until a call is actually due.
 */
export async function reportActive(
  key: string,
  message: string,
  policy: "uptime" | "escalation" = "uptime",
): Promise<void> {
  if (!isPhoneEscalationEnabled()) return;
  const cfg = config();
  if (!cfg) return;

  const since = activeSince.get(key) ?? markDown(key);

  try {
    const res = await fetch(`${cfg.url}/alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        key,
        message,
        policy,
        source: "uptime-kuma",
        since: new Date(since).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      logger.warn({ key, status: res.status }, "PBX rejected the alert");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      called?: boolean;
      reason?: string;
    };
    if (body.called) {
      logger.info({ key }, "PBX is placing an alert call");
    } else {
      logger.debug({ key, reason: body.reason }, "PBX did not call yet");
    }
  } catch (err) {
    logger.error({ err, key }, "Failed to reach the PBX for phone escalation");
  }
}
