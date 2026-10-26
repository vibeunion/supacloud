import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";
import { BODY_CHUNK_BYTES, SMALL_BODY_BYTES, BodyBufferBudget } from "./body-transfer";

const resources: { pool: WorkerPool; root: string }[] = [];
afterEach(async () => {
  for (const { pool, root } of resources.splice(0)) {
    await pool.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(source: string, size = 1, timeout = 2000, budget = new BodyBufferBudget(16 * 1024 ** 2), responseReadAheadBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "edge-memory-test-"));
  const file = join(root, "fn.ts");
  await Bun.write(file, source);
  const pool = new WorkerPool({ size, requestTimeout: timeout, smol: true, bodyBufferBudget: budget, responseReadAheadBytes });
  resources.push({ pool, root });
  const dispatch = (overrides: Record<string, unknown> = {}) => pool.dispatch({
    functionId: "memory-test", projectRef: "memory-test", projectRoot: root,
    functionPath: file, env: {}, request: new Request("http://edge.test/function", {
      headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` },
    }), ...overrides,
  });
  return { pool, root, file, dispatch, budget };
}

test("repeated cooperative cancellations preserve the warm worker", async () => {
  const { dispatch, pool, budget } = await fixture(`
    const identity = crypto.randomUUID();
    export default async (request) => {
      if (new URL(request.url).pathname === '/cancel') {
        console.log('ready');
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
      }
      return new Response(identity);
    };
  `);
  const identity = await (await dispatch()).text();
  for (let index = 0; index < 30; index++) {
    const abort = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = dispatch({
      signal: abort.signal, request: new Request('http://edge.test/cancel'),
      onLog: (entry: { message: string }) => { if (entry.message === 'ready') ready(); },
    });
    await started;
    abort.abort();
    expect((await pending).status).toBe(499);
    expect(await (await dispatch()).text()).toBe(identity);
  }
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_replacements).toBe(0);
  expect(budget.used).toBe(0);
});

test("cancel acknowledgement cannot release a slot before waitUntil cleanup", async () => {
  const { dispatch, pool, root } = await fixture(`
    let pending = false;
    export default async (request) => {
      if (new URL(request.url).pathname === '/cancel') {
        console.log('ready');
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
        pending = true;
        EdgeRuntime.waitUntil((async () => {
          while (!(await Bun.file(process.env.RELEASE_PATH).exists())) await Bun.sleep(5);
          pending = false;
        })());
      }
      return Response.json({ pending });
    };
  `);
  const abort = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = dispatch({
    env: { RELEASE_PATH: join(root, 'release') }, signal: abort.signal,
    request: new Request('http://edge.test/cancel'),
    onLog: (entry: { message: string }) => { if (entry.message === 'ready') ready(); },
  });
  await started;
  abort.abort();
  expect((await pending).status).toBe(499);
  const next = dispatch();
  expect(await Promise.race([next.then(() => 'overlap'), Bun.sleep(80).then(() => 'blocked')])).toBe('blocked');
  await Bun.write(join(root, 'release'), 'done');
  expect(await (await next).json()).toEqual({ pending: false });
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_replacements).toBe(0);
});

test("cancellation does not extend an already running waitUntil deadline", async () => {
  const { dispatch, pool } = await fixture(`
    export default () => {
      EdgeRuntime.waitUntil(new Promise(() => {}));
      return new Response('queued');
    };
  `);
  const abort = new AbortController();
  const response = await dispatch({ signal: abort.signal, limits: { wait_until_timeout_ms: 100 } });
  expect(await response.text()).toBe('queued');
  abort.abort();
  const deadline = performance.now() + 1000;
  while (pool.snapshotMetrics().supacloud_edge_total_worker_retirements === 0 && performance.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_retirements).toBe(1);
});

test("30 slow consumers keep ordinary response transport and queues bounded", async () => {
  const { pool, dispatch, budget } = await fixture(`
    export default () => {
      let chunks = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (chunks++ === 16) { c.close(); return; }
          c.enqueue(new Uint8Array(65536).fill(123));
        }
      }, { highWaterMark: 0 }), { headers: { 'set-cookie': 'a=b' } });
    };
  `, 4, 5000, new BodyBufferBudget(16 * 1024 ** 2), 0);
  let total = 0;
  const requests = Array.from({ length: 30 }, async () => {
    const response = await dispatch();
    expect(response.status).toBe(200);
    await Bun.sleep(40);
    const reader = response.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(BODY_CHUNK_BYTES);
      total += value.byteLength;
      await Bun.sleep(1);
    }
  });
  await Bun.sleep(30);
  expect(pool.snapshotMetrics().supacloud_edge_total_workers).toBe(4);
  await Promise.all(requests);
  await pool.drain();
  expect(total).toBe(30 * 1024 ** 2);
  expect(budget.peak).toBeLessThanOrEqual(30 * BODY_CHUNK_BYTES);
  expect(budget.used).toBe(0);
}, 10000);

test("foreground and background pools can share one budget including unread small responses", async () => {
  const budget = new BodyBufferBudget(BODY_CHUNK_BYTES);
  const first = await fixture(`export default () => new Response("hello");`, 1, 2000, budget);
  const second = await fixture(`export default () => new Response("other");`, 1, 2000, budget);
  const unread = await first.dispatch();
  expect(budget.used).toBe(5);
  expect((await second.dispatch()).status).toBe(503);
  await unread.body!.cancel();
  expect(await (await second.dispatch()).text()).toBe("other");
  expect(budget.used).toBe(0);
});

test("HTTP abort remains attached after headers and releases a blocked producer", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default () => new Response(new ReadableStream({}), {
      headers: { 'content-type': 'text/event-stream' }
    });
  `);
  const abort = new AbortController();
  const response = await dispatch({ signal: abort.signal });
  const read = response.body!.getReader().read();
  abort.abort();
  await expect(read).rejects.toThrow("cancel");
  await pool.drain();
  expect(budget.used).toBe(0);
});

