/**
 * Starting and ending the global maintenance window (see maintenance.ts for
 * the store and the gate), and the sweep that ends it on time.
 *
 * Ending, on schedule or with /maintenance end, is always the same:
 *   1. close the window (alerts flow again from this moment);
 *   2. reset phone escalation, so a condition that is still down escalates
 *      with the PBX's normal delay counted from now, not from the middle of
 *      the window;
 *   3. post one summary to the alert channel (who, why, when it ended, how
 *      many alerts were held back, what is still down);
 *   4. send the normal down alert for every Kuma monitor and SiteGuard site
 *      still down whose outage was never announced.
 */

import type { Client } from "discord.js";
import { logger } from "../util/logger.js";
import { NO_MENTIONS } from "../util/mentions.js";
import { discordQueue } from "../queue/index.js";
import { kuma } from "./kuma.js";
import { markUp, trackedKeys } from "./phone.js";
import { alertableDownMonitors, realertKumaAfterMaintenance } from "./alerts.js";
import { alertableDownSites, realertSgAfterMaintenance } from "./sgAlerts.js";
import {
  getMaintenance,
  saveMaintenance,
  clearMaintenance,
  maintenanceStartEmbed,
  maintenanceEndEmbed,
  maintenanceChannel,
  type MaintenanceWindow,
} from "./maintenance.js";

export interface StartRequest {
  durationMs: number;
  reason: string | null;
  userId: string;
  userTag: string;
  channelId: string | null;
  now?: number;
}

/** Stop every escalation in progress (each key is re-reported once alerts are allowed again). */
async function resetPhoneEscalations(): Promise<void> {
  for (const key of trackedKeys()) await markUp(key).catch(() => undefined);
}

/**
 * Open a window, or change the end time (and reason, when given) of the open
 * one. Posts the notice to the alert channel; returns the window and whether
 * the notice could be posted there.
 */
export async function startMaintenance(
  client: Client,
  req: StartRequest,
): Promise<{ window: MaintenanceWindow; updated: boolean; posted: boolean }> {
  const now = req.now ?? Date.now();
  const existing = getMaintenance();
  const open = existing && existing.endsAt > now ? existing : null;
  const window: MaintenanceWindow = open
    ? { ...open, endsAt: now + req.durationMs, reason: req.reason ?? open.reason }
    : {
        startedBy: req.userTag,
        startedById: req.userId,
        reason: req.reason,
        startedAt: now,
        endsAt: now + req.durationMs,
        channelId: req.channelId,
        suppressed: 0,
        suppressedKinds: {},
      };
  saveMaintenance(window);
  if (!open) await resetPhoneEscalations();
  logger.warn(
    { by: req.userTag, endsAt: new Date(window.endsAt).toISOString(), reason: window.reason ?? undefined, updated: !!open },
    open ? "Maintenance window updated" : "Maintenance window started: alerts and calls suppressed",
  );

  const posted = await postToAlertChannel(client, maintenanceStartEmbed(window, { updated: !!open, userId: req.userId }));
  return { window, updated: !!open, posted };
}

async function postToAlertChannel(client: Client, embed: ReturnType<typeof maintenanceStartEmbed>): Promise<boolean> {
  const ch = await maintenanceChannel(client);
  if (!ch) {
    logger.error("No alert channel configured: maintenance notice not posted (run /setup alerts #channel)");
    return false;
  }
  try {
    await discordQueue.add(async () => { await ch.send({ embeds: [embed], allowedMentions: NO_MENTIONS }); });
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to post the maintenance notice");
    return false;
  }
}

export interface EndOutcome {
  window: MaintenanceWindow;
  stillDown: string[];
  realerted: number;
  posted: boolean;
}

/**
 * End the open window (manual when userId is given, otherwise on schedule).
 * Returns null when no window was open.
 */
export async function endMaintenance(
  client: Client,
  opts: { userId?: string; now?: number } = {},
): Promise<EndOutcome | null> {
  const now = opts.now ?? Date.now();
  const window = clearMaintenance();
  if (!window) return null;
  await resetPhoneEscalations();

  const stillDown = [
    ...(kuma.connected ? alertableDownMonitors().map((m) => m.name) : ["Uptime Kuma (disconnected)"]),
    ...alertableDownSites(),
  ];
  logger.warn(
    { auto: !opts.userId, suppressed: window.suppressed, kinds: window.suppressedKinds, stillDown: stillDown.length },
    "Maintenance window ended: alerts and calls active again",
  );

  const posted = await postToAlertChannel(
    client,
    maintenanceEndEmbed(window, { auto: !opts.userId, userId: opts.userId, now, stillDown }),
  );

  let realerted = 0;
  realerted += await realertKumaAfterMaintenance(client).catch((err) => {
    logger.error({ err }, "Re-alerting Kuma monitors after maintenance failed");
    return 0;
  });
  realerted += await realertSgAfterMaintenance(client).catch((err) => {
    logger.error({ err }, "Re-alerting SiteGuard sites after maintenance failed");
    return 0;
  });
  return { window, stillDown, realerted, posted };
}

// ---------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------

const SWEEP_MS = 15_000;
/** After a restart, how long a due window waits for Uptime Kuma before ending anyway. */
const KUMA_WAIT_MS = 2 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let schedulerStartedAt = 0;

/**
 * End the window if its time has come. Right after a restart it waits (up to
 * two minutes) for Uptime Kuma to connect, so monitors still down can be
 * re-alerted from current data. Returns true when a window was ended.
 */
export async function runMaintenanceSweep(client: Client, now = Date.now()): Promise<boolean> {
  if (sweeping) return false;
  const w = getMaintenance();
  if (!w || w.endsAt > now) return false;
  if (!kuma.connected && schedulerStartedAt > 0 && now - schedulerStartedAt < KUMA_WAIT_MS) return false;
  sweeping = true;
  try {
    return (await endMaintenance(client, { now })) !== null;
  } finally {
    sweeping = false;
  }
}

/** Start the expiry sweep (every 15 s, and shortly after each Kuma connect). */
export function startMaintenanceScheduler(client: Client): void {
  if (sweepTimer) return;
  schedulerStartedAt = Date.now();
  const tick = () => {
    runMaintenanceSweep(client).catch((err) => logger.error({ err }, "Maintenance sweep failed"));
  };
  sweepTimer = setInterval(tick, SWEEP_MS);
  kuma.on("connected", () => setTimeout(tick, 5_000));
  const w = getMaintenance();
  if (w) logger.warn({ endsAt: new Date(w.endsAt).toISOString(), reason: w.reason ?? undefined, suppressed: w.suppressed }, "Maintenance window loaded: alerts and calls suppressed until it ends");
}

export function stopMaintenanceScheduler(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
