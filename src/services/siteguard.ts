/**
 * SiteGuard Health Monitor - HTTP polling client.
 *
 * Two kinds of source, merged into one site list:
 *  - the legacy endpoint (SG_HEALTH_URL + SG_HEALTH_API_KEY): one WordPress
 *    install, usually a multisite, polled here;
 *  - WordPress node agents (/wp node add): every site on the node, one per
 *    stack or multisite blog, reported by the agent's GET /v1/siteguard/health
 *    and delivered through nodeSites by the wpops poller. Their sites get
 *    stable ids from NODE_SITE_ID_BASE up (SG_NODE_SITE_IDS), so they never
 *    collide with a multisite's blog ids, and appear and disappear as the node
 *    reports them.
 * Emits events on status changes for the alert and status board services.
 * Completely independent from the Uptime Kuma integration.
 */

import { EventEmitter } from "node:events";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";
import { nodeSites, type NodeSgEntry } from "./nodeSites.js";

/** Ids of node-reported sites start here (a multisite's blog ids stay below). */
export const NODE_SITE_ID_BASE = 100_000;

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SgSite {
  site_id: number;
  url: string;
  /** Host name. Subdirectory multisite subsites share it; see sgSiteLabel(). */
  domain: string;
  /** "unknown": SiteGuard skipped the site this run (time budget). */
  status: "operational" | "degraded" | "down" | "unknown";
  http_code: number;
  response_time: number;
  ssl_expiry_days: number;
  ssl_issuer: string;
  last_check: number;
  error: string;
  consecutive_failures: number;
  check_method: string;
  // api_version 2 (SiteGuard 1.4.9+); absent on older versions.
  ssl_ok?: boolean;
  ssl_error?: string;
  /** Certificate data carried forward from an earlier probe (this probe failed). */
  ssl_stale?: boolean;
  ssl_last_success?: number;
  ssl_checked_at?: number;
  /** SiteGuard 1.5.4+: certificate expiry (epoch seconds or ISO date). */
  ssl_expires_at?: number | string | null;
  // Node-reported sites only (absent = the legacy endpoint).
  source?: "node";
  node?: string;
  /** <node>:<stack>:<blog id>, stable on the node. */
  uid?: string;
  stack?: string;
  blog_id?: number;
  slug?: string | null;
  name?: string;
  mode?: string;
  /** "siteguard" (the stack's own SiteGuard) or "direct" (the agent's HTTP check). */
  check_source?: string;
  versions?: { wordpress?: string | null; php?: string | null; siteguard?: string | null };
  last_backup?: number;
}

/** One entry of SiteGuard's own alerts[] list (api_version 2). */
export interface SgApiAlert {
  severity: string;
  type: string;
  domain?: string;
  message?: string;
  site_id?: number;
  ssl_expiry_days?: number;
  ssl_last_success?: number;
}

export interface SgHealthResponse {
  status: string;
  site_url: string;
  checked_at: number;
  check_interval: number;
  check_interval_label: string;
  sites: SgSite[];
  version: string;
  api_version?: number;
  alerts?: SgApiAlert[];
  /** Present when node agents contribute: what each source holds. */
  sources?: SgSourceInfo[];
}

export interface SgSourceInfo {
  kind: "legacy" | "node";
  name: string;
  sites: number;
  version: string;
  checked_at: number;
  /** Node: its last poll succeeded. Legacy: the endpoint is reachable. */
  current: boolean;
}

/** Where a site's data comes from, for messages. */
export function sgSiteSource(site: Pick<SgSite, "source" | "node" | "check_source" | "check_method" | "stack">): string {
  if (site.check_method === "bot-direct") return "bot direct probe";
  if (site.source === "node") {
    return `node ${site.node ?? "?"}${site.stack ? ` (stack ${site.stack})` : ""}, ${site.check_source === "siteguard" ? "SiteGuard" : "agent direct check"}`;
  }
  return "SiteGuard (WordPress)";
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

/**
 * Why a poll failed. "disabled", "auth", "rate_limited" and "not_found" mean
 * WordPress answered and the problem is configuration (monitor switched off,
 * key rotated, IP blocked after bad keys, plugin/route missing): they are
 * reported once without paging. "http", "bad_payload" and "network" mean
 * WordPress itself may be down: those page as before.
 */
export type SgErrorKind = "disabled" | "auth" | "rate_limited" | "not_found" | "http" | "bad_payload" | "network";

export function isConfigErrorKind(kind: string): boolean {
  return kind === "disabled" || kind === "auth" || kind === "rate_limited" || kind === "not_found";
}

export class SgHttpError extends Error {
  constructor(message: string, readonly kind: SgErrorKind) { super(message); }
}

/**
 * Classify a non-2xx answer. SiteGuard sends {"code","message"}; WordPress
 * sends {"code":"rest_no_route"} when the plugin or route is missing.
 */
export function classifySgError(status: number, body: unknown, statusText = ""): SgHttpError {
  let code = "";
  let message = "";
  if (body && typeof body === "object") {
    const b = body as { code?: unknown; message?: unknown };
    if (typeof b.code === "string") code = b.code.slice(0, 60);
    if (typeof b.message === "string") message = b.message.slice(0, 200);
  }
  const detail = `HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : statusText ? `: ${statusText}` : ""}`;
  if (status === 404 && code === "disabled") {
    return new SgHttpError(`${detail} (the health monitor is switched off in SiteGuard \u2192 Health)`, "disabled");
  }
  if (status === 401 || status === 403) {
    return new SgHttpError(`${detail} (API key rejected - was it regenerated, or did a restore bring back another key?)`, "auth");
  }
  if (status === 429 && code === "rate_limited") {
    return new SgHttpError(`${detail} (SiteGuard blocks this IP after too many failed key attempts; it clears by itself)`, "rate_limited");
  }
  if (status === 404 && code) {
    return new SgHttpError(`${detail} (health route not found - is the SiteGuard plugin active and the URL right?)`, "not_found");
  }
  return new SgHttpError(detail, "http");
}

async function sgHttpError(response: Response): Promise<SgHttpError> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* proxy / web server error page */ }
  return classifySgError(response.status, body, response.statusText);
}

