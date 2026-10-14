/**
 * wpops - client for the WordPress node agents (WPMultisiteDocker
 * scripts/wpops): failover, backup pulls, restores, jobs and events.
 *
 * Nodes are configured at runtime (`/wp node add <name> <url> <token>`) and
 * stored encrypted in data/bot.db under WPOPS_NODES, or seeded from the
 * environment: WPOPS_NODES="node1=https://ops.example.com" plus
 * WPOPS_TOKEN_WEB02. The DB wins when both exist.
 *
 * A poller refreshes every node's status (active overrides, jobs, tunnels,
 * latest backups) and tails its event log; new events are emitted so the
 * alert pipeline can post to Discord and e-mail (backup pulled, backup
 * failed, restore applied, failover applied / rolled back).
 */

import { EventEmitter } from "node:events";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { siteguard } from "./siteguard.js";

export interface WpNode {
  name: string;
  url: string;      // agent base URL (https://ops.<standby-domain> or http://10.x:8787)
  token: string;
}

export interface WpSite {
  slug: string;
  name: string;
  primary: string;
  cf_account: string;
  domains: string[];
  hosts: Record<string, { host: string; stack?: string; blog_id?: number }>;
  failover_to?: string;
  enabled: boolean;
}

export interface WpOverride {
  site: string;
  from: string;
  to: string;
  stack: string;
  status: string;
  switched_at: number;
  actor?: string;
  error?: string;
}

export interface WpNodeStatus {
  node: string;
  version: string;
  time: number;
  stacks: Record<string, { mode: string; healthy: boolean; containers: unknown[] }>;
  overrides: Record<string, WpOverride>;
  override_count: number;
  tunnels: { account: string; tunnel: string | null; ready: boolean }[];
  backups: {
    sets: number;
    latest: Record<string, { id: string; set: string; size: number; sites: number; pulled_at: number; label: string }>;
    schedule: { schedule: string; retain_sets: number; sources: string[]; next_run: number | null; last_run: number | null };
    disk: { total: number; used: number; free: number };
  };
  jobs: { active: WpJob[]; recent: WpJob[] };
  sites: number;
}

export interface WpJob {
  id: string;
  kind: string;
  status: string;
  actor: string;
  created: number;
  started: number | null;
  finished: number | null;
  progress: Record<string, unknown>;
  result: unknown;
  error: string;
  terminal: boolean;
  params: Record<string, unknown>;
}

export interface WpEvent {
  ts: number;
  kind: string;
  subject?: string;
  [k: string]: unknown;
}

export interface WpPlan {
  to: string;
  changes: { site: string; domain: string; from_origin: string; to_origin: string; stack: string }[];
  refused: { site: string; domain: string; reason: string }[];
  noop: { site: string; domain: string; reason: string }[];
  summary: { switch: number; refused: number; noop: number };
}

export interface WpBackupSet {
  id: string; source: string; set: string; nonce: string; timestamp: number; label: string; size: number;
  files: number; complete: boolean; keep: boolean; pulled_at: number | null; sites: number; mode: string;
  applied: { at: number; node: string; stack: string; sites: unknown; actor: string }[];
}

const NODES_KEY = "WPOPS_NODES";
const EVENT_CURSOR_KEY = "WPOPS_EVENT_CURSOR";

export class WpopsError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

// ------------------------------------------------------------------ nodes

function nodesFromEnv(): WpNode[] {
  const spec = process.env.WPOPS_NODES ?? "";
  const out: WpNode[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, url] = part.split("=", 2);
    if (!name || !url) continue;
    const token = process.env[`WPOPS_TOKEN_${name.toUpperCase().replace(/-/g, "_")}`] ?? "";
    if (token) out.push({ name: name.trim(), url: url.trim().replace(/\/$/, ""), token });
  }
  return out;
}

export function getNodes(): WpNode[] {
  const raw = getSetting(NODES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WpNode[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* fall through to env */ }
  }
  return nodesFromEnv();
}

export function saveNodes(nodes: WpNode[]): void {
  setSetting(NODES_KEY, JSON.stringify(nodes));
}

export function getNode(name: string): WpNode {
  const n = getNodes().find((x) => x.name === name);
  if (!n) throw new WpopsError(`unknown node '${name}'`);
  return n;
}

// ----------------------------------------------------------------- client

