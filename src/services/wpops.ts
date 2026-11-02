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
 *
 * It also reads every node's site registry in SiteGuard's format
 * (GET /v1/siteguard/health, agents from WPMultisiteDocker 0.0.7) and hands
 * it to the SiteGuard monitor through nodeSites: each single-site stack and
 * multisite blog on the node becomes a monitored site, added and removed as
 * the node reports them ("sitesChanged"). Older agents answer 404 and keep
 * working as before.
 */

import { EventEmitter } from "node:events";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { siteguard } from "./siteguard.js";
import { nodeSites, type NodeSgPayload, type NodeSgSite } from "./nodeSites.js";

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
  /** Every watched filesystem on the node (backups/, each stack's data/). */
  disk?: { label: string; path: string; total: number; free: number; free_pct: number; low: boolean; min_free_gb: number; min_free_pct: number }[];
  backups: {
    sets: number;
    latest: Record<string, { id: string; set: string; size: number; sites: number; pulled_at: number; label: string }>;
    schedule: { schedule: string; retain_sets: number; sources: string[]; next_run: number | null; last_run: number | null };
    disk: { total: number; used: number; free: number };
  };
  jobs: { active: WpJob[]; recent: WpJob[] };
  sites: number;
  /** Agents with the site registry (WPMultisiteDocker 0.0.7+). */
  registry?: { revision: number; sites: number; status: Record<string, number>; health_updated: number | null };
}

/** One site of a node's registry (GET /v1/registry). */
export interface WpRegistrySite {
  uid: string;
  id: string;
  site_id: number;
  node: string;
  stack: string;
  mode: string;
  blog_id: number;
  slug: string | null;
  name: string;
  url: string;
  host: string;
  domains: string[];
  primary: string;
  mapped: boolean;
  managed: boolean;
  health: { status?: string; source?: string; error?: string; http_code?: number; response_time?: number; ssl_expiry_days?: number; since?: number };
  versions: { wordpress?: string | null; php?: string | null; siteguard?: string | null };
  backup: { siteguard_last?: number; siteguard_sets?: number; pulled?: { set: string; pulled_at: number }; restored?: { set: string; at: number } };
  disk: { stack_bytes?: number | null; uploads_bytes?: number | null; filesystem?: { free: number; total: number; low: boolean } | null };
  tunnel: { account: string | null; tunnel: string | null; ready: boolean };
  overrides: Record<string, string>;
}

export interface WpRegistry {
  node: string;
  agent_version: string;
  revision: number;
  stacks: { name: string; mode: string; managed: boolean; versions: WpRegistrySite["versions"]; siteguard: { key: string | null; status: string; error: string }; sites: string[] }[];
  sites: WpRegistrySite[];
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

/** Consecutive failed polls before a node is reported unreachable (one poll a minute). */
export const WPOPS_UNREACHABLE_AFTER = Math.max(1, Number(process.env.WPOPS_UNREACHABLE_AFTER) || 3);
const WPOPS_RETRY_DELAY_MS = Number(process.env.WPOPS_RETRY_DELAY_MS ?? 2_000);

/** "fetch failed" alone says nothing; add the underlying cause (ECONNRESET, ENOTFOUND, ...). */
export function networkErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "AbortError") return "timeout";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

// ------------------------------------------------------------------ nodes

/**
 * Agent URLs must be HTTPS: the bearer token travels in a header. Plain HTTP is
 * only accepted for loopback / RFC1918 hosts (a LAN-only agent).
 */
export function assertAgentUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new WpopsError(`invalid agent URL: ${url}`); }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || /^127\./.test(host) || host === "::1"
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && privateHost)) {
    throw new WpopsError(`agent URL must be https:// (got ${u.protocol}//${host}); the node token would travel in clear text`);
  }
  return url.replace(/\/$/, "");
}

