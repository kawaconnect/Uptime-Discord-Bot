import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "silent",
  DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "1", KUMA_URL: "http://127.0.0.1:9",
  PHONE_ESCALATION_ENABLED: "true", PBX_ALERT_URL: "http://pbx.invalid", PBX_ALERT_TOKEN: "test-only",
});
const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const db = await import("../src/db/index.js");
db.initDb(join(mkdtempSync(join(tmpdir(), "phone-escalation-")), "bot.db"));
const { kuma, MonitorStatus } = await import("../src/services/kuma.js");
const { planPhoneEscalation } = await import("../src/services/phoneMonitors.js");
const { runEscalationSweep } = await import("../src/services/alerts.js");
const { markDown, trackedKeys } = await import("../src/services/phone.js");
type KumaMonitor = import("../src/services/kuma.js").KumaMonitor;

const leaf: KumaMonitor = {
  id: 32, name: "Site router", type: "ping", url: "", hostname: "", port: null,
  active: true, interval: 60, description: "", tags: [], parent: 83, maintenance: false, maxretries: 0,
};
const group: KumaMonitor = { ...leaf, id: 83, name: "Site", type: "group", parent: null };
const monitors = new Map([[32, leaf], [83, group]]);
const tracked = ["kuma:monitor:32", "kuma:monitor:83", "sg:site:10"];

test("unknown and pending snapshot states cannot resolve acknowledged incidents", () => {
  for (const snapshot of [new Map<number, number>(), new Map([[32, MonitorStatus.PENDING]])]) {
    assert.deepEqual(planPhoneEscalation(monitors, snapshot, tracked, () => false), { report: [], resolve: [] });
  }
  assert.deepEqual(planPhoneEscalation(new Map(), new Map(), tracked, () => false), { report: [], resolve: [] });
});

test("only leaf monitors call; confirmed recovery and deliberate pauses still clear them", () => {
  const plan = planPhoneEscalation(monitors, new Map([[32, 0], [83, 0]]), tracked, () => false);
  assert.deepEqual(plan.report.map(m => m.id), [32]);
  assert.deepEqual(plan.resolve, []);
  for (const status of [MonitorStatus.UP, MonitorStatus.MAINTENANCE]) {
    assert.deepEqual(planPhoneEscalation(monitors, new Map([[32, status]]), tracked, () => false).resolve, [tracked[0]]);
  }
  assert.deepEqual(planPhoneEscalation(monitors, new Map([[32, 0]]), tracked, id => id === 32), { report: [], resolve: [tracked[0]] });
});

test("a no-phone tagged monitor never calls and clears a call already running", () => {
  const exempt: KumaMonitor = { ...leaf, id: 40, tags: [{ id: 1, name: " No-Phone ", color: "#000", value: "" }] };
  const all = new Map<number, KumaMonitor>([[32, leaf], [40, exempt]]);
  const plan = planPhoneEscalation(all, new Map([[32, 0], [40, 0]]), ["kuma:monitor:40"], () => false);
  assert.deepEqual(plan.report.map(m => m.id), [32]);
  assert.deepEqual(plan.resolve, ["kuma:monitor:40"]);
});

test("a monitor deleted from Kuma resolves its escalation instead of calling again", () => {
  // Monitor 87 was DOWN with an open escalation, then deleted from Kuma.
  const trackedDeleted = ["kuma:monitor:87", "kuma:monitor:32", "sg:site:10"];
  const plan = planPhoneEscalation(monitors, new Map([[32, MonitorStatus.DOWN]]), trackedDeleted, () => false);
  assert.deepEqual(plan.resolve, ["kuma:monitor:87"]);
  assert.deepEqual(plan.report.map(m => m.id), [32]);
  // Without a monitor list (not connected yet) nothing counts as deleted.
  assert.deepEqual(planPhoneEscalation(new Map(), new Map(), trackedDeleted, () => false).resolve, []);
});

test("real sweep preserves a PBX acknowledgement across repeated reconnects and rearms on actual UP", async () => {
  const originalFetch = globalThis.fetch;
  const incidents = new Map<string, boolean>([[tracked[0], true]]);
  const calls: Array<{ path: string; key: string }> = [];
  let rings = 0;
  let failResolve = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const { key } = JSON.parse(String(init?.body)) as { key: string };
    calls.push({ path, key });
    if (path === "/resolve") {
      if (failResolve) return new Response(null, { status: 503 });
      incidents.delete(key); return Response.json({ cleared: true });
    }
    if (incidents.get(key)) return Response.json({ called: false, reason: "acknowledged", acknowledged_by: "test human", acknowledged_at: 1 });
    incidents.set(key, false); rings++;
    return Response.json({ called: true });
  };
  Object.defineProperty(kuma, "connected", { configurable: true, value: true });
  try {
    kuma.monitors.clear(); kuma.latestStatus.clear();
    kuma.monitors.set(32, leaf); kuma.monitors.set(83, group);
    markDown(tracked[0]); markDown(tracked[1]);
    for (let cycle = 0; cycle < 12; cycle++) {
      kuma.monitors.clear(); kuma.latestStatus.clear();
      await runEscalationSweep();
      kuma.monitors.set(32, leaf); kuma.monitors.set(83, group);
      await runEscalationSweep();
      kuma.latestStatus.set(32, MonitorStatus.PENDING);
      await runEscalationSweep();
      kuma.latestStatus.set(32, MonitorStatus.DOWN); kuma.latestStatus.set(83, MonitorStatus.DOWN);
      await runEscalationSweep();
    }
    assert.equal(rings, 0, "An acknowledged outage must never ring again after reconnecting");
    assert.equal(incidents.get(tracked[0]), true);
    assert.equal(calls.some(c => c.path === "/resolve"), false);
    assert.equal(calls.some(c => c.key === tracked[1]), false, "Parent groups must not create duplicate calls");
    kuma.latestStatus.set(32, MonitorStatus.UP);
    failResolve = true;
    await runEscalationSweep();
    assert.equal(incidents.get(tracked[0]), true, "Failed recovery requests must preserve the server acknowledgement");
    assert.ok(trackedKeys().includes(tracked[0]), "Failed recovery requests must remain queued for retry");
    failResolve = false;
    await runEscalationSweep();
    assert.equal(incidents.has(tracked[0]), false);
    kuma.latestStatus.set(32, MonitorStatus.DOWN);
    await runEscalationSweep();
    assert.equal(rings, 1, "A genuinely new outage must still call");
  } finally {
    globalThis.fetch = originalFetch;
    kuma.monitors.clear(); kuma.latestStatus.clear();
    Reflect.deleteProperty(kuma, "connected");
  }
});