/** Site name for messages: domain plus path, so subdirectory multisite subsites are told apart. */
export function sgSiteLabel(site: Pick<SgSite, "domain" | "url"> | { domain?: string | null; url?: string | null }): string {
  const domain = typeof site.domain === "string" ? site.domain : "";
  let path = "";
  let host = "";
  try {
    const u = new URL(String(site.url ?? ""));
    path = u.pathname.replace(/^\/+|\/+$/g, "");
    host = u.hostname;
  } catch { /* no usable URL */ }
  const name = domain || host;
  if (!name) return String(site.url || "?");
  return path ? `${name}/${path}` : name;
}

/** Days until the certificate expires; prefers ssl_expires_at (SiteGuard 1.5.4+). */
export function sgSslDays(site: SgSite, nowSec = Date.now() / 1000): number {
  const at = site.ssl_expires_at;
  let ts = NaN;
  if (typeof at === "number") ts = at;
  else if (typeof at === "string" && at) ts = /^\d+$/.test(at) ? Number(at) : Date.parse(at) / 1000;
  if (Number.isFinite(ts) && ts > 0) return Math.floor((ts - nowSec) / 86400);
  return typeof site.ssl_expiry_days === "number" ? site.ssl_expiry_days : -1;
}

/** Force-check URL: /health -> /health/check, also for ?rest_route= style URLs. */
export function sgCheckUrl(url: string): string {
  try {
    const u = new URL(url);
    const route = u.searchParams.get("rest_route");
    if (route !== null) {
      u.searchParams.set("rest_route", route.replace(/\/health\/?$/, "/health/check"));
      return u.toString();
    }
    u.pathname = u.pathname.replace(/\/health\/?$/, "/health/check");
    return u.toString();
  } catch {
    return url.replace(/\/health\/?$/, "/health/check");
  }
}

// ---------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------

export const SgStatus = {
  OPERATIONAL: "operational",
  DEGRADED: "degraded",
  DOWN: "down",
} as const;

export function sgStatusEmoji(status: string): string {
  switch (status) {
    case SgStatus.OPERATIONAL: return "\u{1F7E2}";
    case SgStatus.DEGRADED: return "\u{1F7E1}";
    case SgStatus.DOWN: return "\u{1F534}";
    default: return "\u26AA";
  }
}

export function sgStatusLabel(status: string): string {
  switch (status) {
    case SgStatus.OPERATIONAL: return "OPERATIONAL";
    case SgStatus.DEGRADED: return "DEGRADED";
    case SgStatus.DOWN: return "DOWN";
    default: return "UNKNOWN";
  }
}

export function sgStatusColor(status: string): number {
  switch (status) {
    case SgStatus.OPERATIONAL: return 0x2ecc71;
    case SgStatus.DEGRADED: return 0xf39c12;
    case SgStatus.DOWN: return 0xe74c3c;
    default: return 0x95a5a6;
  }
}

// ---------------------------------------------------------------
// Client
// ---------------------------------------------------------------

/** If SiteGuard's checked_at is older than this, trigger a POST to force a fresh check. */
const SG_STALE_THRESHOLD_SEC = 30 * 60; // 30 minutes
/** Minimum time between force-check POSTs to avoid hammering WordPress. */
const SG_FORCE_CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

