import Fastify, { type FastifyInstance } from "fastify";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { kuma, statusLabel } from "../services/kuma.js";
import { siteguard } from "../services/siteguard.js";
import { getSmtpConfig } from "../services/email.js";

export async function startWebServer(): Promise<FastifyInstance> {
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

  const port = env().PORT;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Web server listening");

  return app;
}
