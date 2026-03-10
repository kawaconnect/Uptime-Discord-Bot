/**
 * Uptime Kuma Socket.IO client - maintains a persistent connection,
 * tracks all monitor states in memory, and emits events for status changes.
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
}

export interface KumaHeartbeat {
  id: number;
  monitor_id: number;
  status: number; // 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE
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
    case MonitorStatus.UP: return "\u{1F7E2}"; // green circle
    case MonitorStatus.DOWN: return "\u{1F534}"; // red circle
    case MonitorStatus.PENDING: return "\u{1F7E1}"; // yellow circle
    case MonitorStatus.MAINTENANCE: return "\u{1F535}"; // blue circle
    default: return "\u26AA"; // white circle
  }
}

// ---------------------------------------------------------------
// Kuma Client
// ---------------------------------------------------------------

export interface KumaEvents {
  connected: [];
  disconnected: [reason: string];
  monitorListUpdated: [monitors: Map<number, KumaMonitor>];
  statusChange: [monitor: KumaMonitor, heartbeat: KumaHeartbeat, previousStatus: number | undefined];
  heartbeat: [heartbeat: KumaHeartbeat];
}

class KumaClient extends EventEmitter {
  private socket: Socket | null = null;
  private _monitors = new Map<number, KumaMonitor>();
  private _latestStatus = new Map<number, number>(); // monitorId -> last known status
  private _avgPing = new Map<number, number>();
  private _uptime = new Map<number, number>();
  private _connected = false;
  private _authenticated = false;
  private _jwtToken: string | null = null;
  private _reconnectAttempts = 0;
  private _info: { version?: string; serverTimezone?: string } = {};

  get monitors(): Map<number, KumaMonitor> {
    return this._monitors;
  }

  get latestStatus(): Map<number, number> {
    return this._latestStatus;
  }

  get avgPing(): Map<number, number> {
    return this._avgPing;
  }

  get uptimeMap(): Map<number, number> {
    return this._uptime;
  }

  get connected(): boolean {
    return this._connected && this._authenticated;
  }

  get serverInfo() {
    return this._info;
  }

  connect(): void {
    const config = env();
    logger.info({ url: config.KUMA_URL }, "Connecting to Uptime Kuma");

    this.socket = io(config.KUMA_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
    });

    this.socket.on("connect", () => {
      logger.info("Socket.IO connected to Uptime Kuma");
      this._connected = true;
      this._reconnectAttempts = 0;
      this.authenticate();
    });

    this.socket.on("disconnect", (reason) => {
      logger.warn({ reason }, "Disconnected from Uptime Kuma");
      this._connected = false;
      this._authenticated = false;
      this.emit("disconnected", reason);
    });

    this.socket.on("connect_error", (err) => {
      this._reconnectAttempts++;
      logger.error({ err: err.message, attempts: this._reconnectAttempts }, "Uptime Kuma connection error");
    });

    // Data events
    this.socket.on("monitorList", (data: Record<string, KumaMonitor>) => {
      for (const [idStr, monitor] of Object.entries(data)) {
        this._monitors.set(Number(idStr), monitor);
      }
      this.emit("monitorListUpdated", this._monitors);
    });

    this.socket.on("heartbeat", (hb: KumaHeartbeat) => {
      const prevStatus = this._latestStatus.get(hb.monitor_id);
      this._latestStatus.set(hb.monitor_id, hb.status);
      this.emit("heartbeat", hb);

      if (hb.important && prevStatus !== undefined && prevStatus !== hb.status) {
        const monitor = this._monitors.get(hb.monitor_id);
        if (monitor) {
          this.emit("statusChange", monitor, hb, prevStatus);
        }
      }
    });

    this.socket.on("heartbeatList", (data: Record<string, KumaHeartbeat[]>) => {
      for (const [idStr, beats] of Object.entries(data)) {
        const monitorId = Number(idStr);
        if (beats.length > 0) {
          this._latestStatus.set(monitorId, beats[beats.length - 1].status);
        }
      }
    });

    this.socket.on("avgPing", (data: Record<string, number>) => {
      for (const [idStr, val] of Object.entries(data)) {
        this._avgPing.set(Number(idStr), val);
      }
    });

    this.socket.on("uptime", (data: Record<string, number>) => {
      for (const [idStr, val] of Object.entries(data)) {
        this._uptime.set(Number(idStr), val);
      }
    });

    this.socket.on("info", (info: Record<string, unknown>) => {
      this._info.version = info.version as string;
      this._info.serverTimezone = info.serverTimezone as string;
      logger.info({ version: this._info.version }, "Uptime Kuma server info");
    });

    this.socket.on("autoLogin", () => {
      logger.info("Uptime Kuma auto-login (no auth required)");
      this._authenticated = true;
      this.emit("connected");
    });
  }

  private authenticate(): void {
    if (!this.socket) return;

    // Try token-based reconnection first
    if (this._jwtToken) {
      this.socket.emit("loginByToken", this._jwtToken, (res: { ok: boolean; msg?: string }) => {
        if (res.ok) {
          logger.info("Re-authenticated with saved token");
          this._authenticated = true;
          this.emit("connected");
        } else {
          logger.warn({ msg: res.msg }, "Token login failed, falling back to password");
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
        logger.error({ msg: res.msg }, "Uptime Kuma login failed");
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

  /** Get a summary of current monitor states. */
  getSummary(): { total: number; up: number; down: number; pending: number; maintenance: number; paused: number } {
    let up = 0, down = 0, pending = 0, maintenance = 0, paused = 0;

    for (const [id, monitor] of this._monitors) {
      if (!monitor.active) {
        paused++;
        continue;
      }
      const status = this._latestStatus.get(id);
      switch (status) {
        case MonitorStatus.UP: up++; break;
        case MonitorStatus.DOWN: down++; break;
        case MonitorStatus.PENDING: pending++; break;
        case MonitorStatus.MAINTENANCE: maintenance++; break;
        default: pending++; break; // unknown = pending
      }
    }

    return { total: this._monitors.size, up, down, pending, maintenance, paused };
  }
}

// Singleton
export const kuma = new KumaClient();
