/**
 * WPOPS_SITE_NODES: only the listed nodes have their sites monitored. A node
 * left out (a standby) is still polled for status, but its site registry is
 * not read, so its copies never alert as production sites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  WPOPS_NODES: "prod=https://ops-prod.example.net,standby=https://ops-standby.example.net",
  WPOPS_TOKEN_PROD: "tp", WPOPS_TOKEN_STANDBY: "ts",
  WPOPS_SITE_NODES: "prod",
  WPOPS_RETRY_DELAY_MS: "0", SG_DIRECT_PROBE: "false",
});
delete process.env.SG_HEALTH_URL;
const { loadEnv, resetEnvForTests } = await import("../src/util/env.js");
resetEnvForTests();
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "bot-sitenodes-")), "bot.db"));
const { wpops, monitorsSitesOf } = await import("../src/services/wpops.js");
const { nodeSites } = await import("../src/services/nodeSites.js");

const now = () => Math.floor(Date.now() / 1000);
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const u = new URL(String(input));
  calls.push(`${u.host}${u.pathname}`);
  const name = u.host.startsWith("ops-prod") ? "prod" : "standby";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (u.pathname === "/v1/status") return json({ node: name, version: "0.2.3", stacks: {}, overrides: {}, override_count: 0, tunnels: [], backups: { sets: 0, latest: {}, schedule: {}, disk: {} }, jobs: { active: [], recent: [] }, sites: 1 });
  if (u.pathname === "/v1/inventory") return json({ origins: {}, sites: [] });
  if (u.pathname === "/v1/events") return json({ events: [] });
  if (u.pathname === "/v1/siteguard/health") {
    return json({ status: "operational", site_url: `https://${u.host}`, node: name, checked_at: now(), check_interval: 60,
      check_interval_label: "wpops", version: "wpops 0.2.3", api_version: 2, registry_revision: 1,
      sites: [{ site_id: 1, uid: `${name}:shop:1`, url: "https://shop.example.com/", domain: "shop.example.com", status: "operational",
        http_code: 200, response_time: 0.1, ssl_expiry_days: -1, ssl_issuer: "", last_check: now(), error: "", consecutive_failures: 0,
        check_method: "wpops-direct", node: name, stack: "shop", blog_id: 1, slug: "shop" }] });
  }
  return json({});
}) as typeof fetch;

test("only listed nodes have their sites monitored", async () => {
  assert.equal(monitorsSitesOf("prod"), true);
  assert.equal(monitorsSitesOf("standby"), false);
  await wpops.poll();
  assert.equal(nodeSites.get("prod")?.payload.sites.length, 1);
  assert.equal(nodeSites.get("standby"), undefined);
  assert.ok(calls.includes("ops-prod.example.net/v1/siteguard/health"));
  assert.ok(!calls.includes("ops-standby.example.net/v1/siteguard/health"));
  // The standby node is still polled for status.
  assert.ok(calls.includes("ops-standby.example.net/v1/status"));
  assert.equal(wpops.snapshots.get("standby")?.registry, false);
});
