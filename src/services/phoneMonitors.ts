import { MonitorStatus, type KumaMonitor } from "./kuma.js";

/** Missing snapshot data is not evidence that an outage recovered. */
export function planPhoneEscalation(
  monitors: ReadonlyMap<number, KumaMonitor>,
  statuses: ReadonlyMap<number, number>,
  tracked: readonly string[],
  isPaused: (id: number) => boolean,
): { report: KumaMonitor[]; resolve: string[] } {
  const report: KumaMonitor[] = [];
  const resolve: string[] = [];
  const trackedSet = new Set(tracked);
  for (const [id, monitor] of monitors) {
    // Groups reflect their children and must not create a second incident.
    if (monitor.type === "group") continue;
    const status = statuses.get(id);
    const key = `kuma:monitor:${id}`;
    if (isPaused(id) || status === MonitorStatus.MAINTENANCE || status === MonitorStatus.UP) {
      if (trackedSet.has(key)) resolve.push(key);
    } else if (status === MonitorStatus.DOWN) {
      report.push(monitor);
    }
  }
  // A monitor deleted from Kuma can never report UP again: resolve its
  // escalation instead of letting the PBX keep calling about it. Only with a
  // monitor list in hand; an empty map means no snapshot yet, not "deleted".
  if (monitors.size > 0) {
    for (const key of trackedSet) {
      const m = /^kuma:monitor:(\d+)$/.exec(key);
      if (m && !monitors.has(Number(m[1])) && !resolve.includes(key)) resolve.push(key);
    }
  }
  return { report, resolve };
}