function nodesFromEnv(): WpNode[] {
  const spec = process.env.WPOPS_NODES ?? "";
  const out: WpNode[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, url] = part.split("=", 2);
    if (!name || !url) continue;
    const token = process.env[`WPOPS_TOKEN_${name.toUpperCase().replace(/-/g, "_")}`] ?? "";
    if (!token) continue;
    try {
      out.push({ name: name.trim(), url: assertAgentUrl(url.trim()), token });
    } catch (err) {
      logger.error({ err, name }, "WPOPS_NODES entry ignored");
    }
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

  // GETs are retried once after a connection-level failure (a dropped or
  // reset connection on the way to the agent); POSTs are never repeated.
  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, actor = "bot", timeoutMs = 30_000): Promise<T> {
    try {
      return await this.once<T>(method, path, body, actor, timeoutMs);
    } catch (err) {
      if (method !== "GET" || !(err instanceof WpopsError) || err.status !== 0) throw err;
      await new Promise((r) => setTimeout(r, WPOPS_RETRY_DELAY_MS));
      return this.once<T>(method, path, body, actor, timeoutMs);
    }
  }

  private async once<T>(method: "GET" | "POST", path: string, body: unknown, actor: string, timeoutMs: number): Promise<T> {
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
      throw new WpopsError(`${this.node.name}: ${networkErrorMessage(err)}`);
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
  eventsAfter(seq: number, limit = 100) { return this.req<{ events: WpEvent[] }>("GET", `/v1/events?after=${seq}&limit=${limit}`); }
  siteguardHealth() { return this.req<NodeSgPayload>("GET", "/v1/siteguard/health", undefined, "bot", 60_000); }
  registry() { return this.req<WpRegistry>("GET", "/v1/registry", undefined, "bot", 60_000); }
  registryChanges(since: number) { return this.req<{ revision: number; reset: boolean; changes: { rev: number; op: string; uid: string; site: WpRegistrySite }[] }>("GET", `/v1/registry/changes?since=${since}`); }
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
  /** The agent serves the site registry (false: older agent, 404). */
  registry?: boolean;
}

/** Re-ask an agent that had no registry (it may have been upgraded) this often. */
const REGISTRY_RECHECK_MS = 30 * 60_000;
const EVENT_SEQ_KEY = "WPOPS_EVENT_SEQ";

