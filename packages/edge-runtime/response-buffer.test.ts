import { expect, test } from "bun:test";
import { BodyBufferBudget, BODY_CHUNK_BYTES, prepareResponseBody } from "./body-transfer";
import { receiveBufferedResponse } from "./response-buffer";

test("independent budget pressure pauses prefetch without spinning and wakes on release", async () => {
  const budget = new BodyBufferBudget(BODY_CHUNK_BYTES * 2);
  const other = budget.lease(); other.resize(BODY_CHUNK_BYTES);
  const lease = budget.lease(); lease.resize(BODY_CHUNK_BYTES);
  const responseBudget = new BodyBufferBudget(BODY_CHUNK_BYTES * 4);
  let produced = 0;
  const prepared = await prepareResponseBody(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === 2) { controller.close(); return; }
      produced++; controller.enqueue(new Uint8Array(BODY_CHUNK_BYTES));
    },
  }, { highWaterMark: 0 }), undefined, true, new AbortController().signal);
  if (!prepared.port) throw new Error("Expected stream");
  const sent = prepared.run();
  const received = receiveBufferedResponse({
    port: prepared.port, lease, bodyBudget: budget, responseBudget,
    readAheadBytes: BODY_CHUNK_BYTES * 4, signal: new AbortController().signal,
    idleTimeoutMs: 1000, onCancel() {}, onProducerDone() {}, onConsumerDone() {},
  });
  // This timer would starve if reservation rollback created an endless microtask retry.
  await Bun.sleep(20);
  expect(produced).toBe(1);
  other.release();
  expect((await new Response(received.stream).arrayBuffer()).byteLength).toBe(2 * BODY_CHUNK_BYTES);
  await sent;
  expect(budget.used).toBe(0);
  expect(responseBudget.used).toBe(0);
});

test("delivery timeout releases completed buffered bytes without cancelling unrelated work", async () => {
  const budget = new BodyBufferBudget(BODY_CHUNK_BYTES * 4);
  const lease = budget.lease(); lease.resize(BODY_CHUNK_BYTES);
  const responseBudget = new BodyBufferBudget(BODY_CHUNK_BYTES * 4);
  let sentChunk = false;
  const prepared = await prepareResponseBody(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sentChunk) { controller.close(); return; }
      sentChunk = true; controller.enqueue(new Uint8Array(BODY_CHUNK_BYTES));
    },
  }, { highWaterMark: 0 }), undefined, true, new AbortController().signal);
  if (!prepared.port) throw new Error("Expected stream");
  let producerDone = false;
  const delivered = Promise.withResolvers<void>();
  const sent = prepared.run();
  const received = receiveBufferedResponse({
    port: prepared.port, lease, bodyBudget: budget, responseBudget,
    readAheadBytes: BODY_CHUNK_BYTES * 4, signal: new AbortController().signal,
    idleTimeoutMs: 50, onCancel() {}, onProducerDone() { producerDone = true; },
    onConsumerDone: delivered.resolve,
  });
  await sent;
  await delivered.promise;
  expect(producerDone).toBe(true);
  expect(budget.used).toBe(0);
  expect(responseBudget.used).toBe(0);
  await expect(new Response(received.stream).arrayBuffer()).rejects.toThrow("delivery timed out");
});
