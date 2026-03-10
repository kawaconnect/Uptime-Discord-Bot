import Fastify, { type FastifyInstance } from "fastify";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { kuma } from "../services/kuma.js";

export async function startWebServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Liveness probe
  app.get("/healthz", async () => ({ ok: true }));

  // Readiness probe - checks Kuma connectivity
  app.get("/readyz", async (_req, reply) => {
    if (kuma.connected) {
      return { ok: true };
    }
    return reply.code(503).send({ ok: false, error: "Not connected to Uptime Kuma" });
  });

  // Debug endpoint: current monitor summary
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
        avgPing: kuma.avgPing.get(id),
      });
    }

    return {
      connected: kuma.connected,
      summary,
      monitors,
      serverInfo: kuma.serverInfo,
    };
  });

  const port = env().PORT;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Web server listening");

  return app;
}
