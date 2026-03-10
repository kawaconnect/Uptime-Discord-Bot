/**
 * Uptime Kuma Socket.IO client - persistent real-time connection.
 *
 * ARCHITECTURE:
 * Kuma v2 pushes monitorList + heartbeatList on connect, then is SUPPOSED
 * to send real-time `heartbeat` events. In practice, heartbeats silently
 * stop while avgPing/uptime events keep flowing - making naive "last data"
 * checks useless.
 *
 * Solution: Track heartbeats separately. If no heartbeat in HEARTBEAT_TIMEOUT,
 * force a full reconnect to get fresh heartbeatList data. The periodic refresh
 * in statusBoard.ts also triggers reconnects when heartbeats go stale.
 */

import { io, Socket } from "socket.io-client";
import { EventEmitter } from "node:events";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface KumaMonitor {
  id: number;
  name: string;
  type: string;
  url: string;
  hostname: string;
  port: number | null;
  active: boolean;
  interval: number;
  description: string;
  tags: Array<{ id: number; name: string; color: string; value: string }>;
  parent: number | null;
  maintenance: boolean;
  maxretries: number;
}

export interface KumaHeartbeat {
  /** Kuma v2 uses monitorID (camelCase). v1 used monitor_id. */
  monitorID: number;
  /** @deprecated v1 field - use monitorID */
  monitor_id?: number;
  status: number;
  time: string;
  msg: string;
  ping: number | null;
  important: boolean;
  retries?: number;
  /** @deprecated v1 field */
  id?: number;
  /** @deprecated v1 field */
  duration?: number;
}

/** Get the monitor ID from a heartbeat, handling both v1 and v2 field names. */
export function heartbeatMonitorId(hb: KumaHeartbeat): number {
  return Number(hb.monitorID ?? hb.monitor_id ?? 0);
}

export const MonitorStatus = {
  DOWN: 0,
  UP: 1,
  PENDING: 2,
  MAINTENANCE: 3,
} as const;

export function statusLabel(status: number): string {
  switch (status) {
    case MonitorStatus.UP: return "UP";
    case MonitorStatus.DOWN: return "DOWN";
    case MonitorStatus.PENDING: return "PENDING";
    case MonitorStatus.MAINTENANCE: return "MAINTENANCE";
    default: return "UNKNOWN";
  }
}

export function statusEmoji(status: number): string {
  switch (status) {
    case MonitorStatus.UP: return "\u{1F7E2}";
    case MonitorStatus.DOWN: return "\u{1F534}";
    case MonitorStatus.PENDING: return "\u{1F7E1}";
    case MonitorStatus.MAINTENANCE: return "\u{1F535}";
    default: return "\u26AA";
  }
}

export function statusColor(status: number): number {
  switch (status) {
    case MonitorStatus.UP: return 0x2ecc71;
    case MonitorStatus.DOWN: return 0xe74c3c;
    case MonitorStatus.PENDING: return 0xf39c12;
    case MonitorStatus.MAINTENANCE: return 0x3498db;
    default: return 0x95a5a6;
  }
}

// ---------------------------------------------------------------
// Event types
// ---------------------------------------------------------------

export interface KumaClientEvents {
  connected: [];
  disconnected: [reason: string];
  monitorListUpdated: [monitors: Map<number, KumaMonitor>];
  statusChange: [monitor: KumaMonitor, heartbeat: KumaHeartbeat, previousStatus: number | undefined];
  heartbeat: [heartbeat: KumaHeartbeat];
  dataStale: [stalenessMs: number];
  dataFresh: [];
}

// ---------------------------------------------------------------
// Timings
// ---------------------------------------------------------------

/** Force reconnect if no heartbeat event in this long. */
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds
/** Watchdog check interval. */
const WATCHDOG_INTERVAL_MS = 15_000; // 15 seconds

// ---------------------------------------------------------------
// Client
// ---------------------------------------------------------------

class KumaClient extends EventEmitter {
  private socket: Socket | null = null;
  private _monitors = new Map<number, KumaMonitor>();
  private _latestStatus = new Map<number, number>();
  private _avgPing = new Map<number, number>();
  /** Latest ping from real-time heartbeats (not smoothed). */
  private _latestPing = new Map<number, number>();
  private _uptime24h = new Map<number, number>();
  private _connected = false;
  private _authenticated = false;
  private _jwtToken: string | null = null;
  private _info: { version?: string; serverTimezone?: string } = {};

  /** Last time we got a real heartbeat event (status-bearing). */
  private _lastHeartbeatAt = 0;
  /** Last time we got ANY data event. */
  private _lastDataAt = 0;
  /** Last time heartbeatList (bulk) arrived - counts as heartbeat. */
  private _lastHeartbeatListAt = 0;