test("request timeout also bounds an unread streaming response after headers", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default () => new Response(new ReadableStream({}), {
      headers: { 'content-type': 'text/event-stream' }
    });
  `, 1, 150);
  const response = await dispatch();
  expect(response.status).toBe(200);
  await expect(response.body!.getReader().read()).rejects.toThrow("Gateway Timeout");
  await pool.drain();
  expect(budget.used).toBe(0);
});

test("waitUntil registered during streaming and nested tasks finish before the next handler", async () => {
  const logs: string[] = [];
  const { dispatch, pool } = await fixture(`
    export default () => {
      let done = false;
      return new Response(new ReadableStream({
        pull(c) {
          if (done) { c.close(); return; }
          done = true;
          EdgeRuntime.waitUntil(Bun.sleep(50).then(() => {
            EdgeRuntime.waitUntil(Bun.sleep(25).then(() => console.log('completed:' + process.env.MARKER)));
          }));
          c.enqueue(new TextEncoder().encode('ok'));
        }
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    };
  `);
  const first = await dispatch({ env: { MARKER: "first" }, onLog: (entry: { message: string }) => logs.push(entry.message) });
  expect(await first.text()).toBe("ok");
  const second = await dispatch({ env: { MARKER: "second" } });
  expect(logs).toContain("completed:first");
  await second.text();
  await pool.drain();
});

test("a throwing handler's background task cannot observe the next request env", async () => {
  const logs: string[] = [];
  const { dispatch } = await fixture(`
    export default () => {
      EdgeRuntime.waitUntil(Bun.sleep(40).then(() => console.log(process.env.MARKER)));
      throw new Error('handler failed');
    };
  `);
  const first = await dispatch({ env: { MARKER: "first" }, onLog: (entry: { message: string }) => logs.push(entry.message) });
  expect(first.status).toBe(500); await first.text();
  const second = await dispatch({ env: { MARKER: "second" } });
  expect(logs).toContain("first"); await second.text();
});

test("module lifetime budget retires a generation even if its response is small", async () => {
  const previous = process.env.EDGE_MODULE_GENERATION_LIMIT;
  process.env.EDGE_MODULE_GENERATION_LIMIT = "2";
  try {
    const { dispatch, pool } = await fixture(`export default () => new Response("ok");`);
    expect(await (await dispatch({ moduleVersion: "1" })).text()).toBe("ok");
    expect(await (await dispatch({ moduleVersion: "2" })).text()).toBe("ok");
    expect(pool.snapshotMetrics().supacloud_edge_memory_retirements).toBe(1);
    expect(await (await dispatch({ moduleVersion: "3" })).text()).toBe("ok");
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODULE_GENERATION_LIMIT;
    else process.env.EDGE_MODULE_GENERATION_LIMIT = previous;
  }
});

test("over-budget preheat cannot report a successful warm worker", async () => {
  const previous = process.env.EDGE_MODULE_BUDGET_BYTES;
  process.env.EDGE_MODULE_BUDGET_BYTES = "1";
  try {
    const { pool, root, file } = await fixture(`export default () => new Response("ok");`);
    const result = await pool.preheat("memory-test", file, root, {}, { projectRef: "memory-test" });
    expect(result).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODULE_BUDGET_BYTES;
    else process.env.EDGE_MODULE_BUDGET_BYTES = previous;
  }
});

test("timed out upload cancels a blocked reader and releases every reservation", async () => {
  let cancelled = false;
  const { dispatch, budget } = await fixture(`export default () => new Response("must not run");`, 1, 100,
    new BodyBufferBudget(64 * 1024 ** 2));
  const response = await dispatch({ request: new Request("http://edge.test", {
    method: "POST", body: new ReadableStream({ cancel() { cancelled = true; } }),
  }) });
  expect(response.status).toBe(504);
  expect(cancelled).toBe(true);
  expect(budget.used).toBe(0);
});

test("waitUntil retains request-scoped bindings for successful and throwing handlers", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    seen.push(request.headers.get("authorization") ?? "");
    return Response.json({ value: "background-ok" });
  } });
  const { dispatch, pool } = await fixture(`
    export default () => {
      EdgeRuntime.waitUntil(Bun.sleep(25).then(() => globalThis.SupaCloud.pgredis.get('background')));
      if (process.env.FAIL === 'yes') throw new Error('failure');
      return new Response('ok');
    };
  `);
  try {
    const binding = { baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 1000 };
    await (await dispatch({ internalBindings: { ...binding, capabilityToken: "test-first" } })).text();
    await (await dispatch({ env: { FAIL: "yes" }, internalBindings: { ...binding, capabilityToken: "test-second" } })).text();
    await pool.drain();
    expect(seen).toEqual(["Bearer test-first", "Bearer test-second"]);
  } finally { server.stop(true); }
});

test("response-limit cancellation hook settles before reuse and can register waitUntil", async () => {
  const logs: string[] = [];
  const { dispatch, pool } = await fixture(`
    export default () => {
      if (process.env.MARKER === 'second') return new Response('second');
      return new Response(new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(1024)); },
        async cancel() {
          await Bun.sleep(40);
          EdgeRuntime.waitUntil(Bun.sleep(20).then(() => console.log('cleanup:' + process.env.MARKER)));
        }
      }, { highWaterMark: 0 }));
    };
  `);
  const first = await dispatch({ env: { MARKER: "first" }, limits: { max_response_body_bytes: 1 },
    onLog: (entry: { message: string }) => logs.push(entry.message) });
  expect(first.status).toBe(502); await first.text();
  expect(await (await dispatch({ env: { MARKER: "second" } })).text()).toBe("second");
  expect(logs).toContain("cleanup:first");
  await pool.drain();
});

test("late response overflow errors the committed stream with its limit type", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(65536)); }
    }, { highWaterMark: 0 }));
  `);
  const response = await dispatch({ limits: { max_response_body_bytes: 131072 } });
  expect(response.status).toBe(200);
  await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "BodyLimitError", limit: 131072 });
  await pool.drain();
  expect(budget.used).toBe(0);
});

