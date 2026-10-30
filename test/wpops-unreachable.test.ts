/**
 * WordPress node reachability alerts: a single failed poll (a network blip)
 * must not alert; only WPOPS_UNREACHABLE_AFTER failures in a row do, once.
 * Recovery is announced only after an alert went out. Connection failures on
 * GETs are retried once, and the alert text names the underlying cause.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  WPOPS_NODES: "web02=https://ops.example.net", WPOPS_TOKEN_WEB02: "t",
  WPOPS_RETRY_DELAY_MS: "0",
});

const { loadEnv, resetEnvForTests } = await import("../src/util/env.js");
resetEnvForTests();
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "bot-wpops-")), "bot.db"));
const { wpops, networkErrorMessage, WPOPS_UNREACHABLE_AFTER } = await import("../src/services/wpops.js");

let down = false;
let calls = 0;
const status = { node: "web02", jobs: { active: [], recent: [] }, backups: {} };
globalThis.fetch = (async (input: string | URL) => {
  calls++;
  if (down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const path = new URL(String(input)).pathname;
  const body = path === "/v1/inventory" ? { origins: {}, sites: [] } : path === "/v1/events" ? { events: [] } : status;
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const seen: string[] = [];
wpops.on("nodeUnreachable", (n: string, msg: string) => seen.push(`down ${n} ${msg}`));
wpops.on("nodeReachable", (n: string) => seen.push(`up ${n}`));

beforeEach(async () => {
  down = false;
  await wpops.poll();
  seen.length = 0;
});

test("threshold defaults to three polls", () => {
  assert.equal(WPOPS_UNREACHABLE_AFTER, 3);
});

test("a single failed poll is a blip: no alert and no recovery message", async () => {
  down = true;
  await wpops.poll();
  down = false;
  await wpops.poll();
  assert.deepEqual(seen, []);
});

test("persistent failure alerts once, then recovery is announced", async () => {
  down = true;
  for (let i = 0; i < WPOPS_UNREACHABLE_AFTER + 2; i++) await wpops.poll();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^down web02 web02: fetch failed \(ECONNRESET\) \(3 checks in a row\)$/);
  down = false;
  await wpops.poll();
  assert.deepEqual(seen.slice(1), ["up web02"]);
});

test("connection failures on GET are retried once", async () => {
  down = true;
  calls = 0;
  await wpops.poll();
  assert.equal(calls, 2);
});

test("network error messages carry the cause", () => {
  assert.equal(networkErrorMessage(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "fetch failed (ENOTFOUND)");
  assert.equal(networkErrorMessage(Object.assign(new Error("x"), { name: "AbortError" })), "timeout");
  assert.equal(networkErrorMessage(new Error("plain")), "plain");
});