  private _statusUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectCount = 0;
  private _wasStale = false;
  /** Guard against emitting 'connected' multiple times per connection cycle. */
  private _emittedConnected = false;

  /** Event counters for debugging. */
  private _eventCounts = {
    heartbeat: 0,
    heartbeatList: 0,
    monitorList: 0,
    avgPing: 0,
    uptime: 0,
    info: 0,
    statusChange: 0,
  };

  get monitors(): Map<number, KumaMonitor> { return this._monitors; }
  get latestStatus(): Map<number, number> { return this._latestStatus; }
  get avgPing(): Map<number, number> { return this._avgPing; }
  /** Latest per-heartbeat ping (changes every cycle, not smoothed). */
  get latestPing(): Map<number, number> { return this._latestPing; }
  get uptime24h(): Map<number, number> { return this._uptime24h; }
  get connected(): boolean { return this._connected && this._authenticated; }
  get serverInfo() { return this._info; }
  get lastHeartbeatAt(): number { return Math.max(this._lastHeartbeatAt, this._lastHeartbeatListAt); }
  get lastDataAt(): number { return this._lastDataAt; }
  get reconnectCount(): number { return this._reconnectCount; }
  get eventCounts() { return { ...this._eventCounts }; }

  /** Seconds since last heartbeat or heartbeatList event. */
  get heartbeatStalenessSeconds(): number {
    const last = this.lastHeartbeatAt;
    if (last === 0) return -1;
    return Math.floor((Date.now() - last) / 1000);
  }

  /** True if heartbeats have stopped (even if other data flows). */
  get heartbeatStale(): boolean {
    const last = this.lastHeartbeatAt;
    if (!this._authenticated || last === 0) return false;
    return Date.now() - last > HEARTBEAT_TIMEOUT_MS;
  }

  // Keep old names for compat with statusBoard/alerts/server
  get dataStale(): boolean { return this.heartbeatStale; }
  get dataStalenessSeconds(): number { return this.heartbeatStalenessSeconds; }

  private emitConnectedOnce(): void {
    if (this._emittedConnected) {
      logger.info("Skipping duplicate connected emit");
      return;
    }
    this._emittedConnected = true;
    this.emit("connected");
  }

  connect(): void {
    const config = env();
    const url = config.KUMA_URL;
    logger.info({ url }, "Connecting to Uptime Kuma");

    this.socket = io(url, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
      transports: ["websocket", "polling"],
    });

    // Log ALL socket events for debugging
    this.socket.onAny((event: string, ...args: unknown[]) => {
      // Skip noisy events we already handle, but log unknown ones
      const known = ["connect", "disconnect", "connect_error", "autoLogin",
        "monitorList", "heartbeat", "heartbeatList", "importantHeartbeatList",
        "avgPing", "uptime", "info"];
      if (!known.includes(event)) {
        logger.info({ event, argCount: args.length }, "Unknown socket event received");
      }
    });

    this.socket.on("connect", () => {
      logger.info("Socket.IO connected");
      this._connected = true;
      const config = env();
      if (config.KUMA_USERNAME && config.KUMA_PASSWORD) {
        this.authenticate();
      } else {
        logger.info("No credentials configured - waiting for auto-login");
      }
    });

    this.socket.on("disconnect", (reason) => {
      logger.warn({ reason }, "Disconnected from Uptime Kuma");
      const wasAuthenticated = this._authenticated;
      this._connected = false;
      this._authenticated = false;
      this._emittedConnected = false;
      if (wasAuthenticated) {
        this.emit("disconnected", reason);
      }
    });

    this.socket.on("connect_error", (err) => {
      logger.error({ err: err.message }, "Connection error");
    });

    this.socket.on("autoLogin", () => {
      logger.info("Auto-login (no auth required)");
      this._authenticated = true;
      this._lastDataAt = Date.now();
      this.emitConnectedOnce();
    });

    // ---- Data events ----

    this.socket.on("monitorList", (data: Record<string, KumaMonitor>) => {
      this._lastDataAt = Date.now();
      this._eventCounts.monitorList++;
      if (!this._authenticated) {
        logger.info("Received data - implicitly authenticated");
        this._authenticated = true;
        this.emitConnectedOnce();
      }
      const count = Object.keys(data).length;
      logger.info({ monitors: count }, "monitorList received");
      for (const [idStr, monitor] of Object.entries(data)) {
        this._monitors.set(Number(idStr), monitor);
      }
      this.emit("monitorListUpdated", this._monitors);
    });

