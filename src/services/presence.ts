/**
 * Bot presence - shows "Watching X/Y services up" in the Discord member list.
 * Updates on every heartbeat (debounced).
 */

import { ActivityType, Client } from "discord.js";
import { logger } from "../util/logger.js";
import { kuma, MonitorStatus } from "./kuma.js";

let updateTimer: ReturnType<typeof setTimeout> | null = null;

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
}

function updatePresence(client: Client): void {
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
