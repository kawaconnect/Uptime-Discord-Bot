/**
 * Uptime Kuma Socket.IO client - persistent real-time connection.
 *
 * Uptime Kuma exposes its API exclusively via Socket.IO (not REST).
 * Authentication requires username/password; API keys (uk1_xxx) are
 * REST-only (/metrics endpoint) and cannot be used here.
 *
 * After login the server pushes all state automatically:
 *   monitorList, heartbeatList, importantHeartbeatList, avgPing, uptime, info
 * Then sends real-time `heartbeat` events for every check.
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
  id: number;
  monitor_id: number;
  status: number;
  time: string;
  msg: string;
  ping: number | null;
  important: boolean;
  duration: number;
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
}

// ---------------------------------------------------------------
// Client
// ---------------------------------------------------------------

class KumaClient extends EventEmitter {
  private socket: Socket | null = null;
  private _monitors = new Map<number, KumaMonitor>();
  private _latestStatus = new Map<number, number>();
  private _avgPing = new Map<number, number>();
  private _uptime24h = new Map<number, number>();
  private _connected = false;
  private _authenticated = false;
  private _jwtToken: string | null = null;
  private _info: { version?: string; serverTimezone?: string } = {};
  private _lastHeartbeatAt = 0;

  get monitors(): Map<number, KumaMonitor> { return this._monitors; }
  get latestStatus(): Map<number, number> { return this._latestStatus; }
  get avgPing(): Map<number, number> { return this._avgPing; }
  get uptime24h(): Map<number, number> { return this._uptime24h; }
  get connected(): boolean { return this._connected && this._authenticated; }
  get serverInfo() { return this._info; }
  get lastHeartbeatAt(): number { return this._lastHeartbeatAt; }

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

    this.socket.on("connect", () => {
      logger.info("Socket.IO connected");
      this._connected = true;
      // If credentials are configured, authenticate. Otherwise wait for autoLogin.
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
      if (wasAuthenticated) {
        this.emit("disconnected", reason);
      }
    });

    this.socket.on("connect_error", (err) => {
      logger.error({ err: err.message }, "Connection error");
    });

    // Auto-login (auth disabled on Kuma side)
    this.socket.on("autoLogin", () => {
      logger.info("Auto-login (no auth required)");
      this._authenticated = true;
      this.emit("connected");
    });

    // ---- Data events (pushed automatically after login) ----

    this.socket.on("monitorList", (data: Record<string, KumaMonitor>) => {
      // If we receive data, we're authenticated (even without explicit autoLogin)
      if (!this._authenticated) {
        logger.info("Received data - implicitly authenticated");
        this._authenticated = true;
        this.emit("connected");
      }
      for (const [idStr, monitor] of Object.entries(data)) {
        this._monitors.set(Number(idStr), monitor);
      }
      this.emit("monitorListUpdated", this._monitors);
    });

    this.socket.on("heartbeat", (hb: KumaHeartbeat) => {
      this._lastHeartbeatAt = Date.now();
      const prevStatus = this._latestStatus.get(hb.monitor_id);
      this._latestStatus.set(hb.monitor_id, hb.status);
      this.emit("heartbeat", hb);

      // Detect status changes
      if (prevStatus !== undefined && prevStatus !== hb.status) {
        const monitor = this._monitors.get(hb.monitor_id);
        if (monitor) {
          this.emit("statusChange", monitor, hb, prevStatus);
        }
      }
    });

    this.socket.on("heartbeatList", (data: Record<string, KumaHeartbeat[]>) => {
      for (const [idStr, beats] of Object.entries(data)) {
        if (beats.length > 0) {
          this._latestStatus.set(Number(idStr), beats[beats.length - 1].status);
        }
      }
      // Re-emit so presence/status board recalculates with actual status data
      this.emit("monitorListUpdated", this._monitors);
    });

    this.socket.on("importantHeartbeatList", (data: Record<string, KumaHeartbeat[]>) => {
      for (const [idStr, beats] of Object.entries(data)) {
        if (beats.length > 0) {
          this._latestStatus.set(Number(idStr), beats[beats.length - 1].status);
        }
      }
      this.emit("monitorListUpdated", this._monitors);
    });

    this.socket.on("avgPing", (data: Record<string, number>) => {
      for (const [idStr, val] of Object.entries(data)) {
        this._avgPing.set(Number(idStr), val);
      }
    });

    this.socket.on("uptime", (data: Record<string, number>) => {
      for (const [idStr, val] of Object.entries(data)) {
        this._uptime24h.set(Number(idStr), val);
      }
    });

    this.socket.on("info", (info: Record<string, unknown>) => {
      this._info.version = info.version as string;
      this._info.serverTimezone = info.serverTimezone as string;
      logger.info({ version: this._info.version, tz: this._info.serverTimezone }, "Uptime Kuma server info");
    });
  }

  private authenticate(): void {
    if (!this.socket) return;

    if (this._jwtToken) {
      this.socket.emit("loginByToken", this._jwtToken, (res: { ok: boolean; msg?: string }) => {
        if (res.ok) {
          logger.info("Re-authenticated with saved token");
          this._authenticated = true;
          this.emit("connected");
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
        this.emit("connected");
      } else {
        logger.error({ msg: res.msg }, "Login failed - check KUMA_USERNAME and KUMA_PASSWORD");
      }
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._connected = false;
    this._authenticated = false;
  }

  // ---------------------------------------------------------------
  // Actions (emit commands to Kuma)
  // ---------------------------------------------------------------

  async pauseMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }> {
    return this.emitAction("pauseMonitor", monitorId);
  }

  async resumeMonitor(monitorId: number): Promise<{ ok: boolean; msg?: string }> {
    return this.emitAction("resumeMonitor", monitorId);
  }

  private emitAction(event: string, ...args: unknown[]): Promise<{ ok: boolean; msg?: string }> {
    return new Promise((resolve, reject) => {
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

  /** Find monitors by name (case-insensitive partial match). */
  searchMonitors(query: string, limit = 25): KumaMonitor[] {
    const q = query.toLowerCase();
    return [...this._monitors.values()]
      .filter((m) => m.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Exact start match first
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);
  }
}

export const kuma = new KumaClient();
