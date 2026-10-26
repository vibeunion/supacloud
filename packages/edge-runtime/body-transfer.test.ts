import { expect, test } from "bun:test";
import type { MessagePort } from "node:worker_threads";
import { receiveBufferedResponse } from "./response-buffer";
import { BodyBufferBudget, BodyLimitError, BODY_CHUNK_BYTES, prepareResponseBody, readBoundedBody } from "./body-transfer";

function receiveStrictBody(port: MessagePort) {
  const budget = new BodyBufferBudget(BODY_CHUNK_BYTES);
  return receiveBufferedResponse({
    port, lease: budget.lease(), bodyBudget: budget,
    responseBudget: new BodyBufferBudget(BODY_CHUNK_BYTES), readAheadBytes: 0,
    signal: new AbortController().signal, idleTimeoutMs: 2000,
    onCancel() {}, onProducerDone() {}, onConsumerDone() {},
  });
}

test("large bodies require consumer credits and split producer-owned slabs", async () => {
  const slab = new Uint8Array(BODY_CHUNK_BYTES * 4).fill(37);
  let pulls = 0;
  const prepared = await prepareResponseBody(new ReadableStream({
    pull(controller) { pulls++; if (pulls === 1) controller.enqueue(slab); else controller.close(); },
  }, { highWaterMark: 0 }), undefined, true, new AbortController().signal);
  if (!prepared.port) throw new Error("Expected streaming body");
  const sent = prepared.run();
  const received = receiveStrictBody(prepared.port);
  await Bun.sleep(25);
  expect(pulls).toBe(0);
  const reader = received.stream.getReader();
  for (let index = 0; index < 4; index++) {
    const { value } = await reader.read();
    expect(value?.byteLength).toBe(BODY_CHUNK_BYTES);
    expect(value?.[0]).toBe(37);
    expect(slab.byteLength).toBe(BODY_CHUNK_BYTES * 4);
    expect(pulls).toBe(1);
  }
  expect((await reader.read()).done).toBe(true);
  await sent;
});

test("request limit cancels before further pulls and skips contiguous aggregation", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  let reserved = 0;
  await expect(readBoundedBody(body, 1500, new AbortController().signal,
    (bytes) => { reserved = bytes; })).rejects.toBeInstanceOf(BodyLimitError);
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
  expect(reserved).toBe(3000);
});

test("budget rejects before allocating copies and release is idempotent", () => {
  const budget = new BodyBufferBudget(1024);
  const first = budget.lease(); const second = budget.lease();
  first.resize(800);
  expect(() => second.resize(300)).toThrow("budget exhausted");
  expect(budget.used).toBe(800);
  first.release(); first.release();
  second.resize(1024); second.release();
  expect(budget.used).toBe(0);
  expect(budget.peak).toBe(1024);
});

test("abort wakes a credit wait and cancels the producer", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const prepared = await prepareResponseBody(body, undefined, true, abort.signal);
  if (!prepared.port) throw new Error("Expected streaming body");
  const received = receiveStrictBody(prepared.port);
  const sent = prepared.run();
  abort.abort(new Error("cancel test"));
  await sent;
  await expect(received.stream.getReader().read()).rejects.toThrow("cancel test");
  expect(cancelled).toBe(true);
});

test("a producer response exceeding its limit fails during the small probe", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(8192)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await expect(prepareResponseBody(stream, 4096, false, new AbortController().signal))
    .rejects.toBeInstanceOf(BodyLimitError);
  expect(cancelled).toBe(true);
});

test("consumer port cancellation wakes a pending producer read without an AbortSignal", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const prepared = await prepareResponseBody(body, undefined, true, new AbortController().signal);
  if (!prepared.port) throw new Error("Expected streaming body");
  const received = receiveStrictBody(prepared.port);
  const sent = prepared.run();
  const reader = received.stream.getReader();
  const pending = reader.read();
  await Bun.sleep(5);
  await reader.cancel();
  await pending;
  await sent;
  expect(cancelled).toBe(true);
});
