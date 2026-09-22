/**
 * Zammad ticket integration - opens ONE ticket per incident and resolves it
 * on recovery.
 *
 * Optional: active only when ZAMMAD_BASE_URL + ZAMMAD_API_TOKEN are present
 * (env or DB settings via `/sg-setup tickets`). Incidents are keyed
 * (e.g. `sg:site:7`, `sg:unreachable`) and the open ticket id is persisted in
 * the settings table so a bot restart cannot open a duplicate, and so the
 * recovery can find the ticket to annotate/close.
 *
 * Every failure here is logged and swallowed - a broken ticket system must
 * never stop the Discord/email alert from going out.
 */

import { logger } from "../util/logger.js";
import { getSettingOrEnv, getSetting, setSetting, deleteSetting } from "../db/index.js";

const TICKET_KEY_PREFIX = "TICKET_OPEN_";

export interface TicketConfig {
  baseUrl: string;
  token: string;
  group: string;
  customer: string;
  closeOnRecovery: boolean;
}

export function getTicketConfig(): TicketConfig | null {
  const baseUrl = getSettingOrEnv("ZAMMAD_BASE_URL")?.replace(/\/+$/, "");
  const token = getSettingOrEnv("ZAMMAD_API_TOKEN");
  if (!baseUrl || !token) return null;
  if (getSetting("TICKETS_ENABLED") === "false") return null;

  let customer = getSettingOrEnv("ZAMMAD_TICKET_CUSTOMER") ?? "";
  if (!customer) {
    // Zammad requires a customer; "guess:" auto-creates a lightweight account.
    let host = "localhost";
    try { host = new URL(baseUrl).hostname || host; } catch { /* keep default */ }
    customer = `guess:uptime-bot@${host}`;
  } else if (!customer.startsWith("guess:") && customer.includes("@")) {
    customer = `guess:${customer}`;
  }

  return {
    baseUrl,
    token,
    group: getSettingOrEnv("ZAMMAD_TICKET_GROUP") ?? "Users",
    customer,
    closeOnRecovery: getSettingOrEnv("ZAMMAD_TICKET_CLOSE_ON_RECOVERY") !== "false",
  };
}

export function isTicketingConfigured(): boolean {
  return getTicketConfig() !== null;
}

/**
 * When to open API tickets: "fallback" (default) only when the alert email -
 * which itself opens a ticket via the support mailbox - could not be sent;
 * "always" on every incident; "off" never.
 */
export function ticketMode(): "fallback" | "always" | "off" {
  const m = (getSettingOrEnv("ZAMMAD_TICKET_MODE") ?? "fallback").toLowerCase();
  return m === "always" || m === "off" ? m : "fallback";
}

interface OpenTicketRecord {
  id: number;
  number: string;
  opened_at: number;
}

function recordKey(incidentKey: string): string {
  return TICKET_KEY_PREFIX + incidentKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

export function getOpenTicket(incidentKey: string): OpenTicketRecord | null {
  const raw = getSetting(recordKey(incidentKey));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as OpenTicketRecord;
    return rec && typeof rec.id === "number" ? rec : null;
  } catch {
    return null;
  }
}