export class WpopsClient {
  constructor(private node: WpNode) {}

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, actor = "bot", timeoutMs = 30_000): Promise<T> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.node.url + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.node.token}`,
          "Content-Type": "application/json",
          "X-Actor": actor.slice(0, 80).replace(/[^A-Za-z0-9 _.@#:/-]/g, "_"),
          "User-Agent": "UptimeKuma-Discord-Bot/wpops",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
      if (!res.ok) {
        const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        throw new WpopsError(`${this.node.name}: ${msg}`, res.status);
      }
      return data as T;
    } catch (err) {
      if (err instanceof WpopsError) throw err;
      const msg = err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message) : String(err);
      throw new WpopsError(`${this.node.name}: ${msg}`);
    } finally {
      clearTimeout(t);
    }
  }

  health() { return this.req<{ ok: boolean; version: string; node: string }>("GET", "/healthz"); }
  status(live = false) { return this.req<WpNodeStatus>("GET", `/v1/status${live ? "?live=1" : ""}`, undefined, "bot", 60_000); }
  inventory() { return this.req<{ origins: Record<string, unknown>; sites: WpSite[] }>("GET", "/v1/inventory"); }
  sitesLive() { return this.req<{ sites: { site: string; domain: string; current: string; ok: boolean; override?: string; error?: string }[] }>("GET", "/v1/sites?live=1", undefined, "bot", 90_000); }
  overrides() { return this.req<{ overrides: Record<string, WpOverride> }>("GET", "/v1/overrides"); }
  plan(sel: Selection, actor: string) { return this.req<WpPlan>("POST", "/v1/failover/plan", sel, actor, 90_000); }
  apply(sel: Selection, actor: string) { return this.req<{ job: string | null; plan: WpPlan; message?: string }>("POST", "/v1/failover/apply", sel, actor, 90_000); }
  rollback(sel: Selection, actor: string) { return this.req<{ job: string }>("POST", "/v1/failover/rollback", sel, actor, 60_000); }
  backups(source?: string) { return this.req<{ sets: WpBackupSet[] }>("GET", `/v1/backups${source ? `?source=${encodeURIComponent(source)}` : ""}`); }
  schedule() { return this.req<WpNodeStatus["backups"]["schedule"] & { last_result?: unknown }>("GET", "/v1/backups/schedule"); }
  setSchedule(body: { schedule?: string; retain?: number; sources?: string[] }, actor: string) {
    return this.req<WpNodeStatus["backups"]["schedule"]>("POST", "/v1/backups/schedule", body, actor);
  }
  pull(source: string, label: string, actor: string) { return this.req<{ job: string }>("POST", "/v1/backups/pull", { source, label }, actor); }
  keep(set: string, keep: boolean, actor: string) { return this.req<unknown>("POST", "/v1/backups/keep", { set, keep }, actor); }
  deleteSet(set: string, actor: string) { return this.req<unknown>("POST", "/v1/backups/delete", { set }, actor); }
  restore(body: { set: string; stack: string; sites?: string[]; all?: boolean; entities?: string[] }, actor: string) {
    return this.req<{ job: string }>("POST", "/v1/restore/apply", body, actor);
  }
  jobs(limit = 20) { return this.req<{ jobs: WpJob[] }>("GET", `/v1/jobs?limit=${limit}`); }
  job(id: string) { return this.req<WpJob>("GET", `/v1/jobs/${encodeURIComponent(id)}`); }
  jobLog(id: string, lines = 40) { return this.req<{ log: string }>("GET", `/v1/jobs/${encodeURIComponent(id)}/log?lines=${lines}`); }
  events(since: number) { return this.req<{ events: WpEvent[] }>("GET", `/v1/events?since=${since}&limit=100`); }
  notifyTest(actor: string) { return this.req<unknown>("POST", "/v1/notify/test", {}, actor); }
}

export interface Selection {
  sites?: string[];
  all?: boolean;
  to?: string;
  stack?: string;
  domains?: string[];
}

// ----------------------------------------------------------------- poller

export interface NodeSnapshot {
  node: WpNode;
  status: WpNodeStatus | null;
  inventory: WpSite[];
  error: string;
  updatedAt: number;
}

class WpopsService extends EventEmitter {
  snapshots = new Map<string, NodeSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private jobWatch = new Map<string, { node: string; notified: boolean }>();

  get configured(): boolean { return getNodes().length > 0; }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.poll().catch((err) => logger.warn({ err }, "wpops initial poll failed"));
    this.timer = setInterval(() => {
      this.poll().catch((err) => logger.warn({ err }, "wpops poll failed"));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  client(nodeName: string): WpopsClient { return new WpopsClient(getNode(nodeName)); }

  /** First node, for single-standby estates. */
  defaultNode(): WpNode | null { return getNodes()[0] ?? null; }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const nodes = getNodes();
      for (const node of nodes) {
        const c = new WpopsClient(node);
        const prev = this.snapshots.get(node.name);
        try {
          const status = await c.status();
          let inventory = prev?.inventory ?? [];
          if (!prev || !prev.inventory.length || Date.now() - prev.updatedAt > 10 * 60_000) {
            inventory = (await c.inventory()).sites;
          }
          const snap: NodeSnapshot = { node, status, inventory, error: "", updatedAt: Date.now() };
          this.snapshots.set(node.name, snap);
          if (prev?.error) this.emit("nodeReachable", node.name);
          await this.drainEvents(node, c);
          this.watchJobs(node, status);
          this.detectOverrideChanges(prev, snap);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const wasOk = prev && !prev.error;
          this.snapshots.set(node.name, { node, status: prev?.status ?? null, inventory: prev?.inventory ?? [], error: msg, updatedAt: prev?.updatedAt ?? 0 });
          if (wasOk || !prev) this.emit("nodeUnreachable", node.name, msg);
        }
      }
      for (const name of [...this.snapshots.keys()]) if (!nodes.find((n) => n.name === name)) this.snapshots.delete(name);
      this.emit("updated");
    } finally {
      this.polling = false;
    }
  }

  private async drainEvents(node: WpNode, c: WpopsClient): Promise<void> {
    const key = `${EVENT_CURSOR_KEY}_${node.name}`;
    const since = Number(getSetting(key) ?? 0) || 0;
    const { events } = await c.events(since);
    let cursor = since;
    for (const ev of events) {
      if (ev.ts <= since) continue;
      cursor = Math.max(cursor, ev.ts);
      if (since === 0) continue;               // first run: do not replay history
      this.emit("event", node.name, ev);
    }
    if (cursor !== since) setSetting(key, String(cursor));
  }

  private watchJobs(node: WpNode, status: WpNodeStatus): void {
    for (const j of status.jobs.active) this.jobWatch.set(j.id, { node: node.name, notified: false });
    for (const j of status.jobs.recent) {
      const w = this.jobWatch.get(j.id);
      if (w && j.terminal && !w.notified) {
        w.notified = true;
        this.emit("jobFinished", node.name, j);
      }
    }
  }

  private detectOverrideChanges(prev: NodeSnapshot | undefined, cur: NodeSnapshot): void {
    const before = Object.keys(prev?.status?.overrides ?? {}).length;
    const after = Object.keys(cur.status?.overrides ?? {}).length;
    if (prev && before !== after) this.emit("overridesChanged", cur.node.name, before, after);
  }

  // ------------------------------------------------------------- queries
  /** Every active override across nodes: domain -> override (+node). */
  activeOverrides(): { node: string; domain: string; override: WpOverride }[] {
    const out: { node: string; domain: string; override: WpOverride }[] = [];
    for (const snap of this.snapshots.values()) {
      for (const [domain, ov] of Object.entries(snap.status?.overrides ?? {})) {
        if (ov.status !== "rolled-back") out.push({ node: snap.node.name, domain, override: ov });
      }
    }
    return out;
  }

  /** Inventory union across nodes (slug -> site). */
  sites(): Map<string, WpSite> {
    const m = new Map<string, WpSite>();
    for (const snap of this.snapshots.values()) for (const s of snap.inventory) if (!m.has(s.slug)) m.set(s.slug, s);
    return m;
  }

  siteForDomain(domain: string): WpSite | null {
    const d = domain.toLowerCase().replace(/^www\./, "");
    for (const s of this.sites().values()) {
      if (s.domains.some((x) => x === domain.toLowerCase() || x.replace(/^www\./, "") === d)) return s;
      for (const h of Object.values(s.hosts)) if (h.host?.toLowerCase() === domain.toLowerCase()) return s;
    }
    return null;
  }

  /** Is this site currently served by a failover node (any of its domains overridden)? */
  isSiteInFailover(slugOrDomain: string): boolean {
    const site = this.sites().get(slugOrDomain) ?? this.siteForDomain(slugOrDomain);
    if (!site) return false;
    return this.activeOverrides().some((o) => o.override.site === site.slug && o.override.status === "active");
  }

  /** Slugs of inventory sites the bot currently considers down (SiteGuard status or direct probe). */
  downSiteSlugs(): { slug: string; reason: string }[] {
    const out = new Map<string, string>();
    const sgSites = siteguard.data?.sites ?? [];
    const directDown = new Set(siteguard.getDirectDownSites().map((s) => s.site_id));
    for (const s of sgSites) {
      const down = s.status === "down" || directDown.has(s.site_id);
      if (!down) continue;
      const site = this.siteForDomain(s.domain);
      if (site && !out.has(site.slug)) out.set(site.slug, s.error || `HTTP ${s.http_code}`);
    }
    return [...out.entries()].map(([slug, reason]) => ({ slug, reason }));
  }

  summary(): { nodes: number; reachable: number; overrides: number; tunnelsReady: number; tunnels: number; latestBackup: number | null } {
    let reachable = 0, overrides = 0, tunnelsReady = 0, tunnels = 0, latest: number | null = null;
    for (const snap of this.snapshots.values()) {
      if (!snap.error && snap.status) reachable++;
      overrides += snap.status?.override_count ?? 0;
      for (const t of snap.status?.tunnels ?? []) { tunnels++; if (t.ready) tunnelsReady++; }
      for (const b of Object.values(snap.status?.backups.latest ?? {})) if (b.pulled_at && (!latest || b.pulled_at > latest)) latest = b.pulled_at;
    }
    return { nodes: this.snapshots.size, reachable, overrides, tunnelsReady, tunnels, latestBackup: latest };
  }
}

export const wpops = new WpopsService();

export function fmtBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GiB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
