/**
 * Socket events the Kuma client treats as known: the ones it handles, plus
 * the Kuma 2.x admin lists and the very frequent `domainInfo` it ignores, so
 * they no longer flood the log as "Unknown socket event received".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_SOCKET_EVENTS } from "../src/services/kuma.js";

test("covers the events the bot handles", () => {
  for (const e of ["monitorList", "heartbeat", "heartbeatList", "importantHeartbeatList", "autoLogin"]) {
    assert.ok(KNOWN_SOCKET_EVENTS.has(e), e);
  }
});

test("treats Kuma 2.x admin lists and domainInfo as known", () => {
  for (const e of ["domainInfo", "maintenanceList", "notificationList", "statusPageList", "apiKeyList"]) {
    assert.ok(KNOWN_SOCKET_EVENTS.has(e), e);
  }
});

test("still reports genuinely new events", () => {
  assert.equal(KNOWN_SOCKET_EVENTS.has("somethingNew"), false);
});
