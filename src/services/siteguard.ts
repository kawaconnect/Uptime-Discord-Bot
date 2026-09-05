/**
 * SiteGuard Health Monitor - HTTP polling client.
 *
 * Polls the WordPress REST API endpoint for multisite health data.
 * Emits events on status changes for the alert and status board services.
 * Completely independent from the Uptime Kuma integration.
 */

import { EventEmitter } from "node:events";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { getSetting, setSetting } from "../db/index.js";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SgSite {
  site_id: number;
  url: string;
  domain: string;
  status: "operational" | "degraded" | "down";
  http_code: number;
  response_time: number;
  ssl_expiry_days: number;
  ssl_issuer: string;
  last_check: number;
  error: string;
  consecutive_failures: number;
  check_method: string;
}

export interface SgHealthResponse {
  status: string;
  site_url: string;
  checked_at: number;
  check_interval: number;
  check_interval_label: string;
  sites: SgSite[];
  version: string;
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
  private _sslAlerted = new Set<number>();
  private _firstPoll = true;
  private _lastForceCheckAt = 0;
  private _unreachableSince = 0;
  private _lastError = "";
  private _staleAlerted = false;
  private _statusesLoaded = false;
  /** Sites the bot's own direct HTTP probe currently considers down. */
  private _directDown = new Map<number, SgSite>();
  private _directFailures = new Map<number, number>();
  private _probeTimer: ReturnType<typeof setInterval> | null = null;
  private _probing = false;
  /** Known sites (persisted) so direct probes work even while SiteGuard is unreachable. */
  private _knownSites: Array<{ site_id: number; url: string; domain: string }> = [];

  get data(): SgHealthResponse | null { return this._data; }
  get reachable(): boolean { return this._reachable; }
  /** Epoch ms when the endpoint became unreachable (0 when reachable). */
  get unreachableSince(): number { return this._unreachableSince; }
  get lastError(): string { return this._lastError; }
  get sites(): SgSite[] { return this._data?.sites ?? []; }
  get isConfigured(): boolean { return !!this.getUrl(); }
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
    const pollMs = env().SG_HEALTH_POLL_MS ?? 60_000;
    const url = this.getUrl();
    logger.info({ url, pollMs }, "SiteGuard health monitor starting");

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
    if (this._probing || this._knownSites.length === 0) return;
    this._probing = true;
    const threshold = this.directProbeThreshold();
    try {
      const queue = [...this._knownSites];
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
    this._previousStatuses.clear();
    this._statusesLoaded = false;
    this._sslAlerted.clear();
    this._reachable = true;
    this._unreachableSince = 0;
    this._firstPoll = true;
    this._staleAlerted = false;
    this._directDown.clear();
    this._directFailures.clear();
    if (this.isConfigured) {
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

  async poll(): Promise<void> {
    const url = this.getUrl();
    const apiKey = this.getApiKey();

    if (!url) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as SgHealthResponse;
      if (!data || !Array.isArray(data.sites)) {
        throw new Error("Health endpoint returned an unexpected payload (no sites array)");
      }
      this._data = data;

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
      // Stale-data alerting: the endpoint answers but WordPress has not actually
      // checked its sites for a long time (cron dead). Sites could be down with
      // nobody noticing, so this is alert-worthy - once, plus a recovery notice.
      const staleForAlert = dataAge > 2 * SG_STALE_THRESHOLD_SEC;
      if (staleForAlert && !this._staleAlerted) {
        this._staleAlerted = true;
        this.emit("dataStale", Math.floor(dataAge));
      } else if (!staleForAlert && this._staleAlerted) {
        this._staleAlerted = false;
        this.emit("dataFresh");
      }

      // Reachability state change
      if (!this._reachable) {
        this._reachable = true;
        this._unreachableSince = 0;
        this._lastError = "";
        this.emit("reachable");
        logger.info("SiteGuard WordPress endpoint is reachable again");
      }

      // Compare per-site statuses for change detection
      const sslWarnDays = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10) || 14;
      this.loadPersistedStatuses();

      this.saveKnownSites(data.sites);

      for (const site of data.sites) {
        // Status change detection. On the first poll the previous state comes
        // from the persisted map; a site that is down with no prior record (or a
        // prior non-down record) is a real outage and MUST alert - the old
        // `!this._firstPoll` guard swallowed every outage that started while the
        // bot was restarting or before it was connected. Down/up is announced
        // once across both sources (SiteGuard + the bot's direct probe).
        const wasDown = this.isDown(site.site_id);
        this._previousStatuses.set(site.site_id, site.status);
        const nowDown = this.isDown(site.site_id);
        if (!wasDown && nowDown) {
          this.emit("siteDown", site);
        } else if (wasDown && !nowDown) {
          this.emit("siteRecovery", site);
        }

        // SSL expiry alerts (only once per site until it renews)
        if (site.ssl_expiry_days >= 0 && site.ssl_expiry_days <= sslWarnDays) {
          if (!this._sslAlerted.has(site.site_id)) {
            this._sslAlerted.add(site.site_id);
            if (!this._firstPoll) {
              this.emit("sslExpiring", site);
            }
          }
        } else {
          // SSL renewed, allow re-alerting
          this._sslAlerted.delete(site.site_id);
        }

      }
      this.persistStatuses();

      this._firstPoll = false;
      this.emit("updated", data);

      logger.debug(
        { status: data.status, siteCount: data.sites.length, checkedAt: data.checked_at },
        "SiteGuard poll successful"
      );
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      if (this._reachable) {
        this._reachable = false;
        this._unreachableSince = Date.now();
        this.emit("unreachable", this._lastError);
        logger.error({ err }, "SiteGuard WordPress endpoint unreachable");
      } else {
        logger.warn({ err: this._lastError, downForSec: Math.floor((Date.now() - this._unreachableSince) / 1000) }, "SiteGuard still unreachable");
      }
    }
  }

  /**
   * Trigger an on-demand health check via POST. SiteGuard's cron can stop
   * if WordPress doesn't receive traffic, so this keeps data fresh.
   * The response contains the fresh health data which we apply immediately.
   */
  private async forceCheck(url: string, apiKey: string | undefined): Promise<void> {
    // POST to /health/check (same base URL but with /check appended)
    const checkUrl = url.replace(/\/health\/?$/, "/health/check");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(checkUrl, {
        method: "POST",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        // 429 = cooldown, that's expected - we'll get fresh data on the next GET poll
        if (response.status === 429) {
          logger.info("SiteGuard force check throttled (cooldown) - will retry later");
          return;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as SgHealthResponse;
      this._data = data;
      logger.info(
        { checkedAt: data.checked_at, siteCount: data.sites.length },
        "SiteGuard force check successful - fresh data applied"
      );
      this.emit("updated", data);
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
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
    for (const s of this.sites) if (s.status === "down") byId.set(s.site_id, s);
    for (const s of this._directDown.values()) if (!byId.has(s.site_id)) byId.set(s.site_id, s);
    return [...byId.values()];
  }

  getSslExpiring(): SgSite[] {
    const warn = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10) || 14;
    return this.sites.filter((s) => s.ssl_expiry_days >= 0 && s.ssl_expiry_days <= warn);
  }
}

export const siteguard = new SiteGuardClient();