    this.socket.on("heartbeat", (hb: KumaHeartbeat) => {
      this._lastDataAt = Date.now();
      this._lastHeartbeatAt = Date.now();
      this._eventCounts.heartbeat++;

      const monId = heartbeatMonitorId(hb);
      const prevStatus = this._latestStatus.get(monId);
      this._latestStatus.set(monId, hb.status);

      // Update ping from every heartbeat so the board always shows fresh values
      if (hb.ping !== null && hb.ping !== undefined) {
        this._latestPing.set(monId, hb.ping);
      }

      const monitor = this._monitors.get(monId);
      const name = monitor?.name ?? `?${monId}`;

      logger.info(
        { id: monId, name, status: statusLabel(hb.status), prev: prevStatus !== undefined ? statusLabel(prevStatus) : "none", ping: hb.ping },
        "heartbeat"
      );

      this.emit("heartbeat", hb);

      if (prevStatus !== undefined && prevStatus !== hb.status) {
        this._eventCounts.statusChange++;
        logger.warn(
          { id: monId, name, from: statusLabel(prevStatus), to: statusLabel(hb.status) },
          "STATUS CHANGE"
        );
        if (monitor) {
          this.emit("statusChange", monitor, hb, prevStatus);
        }
      }

      // Clear stale flag if we were stale
      if (this._wasStale) {
        this._wasStale = false;
        logger.info("Heartbeats flowing again after stale period");
        this.emit("dataFresh");
      }
    });

    this.socket.on("heartbeatList", (monitorId: string, beats: KumaHeartbeat[]) => {
      this._lastDataAt = Date.now();
      this._lastHeartbeatListAt = Date.now();
      this._eventCounts.heartbeatList++;

      if (Array.isArray(beats) && beats.length > 0) {
        const last = beats[beats.length - 1];
        this._latestStatus.set(Number(monitorId), last.status);
        const monitor = this._monitors.get(Number(monitorId));
        logger.info(
          { id: monitorId, name: monitor?.name, beats: beats.length, latestStatus: statusLabel(last.status) },
          "heartbeatList"
        );
      }
      this.scheduleStatusUpdate();

      // Clear stale flag
      if (this._wasStale) {
        this._wasStale = false;
        logger.info("HeartbeatList received after stale period");
        this.emit("dataFresh");
      }
    });

    this.socket.on("importantHeartbeatList", (monitorId: string, beats: KumaHeartbeat[]) => {
      this._lastDataAt = Date.now();
      this._lastHeartbeatListAt = Date.now();
      if (Array.isArray(beats) && beats.length > 0) {
        this._latestStatus.set(Number(monitorId), beats[beats.length - 1].status);
      }
      this.scheduleStatusUpdate();
    });

    this.socket.on("avgPing", (monitorId: string, value: number) => {
      this._lastDataAt = Date.now();
      this._eventCounts.avgPing++;
      this._avgPing.set(Number(monitorId), value);
    });

    this.socket.on("uptime", (monitorId: string, value: number) => {
      this._lastDataAt = Date.now();
      this._eventCounts.uptime++;
      this._uptime24h.set(Number(monitorId), value);
    });

    this.socket.on("info", (info: Record<string, unknown>) => {
      this._lastDataAt = Date.now();
      this._eventCounts.info++;
      this._info.version = info.version as string;
      this._info.serverTimezone = info.serverTimezone as string;
      logger.info({ version: this._info.version, tz: this._info.serverTimezone }, "Kuma server info");
    });

