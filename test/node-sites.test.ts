/**
 * Sites reported by WordPress node agents (GET /v1/siteguard/health): a node
 * registers once and every site on it is monitored; sites come and go as the
 * node reports them; ids never collide with a multisite's blog ids; older
 * agents (404) and the legacy single endpoint keep working; events are read
 * by sequence number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  WPOPS_NODES: "node-a=https://ops-a.example.net,node-old=https://ops-old.example.net",
  WPOPS_TOKEN_NODE_A: "ta", WPOPS_TOKEN_NODE_OLD: "to",
  WPOPS_RETRY_DELAY_MS: "0", SG_DIRECT_PROBE: "false",
});
delete process.env.SG_HEALTH_URL;
const { loadEnv, resetEnvForTests } = await import("../src/util/env.js");
resetEnvForTests();
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "bot-nodesites-")), "bot.db"));
const { wpops } = await import("../src/services/wpops.js");
const { siteguard, mergeSgPayloads, NODE_SITE_ID_BASE, sgSiteSource } = await import("../src/services/siteguard.js");
const { nodeSites } = await import("../src/services/nodeSites.js");

const now = () => Math.floor(Date.now() / 1000);
const row = (site_id: number, uid: string, url: string, status = "operational", extra: Record<string, unknown> = {}) => ({
  site_id, uid, url, domain: new URL(url).hostname, status, http_code: status === "down" ? 502 : 200, response_time: 0.1,
  ssl_expiry_days: -1, ssl_issuer: "", last_check: now(), error: status === "down" ? "HTTP 502" : "",
  consecutive_failures: status === "down" ? 1 : 0, check_method: "wpops-direct", check_source: "direct",
  node: "node-a", stack: uid.split(":")[1], blog_id: Number(uid.split(":")[2]), slug: null, ...extra,
});
let nodeRows = [
  row(1, "node-a:shop:1", "https://shop.example.com/", "operational", { slug: "shop" }),
  row(2, "node-a:net:1", "https://net.example.net/"),
  row(3, "node-a:net:2", "https://news.example.com/", "operational", { slug: "news" }),
];
let events: { ts: number; seq: number; kind: string }[] = [{ ts: now() - 100, seq: 7, kind: "registry.site_added" }];
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const u = new URL(String(input));
  calls.push(`${u.host}${u.pathname}${u.search}`);
  const old = u.host.startsWith("ops-old");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.pathname === "/v1/status") return json({ node: old ? "node-old" : "node-a", version: "0.2.0", stacks: {}, overrides: {}, override_count: 0, tunnels: [], backups: { sets: 0, latest: {}, schedule: {}, disk: {} }, jobs: { active: [], recent: [] }, sites: 0 });
  if (u.pathname === "/v1/inventory") return json({ origins: {}, sites: [{ slug: "shop", name: "Shop", primary: "node-a", cf_account: "c", domains: ["shop.example.com"], hosts: {}, enabled: true }] });
  if (u.pathname === "/v1/events") {
    if (old) return json({ events: [] });
    const after = u.searchParams.get("after");
    return json({ events: after === null ? events.slice(-100) : events.filter((e) => e.seq > Number(after)) });
  }
  if (u.pathname === "/v1/siteguard/health") {
    if (old) return json({ error: "not found" }, 404);
    return json({ status: "operational", site_url: "https://ops-a.example.net", node: "node-a", checked_at: now(), check_interval: 60,
      check_interval_label: "wpops", sites: nodeRows, alerts: [], version: "wpops 0.2.0", api_version: 2, registry_revision: 3 });
  }
  return json({ error: "not found" }, 404);
}) as typeof fetch;

const downs: number[] = [];
const ups: number[] = [];
siteguard.on("siteDown", (s: { site_id: number }) => downs.push(s.site_id));
siteguard.on("siteRecovery", (s: { site_id: number }) => ups.push(s.site_id));
const changes: string[] = [];
wpops.on("sitesChanged", (node: string, added: { uid: string }[], removed: { uid: string }[]) =>
  changes.push(`${node} +${added.map((s) => s.uid).join(",")} -${removed.map((s) => s.uid).join(",")}`));

test("merge keeps legacy rows as they are and gives node sites ids above the blog ids", () => {
  const legacy = { status: "operational", site_url: "https://wp.example.com", checked_at: now() - 60, check_interval: 600,
    check_interval_label: "every10min", version: "1.6.4", api_version: 2,
    sites: [row(1, "x", "https://a.example.com/"), row(2, "x", "https://b.example.com/")] as any, alerts: [] };
  const ids: Record<string, number> = {};
  const idFor = (n: string, uid: string) => (ids[`${n}|${uid}`] ??= NODE_SITE_ID_BASE + Object.keys(ids).length);
  const entry = { node: "node-a", ok: true, updatedAt: Date.now(), payload: { status: "degraded", site_url: "", node: "node-a",
    checked_at: now(), check_interval: 60, check_interval_label: "wpops", version: "wpops 0.2.0",
    sites: [row(1, "node-a:shop:1", "https://shop.example.com/", "down")] as any,
    alerts: [{ severity: "critical", type: "site_down", domain: "shop.example.com", site_id: 1 }] } };
  const m = mergeSgPayloads(legacy, [entry], true, idFor);
  assert.deepEqual(m.sites.slice(0, 2), legacy.sites);
  assert.equal(m.sites[2].site_id, NODE_SITE_ID_BASE);
  assert.equal(m.sites[2].source, "node");
  assert.equal(m.alerts!.at(-1)!.site_id, NODE_SITE_ID_BASE);
  assert.equal(m.status, "degraded");
  assert.equal(m.checked_at, legacy.checked_at);
  assert.deepEqual(m.sources!.map((s) => [s.kind, s.name, s.sites]), [["legacy", "wp.example.com", 2], ["node", "node-a", 1]]);
  // An unreachable legacy endpoint does not make the merged data look stale.
  assert.equal(mergeSgPayloads(legacy, [entry], false, idFor).checked_at, entry.payload.checked_at);
  assert.match(sgSiteSource(m.sites[2]), /node node-a \(stack shop\), agent direct check/);
});

test("a node registers once: its sites are monitored without a legacy endpoint", async () => {
  assert.equal(siteguard.isConfigured, false);
  siteguard.enableNodeAutostart();
  await wpops.poll();
  assert.equal(siteguard.started, true);
  const sites = siteguard.sitesOf("node-a");
  assert.deepEqual(sites.map((s) => s.uid), ["node-a:shop:1", "node-a:net:1", "node-a:net:2"]);
  assert.ok(sites.every((s) => s.site_id >= NODE_SITE_ID_BASE));
  assert.equal(new Set(sites.map((s) => s.site_id)).size, 3);
  assert.equal(wpops.snapshots.get("node-old")!.registry, false, "older agent: 404, no sites, no error");
  assert.equal(siteguard.sitesOf("node-old").length, 0);
  assert.equal(changes.length, 0, "first report is not announced as changes");
});

test("down and recovery are announced per node site; ids stay stable", async () => {
  const shopId = siteguard.sitesOf("node-a")[0].site_id;
  nodeRows = nodeRows.map((r) => (r.uid === "node-a:shop:1" ? { ...r, status: "down", error: "HTTP 502" } : r));
  await wpops.poll();
  assert.deepEqual(downs, [shopId]);
  assert.equal(siteguard.sitesOf("node-a")[0].site_id, shopId);
  assert.deepEqual(wpops.downSiteSlugs().map((d) => d.slug), ["shop"]);
  nodeRows = nodeRows.map((r) => (r.uid === "node-a:shop:1" ? { ...r, status: "operational", error: "" } : r));
  await wpops.poll();
  assert.deepEqual(ups, [shopId]);
});

test("sites added to or removed from the node follow automatically", async () => {
  const before = new Map(siteguard.sitesOf("node-a").map((s) => [s.uid, s.site_id]));
  nodeRows = [...nodeRows.filter((r) => r.uid !== "node-a:net:2"), row(9, "node-a:blog:1", "https://blog.example.com/")];
  await wpops.poll();
  assert.deepEqual(changes, ["node-a +node-a:blog:1 -node-a:net:2"]);
  const after = siteguard.sitesOf("node-a");
  assert.deepEqual(after.map((s) => s.uid), ["node-a:shop:1", "node-a:net:1", "node-a:blog:1"]);
  assert.equal(after[0].site_id, before.get("node-a:shop:1"));
  assert.ok(!after.some((s) => s.site_id === before.get("node-a:net:2")));
  assert.ok(![...before.values()].includes(after[2].site_id), "a new site never reuses an id");
});

test("a node that stops answering keeps its last sites; removing it drops them", async () => {
  nodeSites.failed("node-a");
  assert.equal(siteguard.sitesOf("node-a").length, 3);
  nodeSites.remove("node-a");
  assert.equal(siteguard.sitesOf("node-a").length, 0);
});

test("events are read by sequence number once the agent numbers them", async () => {
  calls.length = 0;
  events = [...events, { ts: now(), seq: 8, kind: "backup.pulled" }, { ts: now(), seq: 9, kind: "backup.pulled" }];
  const seen: number[] = [];
  const onEv = (_n: string, ev: { seq: number }) => seen.push(ev.seq);
  wpops.on("event", onEv);
  await wpops.poll();
  wpops.off("event", onEv);
  assert.ok(calls.some((c) => c.includes("/v1/events?after=")), calls.join(" "));
  assert.deepEqual(seen, [8, 9]);
  siteguard.stop();
  wpops.stop();
});
