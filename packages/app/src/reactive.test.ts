import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Observable, Subject, firstValueFrom, of } from "rxjs";
import { ReactiveBufferOverflowError, takeUntilAborted, toReadableStream } from "./reactive";

test("owner cancellation tears down once and an aborted owner never starts work", () => {
  const owner = new AbortController();
  let starts = 0, stops = 0, completions = 0;
  const source = new Observable<number>(() => { starts++; return () => { stops++; }; });
  const scoped = source.pipe(takeUntilAborted(owner.signal));
  const sub = scoped.subscribe({ complete: () => { completions++; } });
  expect(starts).toBe(1);
  owner.abort();
  owner.abort();
  sub.unsubscribe();
  scoped.subscribe();
  expect(starts).toBe(1);
  expect(stops).toBe(1);
  expect(completions).toBe(1);
});

test("scoped values and errors retain their identity", async () => {
  expect(await firstValueFrom(of(7).pipe(takeUntilAborted(new AbortController().signal)))).toBe(7);
  const failure = new Error("source failed");
  const source = new Subject<number>();
  let actual: unknown;
  source.pipe(takeUntilAborted(new AbortController().signal)).subscribe({ error: error => { actual = error; } });
  source.error(failure);
  expect(actual).toBe(failure);
});

test("stream completion drains queued values without a second subscription", async () => {
  let starts = 0, stops = 0;
  const source = new Observable<number>(subscriber => {
    starts++; subscriber.next(1); subscriber.next(2); subscriber.complete();
    return () => { stops++; };
  });
  const reader = toReadableStream(source, { capacity: 2 }).getReader();
  expect(await reader.read()).toEqual({ done: false, value: 1 });
  expect(await reader.read()).toEqual({ done: false, value: 2 });
  expect((await reader.read()).done).toBe(true);
  expect(starts).toBe(1);
  expect(stops).toBe(1);
});

test("overflow fails closed and synchronously stops a cooperative producer", async () => {
  let sent = 0, stops = 0;
  const source = new Observable<number>(subscriber => {
    for (let i = 0; i < 100 && !subscriber.closed; i++) { sent++; subscriber.next(i); }
    return () => { stops++; };
  });
  const reader = toReadableStream(source, { capacity: 2 }).getReader();
  let failure: unknown;
  try { await reader.read(); } catch (error) { failure = error; }
  expect(failure instanceof ReactiveBufferOverflowError).toBe(true);
  expect(sent).toBe(3);
  expect(stops).toBe(1);
});

test("reader cancellation and request abort release separate subscriptions", async () => {
  let stops = 0;
  const source = new Observable<number>(() => () => { stops++; });
  const reader = toReadableStream(source).getReader();
  await reader.cancel();
  expect(stops).toBe(1);
  const owner = new AbortController();
  const failure = new Error("request closed");
  const other = toReadableStream(source, { signal: owner.signal }).getReader();
  const pending = other.read().catch(error => error);
  owner.abort(failure);
  expect(await pending).toBe(failure);
  expect(stops).toBe(2);
});

test("pre-aborted streams do not start the producer; invalid limits fail early", async () => {
  const owner = new AbortController();
  owner.abort();
  let starts = 0;
  const source = new Observable<number>(() => { starts++; });
  await toReadableStream(source, { signal: owner.signal }).getReader().read().catch(() => {});
  expect(starts).toBe(0);
  for (const capacity of [0, -1, 0.5, NaN, Infinity, 65537]) {
    expect(() => toReadableStream(source, { capacity })).toThrow();
  }
  expect(starts).toBe(0);
});

test("reactive entry bundles for browsers without server/framework dependencies", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./reactive.ts", import.meta.url))],
    target: "browser", metafile: true,
  });
  expect(build.success).toBe(true);
  if (!build.metafile) throw new Error("Missing dependency graph");
  const inputs = Object.keys(build.metafile.inputs);
  expect(inputs.some(path => /rxjs/.test(path))).toBe(true);
  expect(inputs.some(path => /angular|node:async_hooks|supacloud-js|\/compiler\//.test(path))).toBe(false);
});
