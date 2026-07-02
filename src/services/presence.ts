/**
 * Bot presence - shows combined Kuma + SiteGuard status in the Discord member list.
 * e.g. "Watching 25/28 services up" or "3 DOWN | 25/28 up"
 *
 * Updates on heartbeats (debounced) and SiteGuard data updates.
 */

import { ActivityType, Client } from "discord.js";
import { logger } from "../util/logger.js";
import { kuma } from "./kuma.js";
import { siteguard } from "./siteguard.js";

let updateTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Guard against double-registration of listeners and the refresh timer. */
let presenceStarted = false;

export function startPresence(client: Client): void {
  if (presenceStarted) {
    logger.debug("Presence already started - skipping duplicate registration");
    return;
  }
  presenceStarted = true;

  // Set initial presence
  updatePresence(client);

  // Update on Kuma heartbeats (debounced)
  kuma.on("heartbeat", () => {
    scheduleUpdate(client);
  });

  kuma.on("monitorListUpdated", () => {
    updatePresence(client);
  });

  // Show disconnected state
  kuma.on("disconnected", () => {
    updatePresence(client);
  });

  kuma.on("connected", () => {
    updatePresence(client);
  });

  // Show stale data state immediately
  kuma.on("dataStale", () => {
    updatePresence(client);
  });

  // Restore presence when data recovers
  kuma.on("dataFresh", () => {
    updatePresence(client);
  });

  // SiteGuard updates trigger presence refresh too
  siteguard.on("updated", () => {
    scheduleUpdate(client);
  });

  siteguard.on("unreachable", () => {
    updatePresence(client);
  });

  siteguard.on("reachable", () => {
    updatePresence(client);
  });

  // Periodic presence refresh every 60s
  refreshTimer = setInterval(() => {
    updatePresence(client);
  }, 60_000);
}

export function stopPresence(): void {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  presenceStarted = false;
}

function scheduleUpdate(client: Client): void {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    updatePresence(client);
  }, 5_000);
}

function updatePresence(client: Client): void {
  // If Kuma data is stale, show degraded state
  if (kuma.dataStale) {
    const staleSec = kuma.dataStalenessSeconds;
    const staleStr = staleSec > 120
      ? `${Math.floor(staleSec / 60)}m stale`
      : `${staleSec}s stale`;

    client.user?.setPresence({
      status: "dnd",
      activities: [{
        name: `DATA STALE (${staleStr}) - reconnecting`,
        type: ActivityType.Watching,
      }],
    });
    return;
  }

  // Combine Kuma + SiteGuard summaries
  const kumaSummary = kuma.connected ? kuma.getSummary() : null;
  const sgSummary = siteguard.data ? siteguard.getSummary() : null;

  // If neither is available
  if (!kumaSummary && !sgSummary) {
    if (!kuma.connected) {
      client.user?.setPresence({
        status: "dnd",
        activities: [{
          name: "DISCONNECTED from Uptime Kuma",
          type: ActivityType.Watching,
        }],
      });
    }
    return;
  }

  const kumaUp = kumaSummary?.up ?? 0;
  const kumaActive = kumaSummary ? kumaSummary.total - kumaSummary.paused : 0;
  const kumaDown = kumaSummary?.down ?? 0;
  const sgUp = sgSummary?.operational ?? 0;
  const sgActive = sgSummary?.total ?? 0;
  const sgDown = sgSummary?.down ?? 0;

  const totalUp = kumaUp + sgUp;
  const totalActive = kumaActive + sgActive;
  const totalDown = kumaDown + sgDown;

  let status: "online" | "idle" | "dnd" = "online";
  if (totalDown > 0 || (!siteguard.reachable && siteguard.isConfigured)) status = "dnd";
  else if ((kumaSummary?.pending ?? 0) > 0 || (sgSummary?.degraded ?? 0) > 0) status = "idle";

  const text = totalDown > 0
    ? `${totalDown} DOWN | ${totalUp}/${totalActive} up`
    : `${totalUp}/${totalActive} services up`;

  try {
    client.user?.setPresence({
      status,
      activities: [{
        name: text,
        type: ActivityType.Watching,
      }],
    });
  } catch (err) {
    logger.debug({ err }, "Failed to update presence");
  }
}
