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
import { getSetting } from "../db/index.js";

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
}

export interface SgHealthResponse {
  status: string;
  site_url: string;
  checked_at: number;
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

class SiteGuardClient extends EventEmitter {
  private _data: SgHealthResponse | null = null;
  private _previousStatuses = new Map<number, string>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _reachable = true;
  private _sslAlerted = new Set<number>();
  private _firstPoll = true;

  get data(): SgHealthResponse | null { return this._data; }
  get reachable(): boolean { return this._reachable; }
  get sites(): SgSite[] { return this._data?.sites ?? []; }
  get isConfigured(): boolean { return !!this.getUrl(); }

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
  }

  stop(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    logger.info("SiteGuard health monitor stopped");
  }

  /** Restart polling (used after config change via slash command). */
  restart(): void {
    this.stop();
    this._data = null;
    this._previousStatuses.clear();
    this._sslAlerted.clear();
    this._reachable = true;
    this._firstPoll = true;
    if (this.isConfigured) {
      this.start();
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
      this._data = data;

      // Reachability state change
      if (!this._reachable) {
        this._reachable = true;
        this.emit("reachable");
        logger.info("SiteGuard WordPress endpoint is reachable again");
      }

      // Compare per-site statuses for change detection
      const sslWarnDays = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10);

      for (const site of data.sites) {
        const prev = this._previousStatuses.get(site.site_id);

        if (!this._firstPoll && prev !== undefined) {
          // Status change detection
          if (site.status === "down" && prev !== "down") {
            this.emit("siteDown", site, false);
          } else if (site.status !== "down" && prev === "down") {
            this.emit("siteRecovery", site);
          }
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

        this._previousStatuses.set(site.site_id, site.status);
      }

      this._firstPoll = false;
      this.emit("updated", data);

      logger.debug(
        { status: data.status, siteCount: data.sites.length, checkedAt: data.checked_at },
        "SiteGuard poll successful"
      );
    } catch (err) {
      if (this._reachable) {
        this._reachable = false;
        this.emit("unreachable", err instanceof Error ? err.message : String(err));
        logger.error({ err }, "SiteGuard WordPress endpoint unreachable");
      } else {
        logger.debug({ err }, "SiteGuard still unreachable");
      }
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
    return this.sites.filter((s) => s.status === "down");
  }

  getSslExpiring(): SgSite[] {
    const warn = parseInt(getSetting("SG_SSL_WARN_DAYS") ?? "14", 10);
    return this.sites.filter((s) => s.ssl_expiry_days >= 0 && s.ssl_expiry_days <= warn);
  }
}

export const siteguard = new SiteGuardClient();