    this.startWatchdog();
  }

  // ---------------------------------------------------------------
  // Watchdog - watches HEARTBEAT staleness specifically
  // ---------------------------------------------------------------

  private startWatchdog(): void {
    this.stopWatchdog();

    this._watchdogTimer = setInterval(() => {
      if (!this._authenticated) return;
      const lastHB = this.lastHeartbeatAt;
      if (lastHB === 0) return;

      const staleness = Date.now() - lastHB;

      // Log status every check so we can see it in logs
      const summary = this.getSummary();
      logger.info(
        {
          hbStaleSec: Math.floor(staleness / 1000),
          lastHB: new Date(lastHB).toISOString(),
          up: summary.up,
          down: summary.down,
          events: this._eventCounts,
        },
        "WATCHDOG check"
      );

      if (staleness > HEARTBEAT_TIMEOUT_MS) {
        logger.error(
          { stalenessMs: staleness, reconnects: this._reconnectCount },
          "WATCHDOG: No heartbeats in >90s - forcing reconnect"
        );
        if (!this._wasStale) {
          this._wasStale = true;
          this.emit("dataStale", staleness);
        }
        this.forceReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);

    logger.info(
      { watchdogIntervalMs: WATCHDOG_INTERVAL_MS, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS },
      "Watchdog started"
    );
  }

  private stopWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Force a full disconnect + reconnect.
   * Clears all in-memory state so Kuma re-pushes everything.
   */
  forceReconnect(): void {
    if (!this.socket) return;

    this._reconnectCount++;
    logger.warn({ reconnects: this._reconnectCount }, "Force reconnecting to Kuma");

    this._monitors.clear();
    this._latestStatus.clear();
    this._avgPing.clear();
    this._latestPing.clear();
    this._uptime24h.clear();
    this._lastHeartbeatAt = 0;
    this._lastHeartbeatListAt = 0;
    this._lastDataAt = 0;
    this._authenticated = false;
    this._connected = false;
    this._emittedConnected = false;
    // Reset event counters
    for (const key of Object.keys(this._eventCounts) as Array<keyof typeof this._eventCounts>) {
      this._eventCounts[key] = 0;
    }

    this.socket.disconnect();
    setTimeout(() => {
      if (this.socket) {
        this.socket.connect();
      }
    }, 2_000);
  }

  private authenticate(): void {
    if (!this.socket) return;

    if (this._jwtToken) {
      this.socket.emit("loginByToken", this._jwtToken, (res: { ok: boolean; msg?: string }) => {
        if (res.ok) {
          logger.info("Re-authenticated with saved token");
          this._authenticated = true;
          this._lastDataAt = Date.now();
          this.emitConnectedOnce();
        } else {
          logger.warn({ msg: res.msg }, "Token expired, using password");
          this._jwtToken = null;
          this.loginWithPassword();
        }
      });
    } else {
      this.loginWithPassword();
    }
  }

  private loginWithPassword(): void {
    if (!this.socket) return;
    const config = env();

    this.socket.emit("login", {
      username: config.KUMA_USERNAME,
      password: config.KUMA_PASSWORD,
      token: "",
    }, (res: { ok: boolean; token?: string; msg?: string }) => {
      if (res.ok) {
        logger.info("Authenticated with Uptime Kuma");
        this._jwtToken = res.token ?? null;
        this._authenticated = true;
        this._lastDataAt = Date.now();
        this.emitConnectedOnce();
      } else {
        logger.error({ msg: res.msg }, "Login failed - check KUMA_USERNAME and KUMA_PASSWORD");
      }
    });
  }

  private scheduleStatusUpdate(): void {
    if (this._statusUpdateTimer) clearTimeout(this._statusUpdateTimer);
    this._statusUpdateTimer = setTimeout(() => {
      this._statusUpdateTimer = null;
      this.emit("monitorListUpdated", this._monitors);
    }, 2_000);
  }

  disconnect(): void {
    this.stopWatchdog();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._connected = false;
    this._authenticated = false;
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------

  async pauseMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }> {
    return this.emitAction("pauseMonitor", monitorId);
  }

  async resumeMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }> {
    return this.emitAction("resumeMonitor", monitorId);
  }

  private emitAction(event: string, ...args: unknown[]): Promise<{ ok: boolean; msg?: string }> {
    return new Promise((resolve) => {
      if (!this.socket || !this._authenticated) {
        resolve({ ok: false, msg: "Not connected" });
        return;
      }
      const timeout = setTimeout(() => {
        resolve({ ok: false, msg: "Timeout" });
      }, 10_000);
      this.socket.emit(event, ...args, (res: { ok: boolean; msg?: string }) => {
        clearTimeout(timeout);
        resolve(res);
      });
    });
  }

  // ---------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------

  getSummary(): { total: number; up: number; down: number; pending: number; maintenance: number; paused: number; active: number } {
    let up = 0, down = 0, pending = 0, maintenance = 0, paused = 0;

    for (const [id, monitor] of this._monitors) {
      if (!monitor.active) { paused++; continue; }
      const status = this._latestStatus.get(id);
      switch (status) {
        case MonitorStatus.UP: up++; break;
        case MonitorStatus.DOWN: down++; break;
        case MonitorStatus.PENDING: pending++; break;
        case MonitorStatus.MAINTENANCE: maintenance++; break;
        default: pending++; break;
      }
    }

    const active = this._monitors.size - paused;
    return { total: this._monitors.size, up, down, pending, maintenance, paused, active };
  }

  getDownMonitors(): Array<{ monitor: KumaMonitor; status: number }> {
    const result: Array<{ monitor: KumaMonitor; status: number }> = [];
    for (const [id, monitor] of this._monitors) {
      if (!monitor.active) continue;
      const status = this._latestStatus.get(id);
      if (status === MonitorStatus.DOWN) {
        result.push({ monitor, status });
      }
    }
    return result.sort((a, b) => a.monitor.name.localeCompare(b.monitor.name));
  }

  searchMonitors(query: string, limit = 25): KumaMonitor[] {
    const q = query.toLowerCase();
    return [...this._monitors.values()]
      .filter((m) => m.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);
  }
}

export const kuma = new KumaClient();
