import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runCleanup, withCleanup } from "./lifecycle-cleanup";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cleanup waits for a dependent before releasing its dependency", async () => {
  const released = deferred();
  const entered = deferred();
  const events: string[] = [];
  const cleanup = runCleanup([
    async () => {
      events.push("dependent:start");
      entered.resolve();
      await released.promise;
      events.push("dependent:end");
    },
    () => { events.push("dependency"); },
  ], "cleanup failed");
  await entered.promise;
  assert.deepEqual(events, ["dependent:start"]);
  released.resolve();
  await cleanup;
  assert.deepEqual(events, ["dependent:start", "dependent:end", "dependency"]);
});

test("synchronous cleanup phases do not postpone cancellation", async () => {
  const cancellation = new AbortController();
  const cleanup = runCleanup([
    () => {},
    () => { cancellation.abort(); },
  ], "cleanup failed");
  assert.equal(cancellation.signal.aborted, true);
  await cleanup;
});

test("cleanup continues after sync and async failures and retains their order", async () => {
  const first = new Error("first");
  const second = new Error("second");
  let released = false;
  await assert.rejects(runCleanup([
    () => { throw first; },
    async () => { throw second; },
    () => { released = true; },
  ], "cleanup failed"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    assert.equal(error.message, "cleanup failed");
    return true;
  });
  assert.equal(released, true);
});

test("cleanup keeps a single failure aggregated for the injector contract", async () => {
  const failure = new Error("single");
  await assert.rejects(runCleanup([() => { throw failure; }], "cleanup failed"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
});

test("empty cleanup succeeds", async () => { await runCleanup([], "unused"); });

test("cleanup preserves non-Error failures", async () => {
  await assert.rejects(runCleanup([() => { throw undefined; }, () => { throw null; }], "failed"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [undefined, null]);
    return true;
  });
});

test("successful work returns the original value only after cleanup completes", async () => {
  const release = deferred();
  const entered = deferred();
  const value = {};
  let settled = false;
  const result = withCleanup(() => value, async () => { entered.resolve(); await release.promise; }, "failed")
    .then((result) => { settled = true; return result; });
  await entered.promise;
  assert.equal(settled, false);
  release.resolve();
  assert.equal(await result, value);
});

test("failed work with successful cleanup keeps the original error identity", async () => {
  const failure = new Error("work");
  let cleanups = 0;
  await assert.rejects(withCleanup(() => { throw failure; }, () => { cleanups++; }, "failed"), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(cleanups, 1);
});

test("successful work with failed cleanup keeps the cleanup error identity", async () => {
  const failure = new Error("cleanup");
  let cleanups = 0;
  await assert.rejects(withCleanup(() => 42, () => { cleanups++; throw failure; }, "failed"), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(cleanups, 1);
});

test("two asynchronous failures retain primary cause without flattening cleanup errors", async () => {
  const primary = new Error("work");
  const secondary = new AggregateError([new Error("cleanup")], "cleanup failed");
  await assert.rejects(withCleanup(async () => { throw primary; }, async () => { throw secondary; }, "both failed"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, secondary]);
    assert.equal(error.cause, primary);
    assert.equal(error.message, "both failed");
    return true;
  });
});

test("undefined primary failure is not confused with success", async () => {
  let cleanups = 0;
  const result = await withCleanup(() => { throw undefined; }, () => { cleanups++; }, "failed")
    .then(() => ({ ok: true, error: null }), (error: unknown) => ({ ok: false, error }));
  assert.deepEqual(result, { ok: false, error: undefined });
  assert.equal(cleanups, 1);
});

test("two non-Error failures are preserved", async () => {
  await assert.rejects(withCleanup(() => { throw undefined; }, () => { throw "cleanup"; }, "both failed"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [undefined, "cleanup"]);
    assert.equal(Object.hasOwn(error, "cause"), true);
    assert.equal(error.cause, undefined);
    return true;
  });
});