test("tenant error envelopes stay below one transport window even with JSON escaping", async () => {
  const { dispatch, budget } = await fixture(`
    export default () => {
      const error = new Error(String.fromCharCode(0).repeat(1024 * 1024));
      error.name = 'X'.repeat(1024 * 1024);
      throw error;
    };
  `);
  const response = await dispatch();
  expect(response.status).toBe(500);
  const bytes = await response.arrayBuffer();
  expect(bytes.byteLength).toBeLessThan(SMALL_BODY_BYTES);
  expect(JSON.parse(new TextDecoder().decode(bytes)).error.length).toBe(4096);
  expect(budget.used).toBe(0);
});

test("bounded read-ahead releases execution slots while unread responses stay charged", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default () => {
      let chunks = 0;
      return new Response(new ReadableStream({
        pull(c) { if (chunks++ === 16) c.close(); else c.enqueue(new Uint8Array(65536)); }
      }, { highWaterMark: 0 }));
    };
  `, 1, 2000, new BodyBufferBudget(8 * 1024 ** 2), 2 * 1024 ** 2);
  const responses = await Promise.all([dispatch(), dispatch(), dispatch(), dispatch()]);
  while (pool.activeCount) await Bun.sleep(1);
  expect(budget.used).toBe(4 * 1024 ** 2);
  let drained = false;
  const draining = pool.drain().then(() => { drained = true; });
  await Bun.sleep(20);
  expect(drained).toBe(false);
  for (const response of responses) await response.body!.cancel();
  await draining;
  expect(budget.used).toBe(0);
});

test("aborting a buffered response cannot cancel the next execution on its reused Worker", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default async () => {
      if (process.env.NEXT === 'yes') { await Bun.sleep(80); return new Response('next'); }
      let chunks = 0;
      return new Response(new ReadableStream({
        pull(c) { if (chunks++ === 4) c.close(); else c.enqueue(new Uint8Array(65536)); }
      }, { highWaterMark: 0 }));
    };
  `);
  const abort = new AbortController();
  const old = await dispatch({ signal: abort.signal });
  const started = Promise.withResolvers<void>();
  const next = dispatch({ env: { NEXT: "yes" }, onExecutionStarted: started.resolve });
  await started.promise;
  abort.abort();
  await expect(old.arrayBuffer()).rejects.toThrow("cancelled");
  expect(await (await next).text()).toBe("next");
  expect(budget.used).toBe(0);
});


