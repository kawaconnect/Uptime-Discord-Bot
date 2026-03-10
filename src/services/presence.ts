/**
 * Bot presence - shows "Watching X/Y services up" in the Discord member list.
 * Updates on every heartbeat (debounced), and reflects degraded/stale states.
 */

import { ActivityType, Client } from "discord.js";
import { logger } from "../util/logger.js";
import { kuma, MonitorStatus } from "./kuma.js";

let updateTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startPresence(client: Client): void {
  // Set initial presence
  updatePresence(client);

  // Update on heartbeats (debounced)
  kuma.on("heartbeat", () => {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updatePresence(client);
    }, 5_000);
  });

  kuma.on("monitorListUpdated", () => {
    updatePresence(client);
  });

  // Show disconnected state
  kuma.on("disconnected", () => {
    client.user?.setPresence({
      status: "dnd",
      activities: [{
        name: "DISCONNECTED from Uptime Kuma",
        type: ActivityType.Watching,
      }],
    });
  });

  kuma.on("connected", () => {
    updatePresence(client);
  });

  // Show stale data state immediately
  kuma.on("dataStale", () => {
    client.user?.setPresence({
      status: "dnd",
      activities: [{
        name: "DATA STALE - reconnecting to Kuma",
        type: ActivityType.Watching,
      }],
    });
  });

  // Restore presence when data recovers
  kuma.on("dataFresh", () => {
    updatePresence(client);
  });

  // Periodic presence refresh every 60s - ensures presence reflects
  // stale state even if no events are firing
  refreshTimer = setInterval(() => {
    updatePresence(client);
  }, 60_000);
}

export function stopPresence(): void {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function updatePresence(client: Client): void {
  // If data is stale, show degraded state
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

  if (!kuma.connected) return;

  const summary = kuma.getSummary();
  const active = summary.total - summary.paused;

  let status: "online" | "idle" | "dnd" = "online";
  if (summary.down > 0) status = "dnd";
  else if (summary.pending > 0) status = "idle";

  const text = summary.down > 0
    ? `${summary.down} DOWN | ${summary.up}/${active} up`
    : `${summary.up}/${active} services up`;

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