class SiteGuardClient extends EventEmitter {
  private _data: SgHealthResponse | null = null;
  private _previousStatuses = new Map<number, string>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _reachable = true;
  /** Sites whose SSL expiry warning was sent (persisted: SG_SSL_ALERTED). */
  private _sslAlerted = new Set<number>();
  /** Sites whose SSL probe failure was reported (persisted: SG_SSL_PROBE_ALERTED). */
  private _sslProbeAlerted = new Set<number>();
  private _sslLoaded = false;
  private _lastForceCheckAt = 0;
  private _unreachableSince = 0;
  private _lastError = "";
  private _lastErrorKind: SgErrorKind | "" = "";
  /** Error kind that the current "unreachable" announcement was made for. */
  private _alertedErrorKind: SgErrorKind | "" = "";
  private _staleAlerted = false;
  private _statusesLoaded = false;
  /** Sites the bot's own direct HTTP probe currently considers down. */
  private _directDown = new Map<number, SgSite>();
  private _directFailures = new Map<number, number>();
  private _probeTimer: ReturnType<typeof setInterval> | null = null;
  private _probing = false;
  /** Known sites (persisted) so direct probes work even while SiteGuard is unreachable. */
  private _knownSites: Array<{ site_id: number; url: string; domain: string }> = [];
  /** Last good payload of the legacy endpoint (merged with node sites). */
  private _legacyData: SgHealthResponse | null = null;
  private _started = false;
  /** Start by itself once a node reports sites (node-only estates, no legacy endpoint). */
  private _autoStart = false;
  private _nodeIds: Record<string, number> | null = null;

  constructor() {
    super();
    nodeSites.on("updated", () => {
      if (this._started) this.applyMerged();
      else if (this._autoStart && nodeSites.size > 0) this.start();
    });
  }

  get data(): SgHealthResponse | null { return this._data; }
  get reachable(): boolean { return this._reachable; }
  /** Epoch ms when the endpoint became unreachable (0 when reachable). */
  get unreachableSince(): number { return this._unreachableSince; }
  get lastError(): string { return this._lastError; }
  /** Classification of the last poll failure ("" when reachable). */
  get lastErrorKind(): SgErrorKind | "" { return this._lastErrorKind; }
  get sites(): SgSite[] { return this._data?.sites ?? []; }
  /** Sites seen in earlier polls (persisted), plus the sites nodes report now. */
  get knownSites(): Array<{ site_id: number; url: string; domain: string }> {
    if (this._knownSites.length === 0) this.loadKnownSites();
    const nodeRows = this.sites.filter((s) => s.source === "node").map((s) => ({ site_id: s.site_id, url: s.url, domain: s.domain }));
    return nodeRows.length ? [...this._knownSites, ...nodeRows] : this._knownSites;
  }
  /** The legacy endpoint (SG_HEALTH_URL) is set. Node agents are separate: see hasNodeSources. */
  get isConfigured(): boolean { return !!this.getUrl(); }
  /** At least one node agent reports its sites. */
  get hasNodeSources(): boolean { return nodeSites.size > 0; }
  get started(): boolean { return this._started; }
  /** Sites of one node (or of the legacy endpoint with node = null). */
  sitesOf(node: string | null): SgSite[] {
    return this.sites.filter((s) => (node === null ? s.source !== "node" : s.source === "node" && s.node === node));
  }
  /** Start on the first node report even without a legacy endpoint. */
  enableNodeAutostart(): void {
    this._autoStart = true;
    if (!this._started && nodeSites.size > 0) this.start();
  }
  get dataStale(): boolean {
    if (!this._data) return false;
    return (Date.now() / 1000 - (this._data.checked_at || 0)) > SG_STALE_THRESHOLD_SEC;
  }

  /** Get the effective URL - DB setting overrides env var. */
  getUrl(): string | undefined {
    return getSetting("SG_HEALTH_URL") ?? env().SG_HEALTH_URL;
  }

  /** Get the effective API key - DB setting overrides env var. */
  getApiKey(): string | undefined {
    return getSetting("SG_HEALTH_API_KEY") ?? env().SG_HEALTH_API_KEY;
  }

