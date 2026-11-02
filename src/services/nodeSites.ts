/**
 * Per-site health reported by WordPress node agents (WPMultisiteDocker wpops,
 * GET /v1/siteguard/health): every single-site stack and every multisite blog
 * on the node, in SiteGuard's health format. The wpops poller writes here and
 * the SiteGuard client merges it with the legacy single SiteGuard endpoint,
 * so a node registers once (its agent token) and its sites come and go as the
 * node reports them. Kept separate from both services to avoid an import cycle.
 */

import { EventEmitter } from "node:events";

/** One site row as the node agent sends it (SiteGuard fields plus node identity). */
export interface NodeSgSite {
  site_id: number;
  uid: string;
  url: string;
  domain: string;
  status: "operational" | "degraded" | "down" | "unknown";
  http_code: number;
  response_time: number;
  ssl_expiry_days: number;
  ssl_issuer: string;
  last_check: number;
  error: string;
  consecutive_failures: number;
  check_method: string;
  ssl_ok?: boolean;
  ssl_error?: string;
  ssl_stale?: boolean;
  ssl_last_success?: number;
  ssl_checked_at?: number;
  ssl_expires_at?: number | string | null;
  node?: string;
  stack?: string;
  blog_id?: number;
  slug?: string | null;
  name?: string;
  mode?: string;
  check_source?: string;
  versions?: { wordpress?: string | null; php?: string | null; siteguard?: string | null };
  last_backup?: number;
}

export interface NodeSgPayload {
  status: string;
  site_url: string;
  node: string;
  checked_at: number;
  check_interval: number;
  check_interval_label: string;
  sites: NodeSgSite[];
  alerts?: { severity: string; type: string; domain?: string; message?: string; site_id?: number; ssl_expiry_days?: number; ssl_last_success?: number }[];
  summary?: Record<string, number>;
  version: string;
  api_version?: number;
  registry_revision?: number;
}

export interface NodeSgEntry {
  node: string;
  payload: NodeSgPayload;
  /** The last poll of this node succeeded (its data is current). */
  ok: boolean;
  updatedAt: number;
}

class NodeSites extends EventEmitter {
  private entries = new Map<string, NodeSgEntry>();

  get size(): number { return this.entries.size; }

  set(node: string, payload: NodeSgPayload): void {
    this.entries.set(node, { node, payload, ok: true, updatedAt: Date.now() });
    this.emit("updated");
  }

  /** The node did not answer: keep its last sites (with their last status), mark them not current. */
  failed(node: string): void {
    const e = this.entries.get(node);
    if (e && e.ok) e.ok = false;
  }

  remove(node: string): void {
    if (this.entries.delete(node)) this.emit("updated");
  }

  /** Forget nodes that are no longer configured. */
  retain(nodes: string[]): void {
    let changed = false;
    for (const name of [...this.entries.keys()]) {
      if (!nodes.includes(name)) { this.entries.delete(name); changed = true; }
    }
    if (changed) this.emit("updated");
  }

  get(node: string): NodeSgEntry | undefined { return this.entries.get(node); }

  all(): NodeSgEntry[] {
    return [...this.entries.values()].sort((a, b) => a.node.localeCompare(b.node));
  }

  clear(): void { this.entries.clear(); }
}

export const nodeSites = new NodeSites();
