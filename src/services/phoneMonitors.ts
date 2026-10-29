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
  return { report, resolve };
}