  start(): void {
    if (this._started) return;
    this._started = true;
    const pollMs = env().SG_HEALTH_POLL_MS ?? 60_000;
    const url = this.getUrl();
    logger.info({ url, pollMs, nodes: nodeSites.size }, "SiteGuard health monitor starting");

    // Immediate first poll
    this.poll().catch((err) => logger.error({ err }, "SiteGuard initial poll failed"));

    this._pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, "SiteGuard poll failed"));
    }, pollMs);

    // Independent per-site probes: the bot fetches every known site itself, so
    // an outage is caught even when the SiteGuard endpoint (or WP-Cron) is the
    // thing that is broken. Offset by half the interval from the poll.
    if (this.directProbeEnabled()) {
      this.loadKnownSites();
      setTimeout(() => {
        this.directProbeAll().catch((err) => logger.error({ err }, "Direct site probe failed"));
        this._probeTimer = setInterval(() => {
          this.directProbeAll().catch((err) => logger.error({ err }, "Direct site probe failed"));
        }, pollMs);
      }, Math.min(pollMs / 2, 30_000));
    }
  }

  stop(): void {
    this._started = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
    logger.info("SiteGuard health monitor stopped");
  }

  private directProbeEnabled(): boolean {
    const v = getSetting("SG_DIRECT_PROBE") ?? env().SG_DIRECT_PROBE ?? "true";
    return String(v).toLowerCase() !== "false";
  }

  /** Also probe node-reported sites from here (default off: the node checks them itself, and
   * a node can host sites whose hostnames are not public). */
  private directProbeNodes(): boolean {
    const v = getSetting("SG_DIRECT_PROBE_NODES") ?? process.env.SG_DIRECT_PROBE_NODES ?? "false";
    return String(v).toLowerCase() === "true";
  }

  private directProbeThreshold(): number {
    const n = parseInt(getSetting("SG_DIRECT_PROBE_FAILS") ?? String(env().SG_DIRECT_PROBE_FAILS ?? 2), 10);
    return Number.isFinite(n) && n >= 1 ? n : 2;
  }

  private loadKnownSites(): void {
    try {
      const raw = getSetting("SG_KNOWN_SITES");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this._knownSites = parsed.filter((s) => s && typeof s.url === "string" && Number.isFinite(Number(s.site_id)))
            .map((s) => ({ site_id: Number(s.site_id), url: String(s.url), domain: String(s.domain ?? "") }));
        }
      }
    } catch (err) {
      logger.warn({ err }, "Could not load known SiteGuard sites");
    }
  }

  private saveKnownSites(sites: SgSite[]): void {
    this._knownSites = sites.map((s) => ({ site_id: s.site_id, url: s.url, domain: s.domain }));
    try { setSetting("SG_KNOWN_SITES", JSON.stringify(this._knownSites)); } catch { /* non-fatal */ }
  }

  /** Is the site currently down according to EITHER source? */
  private isDown(siteId: number): boolean {
    return this._previousStatuses.get(siteId) === "down" || this._directDown.has(siteId);
  }

  /**
   * Fetch every known site directly. A site is declared down after
   * `directProbeThreshold()` consecutive failures (network error, timeout, or
   * HTTP 5xx). Any response below 500 - including 401/403 from a WAF or
   * maintenance 503? no, 503 is down - counts as up: the server is serving.
   */
  async directProbeAll(): Promise<void> {
    const nodeRows = this.directProbeNodes()
      ? this.sites.filter((s) => s.source === "node").map((s) => ({ site_id: s.site_id, url: s.url, domain: s.domain }))
      : [];
    if (this._probing || this._knownSites.length + nodeRows.length === 0) return;
    this._probing = true;
    const threshold = this.directProbeThreshold();
    try {
      const queue = [...this._knownSites, ...nodeRows];
      const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length) {
          const site = queue.shift()!;
          const result = await this.probeOne(site.url);
          const wasDown = this.isDown(site.site_id);
          if (result.ok) {
            this._directFailures.delete(site.site_id);
            if (this._directDown.has(site.site_id)) {
              this._directDown.delete(site.site_id);
              logger.info({ domain: site.domain, code: result.code }, "Direct probe: site responding again");
            }
            if (wasDown && !this.isDown(site.site_id)) {
              this.emit("siteRecovery", this.syntheticSite(site, "operational", result));
            }
          } else {
            const fails = (this._directFailures.get(site.site_id) ?? 0) + 1;
            this._directFailures.set(site.site_id, fails);
            if (fails >= threshold && !this._directDown.has(site.site_id)) {
              const synthetic = this.syntheticSite(site, "down", result, fails);
              this._directDown.set(site.site_id, synthetic);
              logger.error({ domain: site.domain, error: result.error, code: result.code, fails }, "Direct probe: site DOWN");
              if (!wasDown) this.emit("siteDown", synthetic);
            } else if (fails < threshold) {
              logger.warn({ domain: site.domain, error: result.error, code: result.code, fails, threshold }, "Direct probe failed (not yet at threshold)");
            } else if (this._directDown.has(site.site_id)) {
              this._directDown.get(site.site_id)!.consecutive_failures = fails;
            }
          }
        }
      });
      await Promise.all(workers);
    } finally {
      this._probing = false;
    }
  }

  private async probeOne(url: string): Promise<{ ok: boolean; code: number; error: string; ms: number }> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "UptimeKuma-Discord-Bot/direct-probe", Accept: "text/html,*/*" },
      });
      clearTimeout(timeout);
      // Drain a little of the body so the connection is reused/closed cleanly.
      try { await res.body?.cancel(); } catch { /* ignore */ }
      const ok = res.status < 500;
      return { ok, code: res.status, error: ok ? "" : `HTTP ${res.status}`, ms: Date.now() - started };
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? (err.name === "AbortError" ? "Timeout after 20s" : err.message) : String(err);
      return { ok: false, code: 0, error: msg, ms: Date.now() - started };
    }
  }

  private syntheticSite(site: { site_id: number; url: string; domain: string }, status: SgSite["status"], r: { code: number; error: string; ms: number }, fails = 0): SgSite {
    const known = this._data?.sites.find((s) => s.site_id === site.site_id);
    return {
      site_id: site.site_id,
      url: site.url,
      domain: site.domain,
      status,
      http_code: r.code,
      response_time: r.ms / 1000,
      ssl_expiry_days: known?.ssl_expiry_days ?? -1,
      ssl_issuer: known?.ssl_issuer ?? "",
      last_check: Math.floor(Date.now() / 1000),
      error: r.error,
      consecutive_failures: fails,
      check_method: "bot-direct",
    };
  }

  /** Sites down according to the bot's own probes (for the status board / reminders). */
  getDirectDownSites(): SgSite[] {
    return [...this._directDown.values()];
  }

  /** Restart polling (used after config change via slash command). */
  restart(): void {
    this.stop();
    this._data = null;
    this._legacyData = null;
    this._knownSites = [];
    this._previousStatuses.clear();
    this._statusesLoaded = false;
    this._sslAlerted.clear();
    this._sslProbeAlerted.clear();
    this._sslLoaded = false;
    this._reachable = true;
    this._unreachableSince = 0;
    this._lastErrorKind = "";
    this._alertedErrorKind = "";
    this._staleAlerted = false;
    this._directDown.clear();
    this._directFailures.clear();
    if (this.isConfigured || nodeSites.size > 0) {
      this.start();
    }
  }

  /**
   * Last-known per-site statuses survive restarts (settings table). Without
   * this, a restart while a site was down lost the "previous" state and the
   * first poll could never emit siteDown for it - the outage went unannounced
   * until the next transition.
   */
  private loadPersistedStatuses(): void {
    if (this._statusesLoaded) return;
    this._statusesLoaded = true;
    try {
      const raw = getSetting("SG_LAST_STATUSES");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [id, status] of Object.entries(parsed)) {
        const n = Number(id);
        if (Number.isFinite(n) && typeof status === "string") this._previousStatuses.set(n, status);
      }
    } catch (err) {
      logger.warn({ err }, "Could not load persisted SiteGuard statuses");
    }
  }

  private persistStatuses(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [id, status] of this._previousStatuses) obj[String(id)] = status;
      setSetting("SG_LAST_STATUSES", JSON.stringify(obj));
    } catch (err) {
      logger.warn({ err }, "Could not persist SiteGuard statuses");
    }
  }

  /**
   * Persisted id sets for the SSL notices, so a warning that starts while the
   * bot is restarting is still sent, and one that was sent is not repeated
   * after a restart. When the setting does not exist yet (first run of this
   * version), the first poll seeds it silently, as the old in-memory
   * behaviour did, so an upgrade does not re-announce every known warning.
   */
  private _sslSeedSilently = false;
  private loadSslState(): void {
    if (this._sslLoaded) return;
    this._sslLoaded = true;
    const read = (key: string, into: Set<number>): boolean => {
      const raw = getSetting(key);
      if (raw === undefined) return false;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const v of arr) if (Number.isFinite(Number(v))) into.add(Number(v));
      } catch { /* ignore corrupt value */ }
      return true;
    };
    const hadExpiry = read("SG_SSL_ALERTED", this._sslAlerted);
    read("SG_SSL_PROBE_ALERTED", this._sslProbeAlerted);
    this._sslSeedSilently = !hadExpiry;
  }

  private persistSslState(): void {
    try {
      setSetting("SG_SSL_ALERTED", JSON.stringify([...this._sslAlerted]));
      setSetting("SG_SSL_PROBE_ALERTED", JSON.stringify([...this._sslProbeAlerted]));
    } catch (err) {
      logger.warn({ err }, "Could not persist SiteGuard SSL alert state");
    }
  }

  async poll(): Promise<void> {
    const url = this.getUrl();
    const apiKey = this.getApiKey();

    if (!url) {
      // Node agents only: their data arrives through nodeSites.
      this.applyMerged();
      return;
    }

    let data: SgHealthResponse;
    try {
      const response = await fetch(url, {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw await sgHttpError(response);
      }

      try {
        data = await response.json() as SgHealthResponse;
      } catch {
        throw new SgHttpError(
          `HTTP ${response.status} but the body is not JSON (${response.headers.get("content-type") || "no content-type"}) - a proxy or PHP error page?`,
          "bad_payload",
        );
      }
      if (!data || !Array.isArray(data.sites)) {
        throw new SgHttpError("Health endpoint returned an unexpected payload (no sites array)", "bad_payload");
      }
    } catch (err) {
      this.handlePollError(err);
      // Node sites keep updating while the legacy endpoint is down.
      if (nodeSites.size > 0) this.applyMerged();
      return;
    }
    this._legacyData = data;
    const merged = this.buildMerged();
    if (merged) this._data = merged;

    // Reachability state change
    if (!this._reachable) {
      const previousKind = this._alertedErrorKind;
      this._reachable = true;
      this._unreachableSince = 0;
      this._lastError = "";
      this._lastErrorKind = "";
      this._alertedErrorKind = "";
      this.emit("reachable", previousKind);
      logger.info({ previousKind }, "SiteGuard WordPress endpoint is reachable again");
    }

    // If the health data is stale (WordPress cron stopped), trigger a force check via POST.
    const dataAge = Date.now() / 1000 - (data.checked_at || 0);
    if (dataAge > SG_STALE_THRESHOLD_SEC && Date.now() - this._lastForceCheckAt > SG_FORCE_CHECK_COOLDOWN_MS) {
      logger.warn(
        { dataAgeSec: Math.floor(dataAge), checkedAt: data.checked_at },
        "SiteGuard data is stale - triggering force check via POST"
      );
      this._lastForceCheckAt = Date.now();
      this.forceCheck(url, apiKey).catch((err) =>
        logger.warn({ err }, "SiteGuard force check failed")
      );
    }
    if (merged) this.applyMergedData(merged);

    logger.debug(
      { status: data.status, siteCount: data.sites.length, checkedAt: data.checked_at },
      "SiteGuard poll successful"
    );
  }

  // ------------------------------------------------------------ merging

  /** Legacy payload and node payloads as one response; null when there is no data at all. */
  private buildMerged(): SgHealthResponse | null {
    const legacy = this._legacyData;
    const nodes = nodeSites.all();
    if (nodes.length === 0) return legacy;      // legacy only: exactly as polled
    return mergeSgPayloads(legacy, nodes, this.reachable, (node, uid) => this.nodeSiteId(node, uid));
  }

  /** Re-merge with the latest node data and apply it (node updates, legacy failures). */
  private applyMerged(): void {
    const merged = this.buildMerged();
    if (!merged) {
      if (this._data && this._data.sites.some((s) => s.source === "node")) {
        // Every node is gone and there is no legacy endpoint.
        this._data = null;
        this.pruneNodeSites(new Set());
        this.persistStatuses();
      }
      return;
    }
    this.applyMergedData(merged);
  }

  private applyMergedData(data: SgHealthResponse): void {
    // Stale-data alerting: the sources answer but nothing has actually checked
    // the sites for a long time (WordPress cron dead, node registry stopped).
    // Sites could be down with nobody noticing, so this is alert-worthy -
    // once, plus a recovery notice.
    const dataAge = Date.now() / 1000 - (data.checked_at || 0);
    const staleForAlert = dataAge > 2 * SG_STALE_THRESHOLD_SEC;
    if (staleForAlert && !this._staleAlerted) {
      this._staleAlerted = true;
      this.emit("dataStale", Math.floor(dataAge));
    } else if (!staleForAlert && this._staleAlerted) {
      this._staleAlerted = false;
      this.emit("dataFresh");
    }
    this.applyData(data);
  }

  /** Stable id of a node-reported site (persisted in SG_NODE_SITE_IDS, never reused). */
  private nodeSiteId(node: string, uid: string): number {
    if (!this._nodeIds) {
      try {
        const parsed = JSON.parse(getSetting("SG_NODE_SITE_IDS") ?? "{}");
        this._nodeIds = parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
      } catch {
        this._nodeIds = {};
      }
    }
    const key = `${node}|${uid}`;
    let id = this._nodeIds[key];
    if (!Number.isFinite(id)) {
      id = Math.max(NODE_SITE_ID_BASE - 1, ...Object.values(this._nodeIds).filter(Number.isFinite)) + 1;
      this._nodeIds[key] = id;
      try { setSetting("SG_NODE_SITE_IDS", JSON.stringify(this._nodeIds)); } catch { /* non-fatal */ }
    }
    return id;
  }

  /** Forget per-site state of node sites that are no longer reported. */
  private pruneNodeSites(present: Set<number>): void {
    const drop = (id: number) => id >= NODE_SITE_ID_BASE && !present.has(id);
    for (const id of [...this._previousStatuses.keys()]) if (drop(id)) this._previousStatuses.delete(id);
    for (const id of [...this._directDown.keys()]) if (drop(id)) this._directDown.delete(id);
    for (const id of [...this._directFailures.keys()]) if (drop(id)) this._directFailures.delete(id);
    for (const id of [...this._sslAlerted]) if (drop(id)) this._sslAlerted.delete(id);
    for (const id of [...this._sslProbeAlerted]) if (drop(id)) this._sslProbeAlerted.delete(id);
  }

  private handlePollError(err: unknown): void {
    this._lastError = err instanceof Error
      ? (err.name === "TimeoutError" || err.name === "AbortError" ? "Timeout after 15s" : err.message)
      : String(err);
    const kind: SgErrorKind = err instanceof SgHttpError ? err.kind : "network";
    this._lastErrorKind = kind;
    if (this._reachable) {
      this._reachable = false;
      this._unreachableSince = Date.now();
      this._alertedErrorKind = kind;
      this.emit("unreachable", this._lastError, kind);
      logger.error({ err: this._lastError, kind }, "SiteGuard WordPress endpoint unreachable");
    } else if (isConfigErrorKind(this._alertedErrorKind) && !isConfigErrorKind(kind)) {
      // First announced as a configuration problem (not paged), and now
      // WordPress itself does not answer: announce that as a real outage.
      this._alertedErrorKind = kind;
      this.emit("unreachable", this._lastError, kind);
      logger.error({ err: this._lastError, kind }, "SiteGuard endpoint now unreachable (was a configuration error)");
    } else {
      logger.warn({ err: this._lastError, kind, downForSec: Math.floor((Date.now() - this._unreachableSince) / 1000) }, "SiteGuard still unreachable");
    }
  }

  /**
   * Apply a health payload (from GET /health or POST /health/check): update
   * per-site state and emit down / recovery / SSL events on transitions.
   */
  private applyData(data: SgHealthResponse): void {
    this._data = data;

    const sslWarnDays = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10) || 14;
    this.loadPersistedStatuses();
    this.loadSslState();
    const seedSsl = this._sslSeedSilently;
    this._sslSeedSilently = false;

    // Remembered for direct probes while the endpoint is down: legacy sites only
    // (node sites are known from the node's last report).
    if (this._legacyData) this.saveKnownSites(data.sites.filter((s) => s.source !== "node"));

    const probeFailed = new Map<number, SgApiAlert>();
    for (const a of Array.isArray(data.alerts) ? data.alerts : []) {
      if (a && a.type === "ssl_probe_failed" && Number.isFinite(Number(a.site_id))) probeFailed.set(Number(a.site_id), a);
    }

    for (const site of data.sites) {
      // SiteGuard 1.5.4+ sends the expiry date; derive the days from it so
      // they are current even when the payload is a few minutes old.
      site.ssl_expiry_days = sgSslDays(site);

      // Status change detection. On the first poll the previous state comes
      // from the persisted map; a site that is down with no prior record (or a
      // prior non-down record) is a real outage and MUST alert. Down/up is
      // announced once across both sources (SiteGuard + the bot's direct probe).
      // "unknown" = SiteGuard skipped the site this run (time budget): no new
      // information, so the last known state is kept instead of announcing a
      // recovery for a site that may still be down.
      const wasDown = this.isDown(site.site_id);
      const prev = this._previousStatuses.get(site.site_id);
      this._previousStatuses.set(site.site_id, site.status === "unknown" && prev ? prev : site.status);
      const nowDown = this.isDown(site.site_id);
      if (!wasDown && nowDown) {
        this.emit("siteDown", site);
      } else if (wasDown && !nowDown) {
        this.emit("siteRecovery", site);
      }

      // Skipped sites carry no fresh certificate data either.
      if (site.status === "unknown") continue;

      // SSL expiry warning, once per site until it renews. Data carried
      // forward from a failed probe (ssl_stale) is not trusted, as in
      // SiteGuard's own alerts: it neither alerts nor re-arms.
      if (site.ssl_stale !== true) {
        if (site.ssl_expiry_days >= 0 && site.ssl_expiry_days <= sslWarnDays) {
          if (!this._sslAlerted.has(site.site_id)) {
            this._sslAlerted.add(site.site_id);
            if (!seedSsl) this.emit("sslExpiring", site);
          }
        } else {
          this._sslAlerted.delete(site.site_id); // renewed (or no certificate): re-arm
        }
      }

      // SSL probe failure (SiteGuard could not read the certificate), once
      // per site until a probe succeeds again.
      const pf = probeFailed.get(site.site_id);
      if (pf) {
        if (!this._sslProbeAlerted.has(site.site_id)) {
          this._sslProbeAlerted.add(site.site_id);
          if (!seedSsl) this.emit("sslProbeFailed", site, pf.message ?? site.ssl_error ?? "");
        }
      } else if (site.ssl_stale !== true) {
        this._sslProbeAlerted.delete(site.site_id);
      }
    }
    const removed = [...this._previousStatuses.keys()].filter((id) => id >= NODE_SITE_ID_BASE && !data.sites.some((s) => s.site_id === id));
    if (removed.length) {
      this.pruneNodeSites(new Set(data.sites.map((s) => s.site_id)));
      logger.info({ removed }, "SiteGuard: node sites no longer reported, forgotten");
    }
    this.persistStatuses();
    this.persistSslState();

    this.emit("updated", data);
  }

  /**
   * Trigger an on-demand health check via POST. SiteGuard's cron can stop
   * if WordPress doesn't receive traffic, so this keeps data fresh.
   * The response contains the fresh health data, applied like a poll result.
   */
  private async forceCheck(url: string, apiKey: string | undefined): Promise<void> {
    const response = await fetch(sgCheckUrl(url), {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      // 429 = cooldown, that's expected - we'll get fresh data on the next GET poll
      if (response.status === 429) {
        logger.info("SiteGuard force check throttled (cooldown) - will retry later");
        return;
      }
      throw await sgHttpError(response);
    }

    const data = await response.json() as SgHealthResponse;
    if (!data || !Array.isArray(data.sites)) {
      throw new Error("Force check returned an unexpected payload (no sites array)");
    }
    logger.info(
      { checkedAt: data.checked_at, siteCount: data.sites.length },
      "SiteGuard force check successful - fresh data applied"
    );
    this._legacyData = data;
    // Applied like a poll result, without re-deciding staleness here (the next
    // GET poll does that, as before).
    const merged = this.buildMerged();
    if (merged) this.applyData(merged);
  }

  getSummary(): { total: number; operational: number; degraded: number; down: number } {
    const sites = this.sites;
    return {
      total: sites.length,
      operational: sites.filter((s) => s.status === "operational").length,
      degraded: sites.filter((s) => s.status === "degraded").length,
      down: sites.filter((s) => s.status === "down").length,
    };
  }

  getDownSites(): SgSite[] {
    const byId = new Map<number, SgSite>();
    for (const s of this.sites) {
      if (s.status === "down" || (s.status === "unknown" && this._previousStatuses.get(s.site_id) === "down")) byId.set(s.site_id, s);
    }
    for (const s of this._directDown.values()) if (!byId.has(s.site_id)) byId.set(s.site_id, s);
    return [...byId.values()];
  }

  getSslExpiring(): SgSite[] {
    const warn = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10) || 14;
    return this.sites.filter((s) => s.status !== "unknown" && s.ssl_stale !== true && s.ssl_expiry_days >= 0 && s.ssl_expiry_days <= warn);
  }
}

