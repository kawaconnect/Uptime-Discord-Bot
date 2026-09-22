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
import { getSettingOrEnv, setSetting } from "../db/index.js";

/** Conditions currently down, and when we first saw them go down. */
const activeSince = new Map<string, number>();

/** What the PBX tells us once somebody pressed 1 for an alert. */
export interface PhoneAck {
  key: string;
  /** e.g. "mobile (15555550100)" */
  by: string;
  /** epoch seconds */
  at: number;
  callId?: string;
}

type AckHandler = (ack: PhoneAck) => Promise<void>;
const ackHandlers: AckHandler[] = [];
/** Keys whose acknowledgement has already been acted on this outage. */
const ackHandled = new Set<string>();

/**
 * Registers a callback for the moment an alert is acknowledged by phone.
 * Fires once per outage per key; a recovery (markUp) re-arms it.
 */
export function onPhoneAcknowledged(handler: AckHandler): void {
  ackHandlers.push(handler);
}

function config(): { url: string; token: string } | null {
  const url = (getSettingOrEnv("PBX_ALERT_URL") || "").trim().replace(/\/$/, "");
  const token = (getSettingOrEnv("PBX_ALERT_TOKEN") || "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Which conditions are allowed to ring a phone.
 *
 * Each is a separate toggle so a noisy category can be silenced without
 * losing the rest. Everything defaults to on: a phone call is the last line
 * of defence, and silently not calling is the worst failure this system has.
 * Stored in the settings table so /phone can change them at runtime.
 */
export const CALL_KINDS = {
  "kuma-down": "Uptime Kuma monitor down",
  "sg-site-down": "SiteGuard: website down",
  "sg-unreachable": "SiteGuard: health endpoint unreachable",
  "sg-data-stale": "SiteGuard: monitoring data has gone stale",
  "sg-ssl": "SiteGuard: SSL certificate expiring",
} as const;

export type CallKind = keyof typeof CALL_KINDS;

function settingKey(kind: CallKind): string {
  return `PHONE_CALL_${kind.toUpperCase().replace(/-/g, "_")}`;
}

/** True unless explicitly disabled. */
export function isCallEnabledFor(kind: CallKind): boolean {
  return getSettingOrEnv(settingKey(kind)) !== "false";
}

export function setCallEnabledFor(kind: CallKind, enabled: boolean): void {
  setSetting(settingKey(kind), enabled ? "true" : "false");
}

export function callKindStates(): Array<{ kind: CallKind; label: string; enabled: boolean }> {
  return (Object.keys(CALL_KINDS) as CallKind[]).map((kind) => ({
    kind,
    label: CALL_KINDS[kind],
    enabled: isCallEnabledFor(kind),
  }));
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
  ackHandled.delete(key);
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

/** When a condition was first seen down, if it is currently tracked. */
export function downSince(key: string): number | undefined {
  return activeSince.get(key);
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
  kind: CallKind = "kuma-down",
): Promise<void> {
  if (!isPhoneEscalationEnabled()) return;
  if (!isCallEnabledFor(kind)) return;
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
      acknowledged_by?: string | null;
      acknowledged_at?: number | null;
      call_id?: string | null;
    };
    if (body.called) {
      logger.info({ key }, "PBX is placing an alert call");
    } else if (body.reason === "acknowledged") {
      if (!ackHandled.has(key)) {
        ackHandled.add(key);
        const ack: PhoneAck = {
          key,
          by: body.acknowledged_by || "phone",
          at: Number(body.acknowledged_at) || Math.floor(Date.now() / 1000),
          callId: body.call_id || undefined,
        };
        logger.info({ key, by: ack.by }, "Alert acknowledged by phone");
        for (const handler of ackHandlers) {
          handler(ack).catch((err) => logger.error({ err, key }, "Phone acknowledgement handler failed"));
        }
      }
    } else {
      logger.debug({ key, reason: body.reason }, "PBX did not call yet");
    }
  } catch (err) {
    logger.error({ err, key }, "Failed to reach the PBX for phone escalation");
  }
}