async function zammad(cfg: TicketConfig, path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Token token=${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zammad API ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const OPEN_STATES = new Set(["new", "open", "pending reminder", "pending close"]);

async function isTicketStillOpen(cfg: TicketConfig, id: number): Promise<boolean> {
  try {
    const t = await zammad(cfg, `/tickets/${id}?expand=true`, { method: "GET" });
    return OPEN_STATES.has(String(t.state ?? "").toLowerCase());
  } catch {
    return true; // unknown: keep the record rather than open a duplicate
  }
}

/**
 * Closes the incident ticket tracked for a key because a human acknowledged
 * the alert by phone. Always closes, regardless of closeOnRecovery: an
 * acknowledgement is a person saying "I have this".
 */
export async function closeIncidentTicketOnAck(incidentKey: string, bodyHtml: string): Promise<OpenTicketRecord | null> {
  const cfg = getTicketConfig();
  const rec = getOpenTicket(incidentKey);
  if (!rec || !cfg) return null;
  deleteSetting(recordKey(incidentKey));
  try {
    await zammad(cfg, `/tickets/${rec.id}`, {
      method: "PUT",
      body: JSON.stringify({
        state: "closed",
        article: { body: bodyHtml, type: "note", internal: true, content_type: "text/html" },
      }),
    });
    logger.info({ incidentKey, ticket: rec.number }, "Closed incident ticket on phone acknowledgement");
    return rec;
  } catch (err) {
    logger.error({ err, incidentKey, ticket: rec.number }, "Failed to close incident ticket on acknowledgement");
    return null;
  }
}

/**
 * Closes open tickets whose title starts with `titlePrefix` and that were
 * created since `sinceEpochMs`. Used for tickets the bot did not open itself,
 * e.g. the "<monitor> Down: ..." emails Uptime Kuma sends to Zammad.
 */
export async function closeMatchingTickets(
  titlePrefix: string,
  sinceEpochMs: number,
  bodyHtml: string
): Promise<OpenTicketRecord[]> {
  const cfg = getTicketConfig();
  if (!cfg) return [];
  const closed: OpenTicketRecord[] = [];
  try {
    const query = `title:"${titlePrefix.replace(/"/g, " ")}" AND state.name:(new OR open OR "pending reminder" OR "pending close")`;
    const found = await zammad(cfg, `/tickets/search?query=${encodeURIComponent(query)}&limit=20&expand=true`, { method: "GET" });
    const list: any[] = Array.isArray(found) ? found : Array.isArray(found?.tickets) ? found.tickets : [];
    for (const t of list) {
      const title = String(t.title ?? "");
      const created = Date.parse(String(t.created_at ?? "")) || 0;
      if (!title.toLowerCase().startsWith(titlePrefix.toLowerCase())) continue;
      if (created && created < sinceEpochMs - 15 * 60_000) continue;
      if (!OPEN_STATES.has(String(t.state ?? "").toLowerCase())) continue;
      await zammad(cfg, `/tickets/${t.id}`, {
        method: "PUT",
        body: JSON.stringify({
          state: "closed",
          article: { body: bodyHtml, type: "note", internal: true, content_type: "text/html" },
        }),
      });
      closed.push({ id: Number(t.id), number: String(t.number ?? t.id), opened_at: Math.floor(created / 1000) });
      logger.info({ ticket: t.number, title }, "Closed matching ticket on phone acknowledgement");
    }
  } catch (err) {
    logger.error({ err, titlePrefix }, "Failed to search/close matching tickets");
  }
  return closed;
}

/** Public URL for humans (ZAMMAD_PUBLIC_URL wins over the API base URL). */
export function ticketUrl(id: number): string {
  const pub = (getSettingOrEnv("ZAMMAD_PUBLIC_URL") ?? getSettingOrEnv("ZAMMAD_BASE_URL") ?? "").replace(/\/+$/, "");
  return pub ? `${pub}/#ticket/zoom/${id}` : `ticket #${id}`;
}

/**
 * Open a ticket for an incident unless one is already open for that key.
 * Returns the ticket record (existing or new), or null if ticketing is off /
 * the API call failed.
 */
export async function openIncidentTicket(
  incidentKey: string,
  title: string,
  bodyHtml: string,
  priority: "1 low" | "2 normal" | "3 high" = "3 high"
): Promise<OpenTicketRecord | null> {
  const cfg = getTicketConfig();
  if (!cfg) return null;

  const existing = getOpenTicket(incidentKey);
  if (existing) {
    // Somebody may have closed it by hand since; a closed ticket must not
    // swallow the next outage's notes.
    if (await isTicketStillOpen(cfg, existing.id)) {
      logger.debug({ incidentKey, ticket: existing.number }, "Incident ticket already open - not creating another");
      return existing;
    }
    logger.info({ incidentKey, ticket: existing.number }, "Tracked incident ticket is closed - opening a new one");
    deleteSetting(recordKey(incidentKey));
  }

  try {
    const ticket = await zammad(cfg, "/tickets", {
      method: "POST",
      body: JSON.stringify({
        title: title.slice(0, 200),
        group: cfg.group,
        customer_id: cfg.customer,
        priority,
        article: {
          subject: title.slice(0, 200),
          body: bodyHtml,
          type: "note",
          internal: false,
          content_type: "text/html",
        },
      }),
    });
    const rec: OpenTicketRecord = {
      id: Number(ticket.id),
      number: String(ticket.number ?? ticket.id),
      opened_at: Math.floor(Date.now() / 1000),
    };
    setSetting(recordKey(incidentKey), JSON.stringify(rec));
    logger.warn({ incidentKey, ticket: rec.number, id: rec.id }, "Opened Zammad incident ticket");
    return rec;
  } catch (err) {
    logger.error({ err, incidentKey }, "Failed to open Zammad incident ticket");
    return null;
  }
}

/**
 * Add a note to an open incident ticket (e.g. reminder that it is still down).
 */
export async function noteIncidentTicket(incidentKey: string, bodyHtml: string): Promise<void> {
  const cfg = getTicketConfig();
  const rec = getOpenTicket(incidentKey);
  if (!cfg || !rec) return;
  try {
    await zammad(cfg, "/ticket_articles", {
      method: "POST",
      body: JSON.stringify({
        ticket_id: rec.id,
        body: bodyHtml,
        type: "note",
        internal: true,
        content_type: "text/html",
      }),
    });
  } catch (err) {
    logger.error({ err, incidentKey, ticket: rec.number }, "Failed to add note to incident ticket");
  }
}

/**
 * Resolve an incident: add a recovery note and (by default) close the ticket.
 * Returns the record that was resolved, or null if none was open.
 */
export async function resolveIncidentTicket(incidentKey: string, bodyHtml: string): Promise<OpenTicketRecord | null> {
  const cfg = getTicketConfig();
  const rec = getOpenTicket(incidentKey);
  if (!rec) return null;
  // Forget the mapping first so a new outage opens a fresh ticket even if the
  // close call below fails.
  deleteSetting(recordKey(incidentKey));
  if (!cfg) return rec;

  try {
    await zammad(cfg, `/tickets/${rec.id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...(cfg.closeOnRecovery ? { state: "closed" } : {}),
        article: {
          body: bodyHtml,
          type: "note",
          internal: true,
          content_type: "text/html",
        },
      }),
    });
    logger.info({ incidentKey, ticket: rec.number, closed: cfg.closeOnRecovery }, "Resolved Zammad incident ticket");
  } catch (err) {
    logger.error({ err, incidentKey, ticket: rec.number }, "Failed to resolve incident ticket");
  }
  return rec;
}

/** Connectivity test used by `/sg-setup tickets`. */
export async function testTicketing(): Promise<{ ok: boolean; message: string }> {
  const cfg = getTicketConfig();
  if (!cfg) return { ok: false, message: "Ticketing is not configured (ZAMMAD_BASE_URL / ZAMMAD_API_TOKEN missing)." };
  try {
    const me = await zammad(cfg, "/users/me", { method: "GET" });
    return { ok: true, message: `Authenticated to Zammad as ${me.login ?? me.email ?? me.id}; tickets will be created in group "${cfg.group}".` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
