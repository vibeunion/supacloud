import { test } from "bun:test";
import assert from "node:assert/strict";
import { startBackgroundLeaseHeartbeat } from "../../src/utils/background-lease-heartbeat";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("heartbeats never overlap slow renewals", async () => {
  let calls = 0, active = 0, maximum = 0;
  const stop = startBackgroundLeaseHeartbeat({ intervalMs: 2, onLost: () => assert.fail("unexpected loss"),
    renew: async () => { calls++; active++; maximum = Math.max(maximum, active); await sleep(12); active--; return true; } });
  try { await sleep(50); assert.ok(calls >= 2); assert.equal(maximum, 1); } finally { stop(); await sleep(15); }
});
test("a rejected renewal fails closed exactly once", async () => {
  let lost = 0;
  const stop = startBackgroundLeaseHeartbeat({ intervalMs: 2, renew: async () => { throw new Error("offline"); }, onLost: () => { lost++; } });
  try { await sleep(25); assert.equal(lost, 1); } finally { stop(); }
});
test("a stale renewal stops scheduling", async () => {
  let calls = 0, lost = 0;
  const stop = startBackgroundLeaseHeartbeat({ intervalMs: 2, renew: async () => { calls++; return false; }, onLost: () => { lost++; } });
  try { await sleep(25); assert.equal(calls, 1); assert.equal(lost, 1); } finally { stop(); }
});
test("stopping suppresses an in-flight failure", async () => {
  let reject!: (reason: Error) => void, lost = 0;
  const pending = new Promise<boolean>((_, no) => { reject = no; });
  const stop = startBackgroundLeaseHeartbeat({ intervalMs: 2, renew: () => pending, onLost: () => { lost++; } });
  await sleep(10); stop(); reject(new Error("late failure")); await sleep(10); assert.equal(lost, 0);
});
test("a synchronous renewal exception is handled", async () => {
  let lost = 0;
  const stop = startBackgroundLeaseHeartbeat({ intervalMs: 2, renew: () => { throw new Error("sync"); }, onLost: () => { lost++; } });
  try { await sleep(20); assert.equal(lost, 1); } finally { stop(); }
});
test("invalid heartbeat intervals are rejected", () => {
  for (const intervalMs of [0, -1, NaN, 1.5]) assert.throws(() => startBackgroundLeaseHeartbeat({ intervalMs, renew: async () => true, onLost: () => {} }));
});
