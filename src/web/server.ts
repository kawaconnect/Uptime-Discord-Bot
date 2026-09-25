import { timingSafeEqual, createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { kuma, statusLabel } from "../services/kuma.js";
import { siteguard } from "../services/siteguard.js";
import { getSmtpConfig } from "../services/email.js";

/** Constant-time check of "Authorization: Bearer <token>". */
function hasDebugToken(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

/**
 * Builds the HTTP app without listening (tests use app.inject()).
 *
 * /healthz and /readyz are open: the kubelet probes use them. The /debug/*
 * routes expose monitor names, site URLs and SMTP settings, so they are only
 * registered when DEBUG_TOKEN is set, and then require it as a bearer token.
 */
export function buildWebServer(debugToken: string | undefined = env().DEBUG_TOKEN): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    if (!kuma.connected) {
      return reply.code(503).send({ ok: false, error: "Not connected to Uptime Kuma" });
    }
    if (kuma.heartbeatStale) {
      return reply.code(503).send({
        ok: false,
        error: "Heartbeats stale",
        hbStaleSec: kuma.heartbeatStalenessSeconds,
      });
    }
    return { ok: true };
  });

  const token = debugToken?.trim();
  if (token) {
    app.register(async (debug) => {
      debug.addHook("onRequest", async (req, reply) => {
        if (!hasDebugToken(req, token)) {
          return reply.code(401).send({ ok: false, error: "unauthorized" });
        }
      });
      registerDebugRoutes(debug);
    });
  }

  return app;
}

export async function startWebServer(): Promise<FastifyInstance> {
  const app = buildWebServer();
  const port = env().PORT;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, debugEndpoints: !!env().DEBUG_TOKEN?.trim() }, "Web server listening");
  return app;
}

function registerDebugRoutes(app: FastifyInstance): void {
  app.get("/debug/status", async () => {
    const summary = kuma.getSummary();
    const monitors: Record<string, unknown>[] = [];

    for (const [id, monitor] of kuma.monitors) {
      monitors.push({
        id,
        name: monitor.name,
        type: monitor.type,
        active: monitor.active,
        status: kuma.latestStatus.get(id),
        statusLabel: statusLabel(kuma.latestStatus.get(id) ?? -1),
        latestPing: kuma.latestPing.get(id),
        avgPing: kuma.avgPing.get(id),
      });
    }

    return {
      connected: kuma.connected,
      heartbeatStale: kuma.heartbeatStale,
      heartbeatStalenessSeconds: kuma.heartbeatStalenessSeconds,
      lastHeartbeatAt: kuma.lastHeartbeatAt > 0 ? new Date(kuma.lastHeartbeatAt).toISOString() : null,
      lastDataAt: kuma.lastDataAt > 0 ? new Date(kuma.lastDataAt).toISOString() : null,
      reconnectCount: kuma.reconnectCount,
      eventCounts: kuma.eventCounts,
      summary,
      monitors,
      serverInfo: kuma.serverInfo,
    };
  });

  app.get("/debug/siteguard", async () => {
    return {
      reachable: siteguard.reachable,
      lastPoll: siteguard.data?.checked_at ?? null,
      overallStatus: siteguard.data?.status ?? null,
      summary: siteguard.getSummary(),
      sites: siteguard.sites,
      wpVersion: siteguard.data?.version ?? null,
    };
  });

  app.get("/debug/smtp", async () => {
    const config = getSmtpConfig();
    if (!config) return { configured: false };
    return {
      configured: true,
      host: config.host,
      port: config.port,
      secure: config.secure,
      from: config.from,
      to: config.to,
      auth: !!config.user,
    };
  });
}