test("unread small responses expire and release delivery reservations after worker reuse", async () => {
  const { dispatch, pool, budget } = await fixture(`export default () => new Response("hello");`, 1, 500);
  const unread = await dispatch();
  expect(budget.used).toBe(5);
  expect(pool.snapshotMetrics().supacloud_edge_response_deliveries).toBe(1);
  expect(await (await dispatch()).text()).toBe("hello");
  await Bun.sleep(550);
  await expect(unread.text()).rejects.toThrow("delivery timed out");
  expect(budget.used).toBe(0);
  expect(pool.snapshotMetrics().supacloud_edge_response_deliveries).toBe(0);
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_replacements).toBe(0);
  await pool.drain();
});

test("aborting a completed small response releases its lease without cancelling the reused worker", async () => {
  const { dispatch, pool, budget } = await fixture(`
    export default async (request) => {
      if (request.url.includes('slow')) await Bun.sleep(75);
      return new Response("hello");
    };
  `);
  const abort = new AbortController();
  const unread = await dispatch({ signal: abort.signal });
  const next = dispatch({ request: new Request("http://edge.test/slow") });
  abort.abort();
  await expect(unread.text()).rejects.toThrow("cancelled");
  expect(await (await next).text()).toBe("hello");
  expect(budget.used).toBe(0);
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_replacements).toBe(0);
});