class WpopsService extends EventEmitter {
  snapshots = new Map<string, NodeSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private jobWatch = new Map<string, { node: string; notified: boolean }>();
  private failures = new Map<string, number>();
  private alerted = new Set<string>();
  private noRegistry = new Map<string, number>();

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
          const snap: NodeSnapshot = { node, status, inventory, error: "", updatedAt: Date.now(), registry: prev?.registry };
          this.snapshots.set(node.name, snap);
          await this.pollSites(node, c, snap);
          this.failures.delete(node.name);
          if (this.alerted.delete(node.name)) this.emit("nodeReachable", node.name);
          await this.drainEvents(node, c);
          this.watchJobs(node, status);
          this.detectOverrideChanges(prev, snap);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          nodeSites.failed(node.name);
          this.snapshots.set(node.name, { node, status: prev?.status ?? null, inventory: prev?.inventory ?? [], error: msg, updatedAt: prev?.updatedAt ?? 0, registry: prev?.registry });
          // A single failed poll is usually a network blip; alert only when it persists.
          const count = (this.failures.get(node.name) ?? 0) + 1;
          this.failures.set(node.name, count);
          logger.warn({ node: node.name, failures: count, err: msg }, "wpops node poll failed");
          if (count >= WPOPS_UNREACHABLE_AFTER && !this.alerted.has(node.name)) {
            this.alerted.add(node.name);
            this.emit("nodeUnreachable", node.name, `${msg} (${count} checks in a row)`);
          }
        }
      }
      for (const name of [...this.snapshots.keys()]) if (!nodes.find((n) => n.name === name)) this.snapshots.delete(name);
      nodeSites.retain(nodes.map((n) => n.name));
      this.emit("updated");
    } finally {
      this.polling = false;
    }
  }

  /**
   * The node's sites in SiteGuard's format, for the SiteGuard monitor. A 404
   * means an agent without the registry: nothing changes for that node.
   */
  private async pollSites(node: WpNode, c: WpopsClient, snap: NodeSnapshot): Promise<void> {
    const skippedAt = this.noRegistry.get(node.name);
    if (skippedAt && Date.now() - skippedAt < REGISTRY_RECHECK_MS) return;
    let payload: NodeSgPayload;
    try {
      payload = await c.siteguardHealth();
    } catch (err) {
      if (err instanceof WpopsError && err.status === 404) {
        this.noRegistry.set(node.name, Date.now());
        snap.registry = false;
        nodeSites.remove(node.name);
        return;
      }
      nodeSites.failed(node.name);
      logger.warn({ node: node.name, err: err instanceof Error ? err.message : String(err) }, "wpops: site registry not read");
      return;
    }
    if (!payload || !Array.isArray(payload.sites)) {
      nodeSites.failed(node.name);
      return;
    }
    this.noRegistry.delete(node.name);
    snap.registry = true;
    const before = nodeSites.get(node.name)?.payload.sites ?? null;
    nodeSites.set(node.name, payload);
    if (before) {
      const had = new Map(before.map((s) => [s.uid, s]));
      const has = new Map(payload.sites.map((s) => [s.uid, s]));
      const added = payload.sites.filter((s) => !had.has(s.uid));
      const removed = before.filter((s) => !has.has(s.uid));
      if (added.length || removed.length) {
        logger.info({ node: node.name, added: added.map((s) => s.uid), removed: removed.map((s) => s.uid) }, "wpops: node sites changed");
        this.emit("sitesChanged", node.name, added, removed);
      }
    }
  }

  /** Sites a node reports (registry), or [] for an older agent. */
  nodeSites(nodeName: string): NodeSgSite[] {
    return nodeSites.get(nodeName)?.payload.sites ?? [];
  }

  private async drainEvents(node: WpNode, c: WpopsClient): Promise<void> {
    const seqKey = `${EVENT_SEQ_KEY}_${node.name}`;
    const seqRaw = getSetting(seqKey);
    if (seqRaw !== undefined && seqRaw !== null) {
      // Agents with numbered events: page forward by sequence, nothing is
      // skipped when several events share a second.
      let cursor = Number(seqRaw) || 0;
      for (let page = 0; page < 10; page++) {
        const { events } = await c.eventsAfter(cursor, 100);
        for (const ev of events) {
          const seq = Number(ev.seq ?? 0);
          if (seq <= cursor) continue;
          cursor = seq;
          this.emit("event", node.name, ev);
        }
        if (events.length < 100) break;
      }
      if (String(cursor) !== seqRaw) setSetting(seqKey, String(cursor));
      return;
    }
    const key = `${EVENT_CURSOR_KEY}_${node.name}`;
    const since = Number(getSetting(key) ?? 0) || 0;
    const { events } = await c.events(since);
    let cursor = since;
    let lastSeq = 0;
    for (const ev of events) {
      lastSeq = Math.max(lastSeq, Number(ev.seq ?? 0));
      if (ev.ts <= since) continue;
      cursor = Math.max(cursor, ev.ts);
      if (since === 0) continue;               // first run: do not replay history
      this.emit("event", node.name, ev);
    }
    if (cursor !== since) setSetting(key, String(cursor));
    // The agent numbers its events: switch to the sequence cursor from here on.
    if (lastSeq > 0) setSetting(seqKey, String(lastSeq));
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
    if (prev && before !== after) {
      logger.info({ node: cur.node.name, before, after }, "wpops: active overrides changed");
      this.emit("overridesChanged", cur.node.name, before, after);
    }
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

  siteForDomain(domain: string | null | undefined): WpSite | null {
    if (!domain || typeof domain !== "string") return null;
    const full = domain.toLowerCase();
    const d = full.replace(/^www\./, "");
    for (const s of this.sites().values()) {
      if (s.domains.some((x) => x === full || x.replace(/^www\./, "") === d)) return s;
      for (const h of Object.values(s.hosts)) if (h.host?.toLowerCase() === full) return s;
    }
    return null;
  }

  /** Is this site currently served by a failover node (any of its domains overridden)? */
  isSiteInFailover(slugOrDomain: string | null | undefined): boolean {
    if (!slugOrDomain) return false;
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
      const site = (s.slug ? this.sites().get(s.slug) : undefined) ?? this.siteForDomain(s.domain);
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
