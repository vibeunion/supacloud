import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PendingWorkRegistry, PendingWorkTimeoutError, createPendingWorkRegistry } from "./pending_work";

const job = { name: "orders.read", kind: "job" } as const;
test("work results and original errors survive accounting", async () => {
  const work = new PendingWorkRegistry();
  assert.equal(await work.run(job, () => 42), 42);
  const failure = { original: true };
  await assert.rejects(work.run(job, () => { throw failure; }), error => error === failure);
  assert.deepEqual(work.snapshot(), []);
});
test("completion is idempotent and releases all idle waiters", async () => {
  const work = new PendingWorkRegistry();
  const end = work.add(job);
  const a = work.waitForIdle(), b = work.waitForIdle();
  end(); end();
  await Promise.all([a, b]);
  assert.deepEqual(work.snapshot(), []);
});
test("background subscriptions do not block readiness but may block drain", async () => {
  const work = new PendingWorkRegistry();
  const end = work.add({ name: "events.observe", kind: "background" });
  await work.waitForIdle();
  await assert.rejects(work.waitForIdle({ timeoutMs: 0, includeBackground: true }), PendingWorkTimeoutError);
  end();
});
test("cancellation does not conceal unfinished non-cooperative work", async () => {
  const owner = new AbortController();
  const work = new PendingWorkRegistry({ signal: owner.signal });
  const end = work.add(job);
  owner.abort();
  assert.equal(work.signal.aborted, true);
  assert.equal(work.closed, true);
  assert.equal(work.snapshot().length, 1);
  assert.throws(() => work.add(job), /closed/);
  end(); await work.waitForIdle();
});
test("bounded waits report only operation metadata", async () => {
  const work = new PendingWorkRegistry();
  const end = work.add(job);
  await assert.rejects(work.waitForIdle({ timeoutMs: 0 }), error => {
    assert.ok(error instanceof PendingWorkTimeoutError);
    assert.equal(error.pending[0]?.name, "orders.read");
    assert.deepEqual(Object.keys(error.pending[0]!).sort(), ["ageMs", "blocking", "id", "kind", "name"]);
    return true;
  });
  end();
});
test("registration and waiter capacities fail explicitly", async () => {
  const work = new PendingWorkRegistry({ capacity: 1 });
  const end = work.add(job);
  assert.throws(() => work.add(job), /capacity/);
  const waiting = work.waitForIdle();
  await assert.rejects(work.waitForIdle(), /capacity/);
  end(); await waiting;
});
test("aborted waiters are removed and do not cancel registered work", async () => {
  const work = new PendingWorkRegistry({ capacity: 1 });
  const end = work.add(job);
  const signal = new AbortController();
  const waiting = work.waitForIdle({ signal: signal.signal });
  const error = new Error("owner wait cancelled");
  signal.abort(error);
  await assert.rejects(waiting, e => e === error);
  assert.equal(work.signal.aborted, false);
  const next = work.waitForIdle(); end(); await next;
});
test("invalid names and limits never start work", async () => {
  const work = new PendingWorkRegistry();
  assert.throws(() => work.add({ ...job, name: "https://host/?token=secret" }), TypeError);
  for (const capacity of [0, -1, 0.5, Infinity, 65537]) assert.throws(() => new PendingWorkRegistry({ capacity }));
  await assert.rejects(work.waitForIdle({ timeoutMs: Infinity }), RangeError);
});
test("owners and mutable snapshots remain isolated", () => {
  const a = new PendingWorkRegistry(), b = new PendingWorkRegistry();
  const end = a.add(job);
  const snapshot = a.snapshot();
  (snapshot[0] as { name: string }).name = "changed";
  assert.equal(a.snapshot()[0]?.name, job.name);
  assert.deepEqual(b.snapshot(), []);
  end();
});
test("a scope-owned registry unregisters on cancellation", () => {
  const callbacks = new Set<() => void | Promise<void>>();
  const owner = new AbortController();
  const registry = createPendingWorkRegistry({ signal: owner.signal, onDestroy(fn) {
    callbacks.add(fn); return () => { callbacks.delete(fn); };
  } });
  assert.equal(callbacks.size, 1);
  registry.dispose();
  assert.equal(callbacks.size, 0);
});
test("already destroyed owner never registers cleanup or starts work", () => {
  const registry = createPendingWorkRegistry({ destroyed: true, onDestroy() { throw new Error("unexpected"); } });
  assert.throws(() => registry.add(job), /closed/);
});
test("close blocks admission but lets already admitted work settle", async () => {
  const work = new PendingWorkRegistry();
  let complete!: (value: number) => void;
  const running = work.run(job, () => new Promise<number>(resolve => { complete = resolve; }));
  work.close();
  assert.equal(work.snapshot().length, 1);
  assert.equal(work.signal.aborted, false);
  complete(7);
  assert.equal(await running, 7);
  await work.waitForIdle({ includeBackground: true });
});
