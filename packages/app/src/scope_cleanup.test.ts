import { test } from "node:test";
import assert from "node:assert/strict";
import { createCleanupScope } from "./scope_cleanup";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

test("abort is synchronous and precedes cleanup", async () => {
  const scope = createCleanupScope();
  const calls: string[] = [];
  scope.signal.addEventListener("abort", () => calls.push("abort"));
  scope.onDestroy(() => { calls.push("cleanup"); });
  const done = scope.destroy();
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.destroyed, true);
  await done;
  assert.deepEqual(calls, ["abort", "cleanup"]);
});

test("cleanup is awaited in reverse registration order", async () => {
  const scope = createCleanupScope();
  const wait = gate();
  const calls: string[] = [];
  scope.onDestroy(() => { calls.push("first"); });
  scope.onDestroy(async () => { calls.push("last:start"); await wait.promise; calls.push("last:end"); });
  const done = scope.destroy();
  assert.deepEqual(calls, ["last:start"]);
  wait.release();
  await done;
  assert.deepEqual(calls, ["last:start", "last:end", "first"]);
});

test("all failures are retained and do not block later cleanup", async () => {
  const scope = createCleanupScope();
  const failure = new Error("async cleanup");
  let released = false;
  scope.onDestroy(() => { released = true; });
  scope.onDestroy(() => { throw "non-Error failure"; });
  scope.onDestroy(async () => { throw failure; });
  await assert.rejects(scope.destroy(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, "non-Error failure"]);
    return true;
  });
  assert.equal(released, true);
  assert.equal(scope._teardowns.length, 0);
});

test("concurrent destroy calls share completion, not an early success", async () => {
  const scope = createCleanupScope();
  const wait = gate();
  let count = 0;
  scope.onDestroy(async () => { count++; await wait.promise; });
  const first = scope.destroy();
  const second = scope.destroy();
  assert.equal(first, second);
  wait.release();
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal(scope.destroy(), first);
});

test("a repeated failed destroy preserves the same failure", async () => {
  const scope = createCleanupScope();
  scope.onDestroy(() => { throw new Error("failure"); });
  const first = scope.destroy();
  await assert.rejects(first, AggregateError);
  assert.equal(scope.destroy(), first);
  await assert.rejects(scope.destroy(), AggregateError);
});

test("non-awaited reentry from abort and cleanup sees the published promise", async () => {
  const scope = createCleanupScope();
  let fromAbort: Promise<void> | undefined;
  let fromCleanup: Promise<void> | undefined;
  scope.signal.addEventListener("abort", () => { fromAbort = scope.destroy(); });
  scope.onDestroy(() => { fromCleanup = scope.destroy(); });
  const done = scope.destroy();
  await done;
  assert.equal(fromAbort, done);
  assert.equal(fromCleanup, done);
});

test("unregister is idempotent", async () => {
  const scope = createCleanupScope();
  let called = 0;
  const unregister = scope.onDestroy(() => { called++; });
  unregister();
  unregister();
  await scope.destroy();
  assert.equal(called, 0);
});

test("registration after destroy is rejected", async () => {
  const scope = createCleanupScope();
  const done = scope.destroy();
  assert.throws(() => scope.onDestroy(() => {}), /already destroyed/);
  await done;
});

test("scopes never dispose each other's resources", async () => {
  const first = createCleanupScope();
  const second = createCleanupScope();
  let secondCalls = 0;
  second.onDestroy(() => { secondCalls++; });
  await first.destroy();
  assert.equal(second.signal.aborted, false);
  assert.equal(secondCalls, 0);
  await second.destroy();
  assert.equal(secondCalls, 1);
});

test("unregistering one repeated callback does not unregister another", async () => {
  const scope = createCleanupScope();
  let called = 0;
  const callback = () => { called++; };
  const unregister = scope.onDestroy(callback);
  scope.onDestroy(callback);
  unregister();
  unregister();
  await scope.destroy();
  assert.equal(called, 1);
});

test("unregister targets its own registration even for the same callback", async () => {
  const scope = createCleanupScope();
  const calls: string[] = [];
  const repeated = () => { calls.push("repeated"); };
  scope.onDestroy(repeated);
  scope.onDestroy(() => { calls.push("middle"); });
  const removeLast = scope.onDestroy(repeated);
  removeLast();
  await scope.destroy();
  assert.deepEqual(calls, ["middle", "repeated"]);
});