const STATUS_RANK: Record<string, number> = { down: 3, degraded: 2, unknown: 1, operational: 0 };

/**
 * Merge the legacy payload with node payloads. Node site ids are mapped to
 * bot-wide ids (idFor) and alerts follow them. checked_at is the oldest
 * among sources that are current (legacy reachable, node polled fine), so a
 * stale source still raises the stale-data alert, but an unreachable one (which
 * has its own alert) does not.
 */
export function mergeSgPayloads(legacy: SgHealthResponse | null, nodes: NodeSgEntry[], legacyReachable: boolean,
  idFor: (node: string, uid: string) => number): SgHealthResponse {
  const sites: SgSite[] = legacy ? [...legacy.sites] : [];
  const alerts: SgApiAlert[] = legacy && Array.isArray(legacy.alerts) ? [...legacy.alerts] : [];
  const sources: SgSourceInfo[] = [];
  const fresh: number[] = [];
  const all: number[] = [];
  if (legacy) {
    sources.push({ kind: "legacy", name: (() => { try { return new URL(legacy.site_url).host; } catch { return "WordPress"; } })(),
      sites: legacy.sites.length, version: legacy.version, checked_at: legacy.checked_at || 0, current: legacyReachable });
    all.push(legacy.checked_at || 0);
    if (legacyReachable) fresh.push(legacy.checked_at || 0);
  }
  for (const { node, payload, ok } of nodes) {
    const ids = new Map<number, number>();
    for (const row of payload.sites ?? []) {
      if (!row || typeof row !== "object" || !Number.isFinite(Number(row.site_id))) continue;
      const uid = typeof row.uid === "string" && row.uid ? row.uid : `${node}:${row.site_id}`;
      const id = idFor(node, uid);
      ids.set(Number(row.site_id), id);
      sites.push({ ...row, site_id: id, source: "node", node, uid } as SgSite);
    }
    for (const a of payload.alerts ?? []) {
      alerts.push({ ...a, site_id: ids.get(Number(a.site_id)) ?? 0 });
    }
    sources.push({ kind: "node", name: node, sites: ids.size, version: payload.version, checked_at: payload.checked_at || 0, current: ok });
    all.push(payload.checked_at || 0);
    if (ok) fresh.push(payload.checked_at || 0);
  }
  const worst = sites.reduce((w, s) => Math.max(w, STATUS_RANK[s.status] ?? 1), 0);
  const downAll = sites.length > 0 && sites.every((s) => s.status === "down");
  return {
    status: downAll ? "down" : worst >= 2 ? "degraded" : sites.length ? "operational" : "unknown",
    site_url: legacy?.site_url ?? `wpops://${nodes[0]?.node ?? "node"}`,
    checked_at: fresh.length ? Math.min(...fresh) : Math.max(0, ...all),
    check_interval: legacy?.check_interval ?? 60,
    check_interval_label: legacy?.check_interval_label ?? "wpops",
    sites,
    version: legacy?.version ?? nodes[0]?.payload.version ?? "",
    api_version: 2,
    alerts,
    sources,
  };
}

export const siteguard = new SiteGuardClient();
