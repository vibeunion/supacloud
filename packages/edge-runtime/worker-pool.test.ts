import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";

const pools: WorkerPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.shutdown();
  }
});

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Bun.file(path).text();
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForMetric(
  pool: WorkerPool,
  metric: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pool.snapshotMetrics("test")[`test_${metric}`] === expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${metric}=${expected}`);
}

describe("WorkerPool EdgeRuntime.waitUntil", () => {
  test("keeps tenant env available after the HTTP response is returned", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-waituntil-"));
    const outputPath = join(projectRoot, "waituntil.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          globalThis.EdgeRuntime.waitUntil((async () => {
            await Bun.sleep(25);
            await Bun.write(process.env.OUT_FILE, process.env.SUPABASE_URL || "missing");
          })());
          return new Response("queued", { status: 202 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_waituntil",
        functionPath,
        projectRoot,
        env: {
          OUT_FILE: outputPath,
          SUPABASE_URL: "http://tenant.local",
        },
        request: new Request("http://edge.local/functions/v1/waituntil", { method: "POST" }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("queued");
      expect(await waitForFile(outputPath)).toBe("http://tenant.local");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool framework routing", () => {
  test("routes public Function URLs through Elysia using function-local paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-elysia-routing-"));
    const functionPath = join(projectRoot, "elysia.ts");
    const elysiaEntry = Bun.resolveSync("elysia", import.meta.dir);
    await Bun.write(functionPath, `
      import { Elysia } from ${JSON.stringify(elysiaEntry)};

      export default new Elysia()
        .get("/", ({ request }) => {
          const url = new URL(request.url);
          return { pathname: url.pathname, query: url.searchParams.get("source") };
        })
        .get("/users/:id", ({ params, request }) => {
          const url = new URL(request.url);
          return { id: params.id, pathname: url.pathname, active: url.searchParams.get("active") };
        });
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const root = await pool.dispatch({
        functionId: "proj_elysia_api",
        functionPath,
        projectRoot,
        projectRef: "proj_elysia",
        env: {},
        request: new Request("http://edge.local/functions/v1/api?source=sdk"),
      });
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual({ pathname: "/", query: "sdk" });

      const nested = await pool.dispatch({
        functionId: "proj_elysia_api",
        functionPath,
        projectRoot,
        projectRef: "proj_elysia",
        env: {},
        request: new Request("http://edge.local/functions/v1/api/users/42?active=true"),
      });
      expect(nested.status).toBe(200);
      expect(await nested.json()).toEqual({
        id: "42",
        pathname: "/users/42",
        active: "true",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("preserves the public URL for Supabase-style fetch handlers", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-fetch-routing-"));
    const functionPath = join(projectRoot, "fetch.ts");
    await Bun.write(functionPath, `
      export default {
        fetch(request) {
          const url = new URL(request.url);
          return Response.json({ pathname: url.pathname, query: url.searchParams.get("source") });
        }
      };
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_fetch_api",
        functionPath,
        projectRoot,
        projectRef: "proj_fetch",
        env: {},
        request: new Request("http://edge.local/functions/v1/api/users?source=sdk"),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        pathname: "/functions/v1/api/users",
        query: "sdk",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool cancellation and replacement", () => {
  test("replaces a timed-out worker and immediately serves the queued request", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-timeout-replace-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) {
            await new Promise(() => {});
          }
          return new Response("fast", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 100 });
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_timeout_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/slow"),
      });
      await Bun.sleep(20);
      const fastResponse = pool.dispatch({
        functionId: "proj_timeout_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });

      expect((await slowResponse).status).toBe(504);
      expect(await (await fastResponse).text()).toBe("fast");
      const metrics = pool.snapshotMetrics("timeout");
      expect(metrics["timeout_total_worker_replacements"]).toBe(1);
      expect(metrics["timeout_total_worker_retirements"]).toBe(1);
      expect(metrics["timeout_total_queued_requests"]).toBe(1);
      expect(metrics["timeout_idle_workers"]).toBe(1);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      expect(pool.snapshotMetrics("timeout")["timeout_retired_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("propagates an in-flight AbortSignal and releases the worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-signal-cancel-"));
    const startedPath = join(projectRoot, "started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) {
            await Bun.write(process.env.STARTED_PATH, "started");
            await new Promise((_, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
            });
          }
          return new Response("fast", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    const controller = new AbortController();
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_cancel_fn",
        functionPath,
        projectRoot,
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/fn/slow", {
          signal: controller.signal,
        }),
      });
      await waitForFile(startedPath);
      const fastResponse = pool.dispatch({
        functionId: "proj_cancel_fn",
        functionPath,
        projectRoot,
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });

      controller.abort();

      expect((await slowResponse).status).toBe(499);
      expect(await (await fastResponse).text()).toBe("fast");
      expect(pool.snapshotMetrics("cancel")["cancel_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("isolates HTTP aborts when requests share an external cancel key", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-duplicate-cancel-key-"));
    const firstStartedPath = join(projectRoot, "first-started.txt");
    const secondStartedPath = join(projectRoot, "second-started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          await Bun.write(process.env.STARTED_PATH, "started");
          await new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    `);

    const pool = new WorkerPool({ size: 2, requestTimeout: 5_000 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    pools.push(pool);

    try {
      const firstResponse = pool.dispatch({
        functionId: "proj_duplicate_first",
        functionPath,
        projectRoot,
        cancelKey: "shared-task-id",
        env: { STARTED_PATH: firstStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/first", {
          signal: firstController.signal,
        }),
      });
      const secondResponse = pool.dispatch({
        functionId: "proj_duplicate_second",
        functionPath,
        projectRoot,
        cancelKey: "shared-task-id",
        env: { STARTED_PATH: secondStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/second", {
          signal: secondController.signal,
        }),
      });
      await Promise.all([
        waitForFile(firstStartedPath),
        waitForFile(secondStartedPath),
      ]);

      firstController.abort();

      expect((await firstResponse).status).toBe(499);
      const secondSettled = await Promise.race([
        secondResponse.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(secondSettled).toBe(false);

      expect(pool.cancel("shared-task-id")).toBe(true);
      expect((await secondResponse).status).toBe(499);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("removes an aborted queued request before it occupies a worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-queued-cancel-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) await Bun.sleep(100);
          return new Response("done", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    const controller = new AbortController();
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_queue_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/slow"),
      });
      const queuedResponse = pool.dispatch({
        functionId: "proj_queue_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/cancel", {
          signal: controller.signal,
        }),
      });

      controller.abort();

      expect((await queuedResponse).status).toBe(499);
      expect((await slowResponse).status).toBe(200);
      expect(pool.snapshotMetrics("queue")["queue_total_queued_requests"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("replaces a cancelled streaming worker before serving the queue", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-stream-cancel-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/stream")) {
            return Response.json({ overlap: false });
          }
          return new Response(new ReadableStream({
            start(controller) {
              const timer = setInterval(() => controller.enqueue(new TextEncoder().encode("tick\\n")), 10);
              request.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
            }
          }), { headers: { "content-type": "text/event-stream" } });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const streamResponse = await pool.dispatch({
        functionId: "proj_stream_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/stream"),
      });
      const reader = streamResponse.body!.getReader();
      expect((await reader.read()).done).toBe(false);

      const queuedResponse = pool.dispatch({
        functionId: "proj_stream_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });
      await reader.cancel();

      expect(await (await queuedResponse).json()).toEqual({ overlap: false });
      const metrics = pool.snapshotMetrics("stream");
      expect(metrics["stream_total_worker_replacements"]).toBe(1);
      expect(metrics["stream_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("drain waits for ordinary requests without an external cancel key", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-drain-active-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          await Bun.sleep(120);
          return new Response("done", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const responsePromise = pool.dispatch({
        functionId: "proj_drain_fn",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      await Bun.sleep(20);
      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });

      await Bun.sleep(40);
      expect(drained).toBe(false);
      expect((await responsePromise).status).toBe(200);
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("drain waits for EdgeRuntime.waitUntil after the response", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-drain-waituntil-"));
    const completedPath = join(projectRoot, "waituntil-complete.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          EdgeRuntime.waitUntil((async () => {
            await Bun.sleep(120);
            await Bun.write(process.env.COMPLETED_PATH, "done");
          })());
          return new Response("accepted", { status: 202 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_waituntil_drain_fn",
        functionPath,
        projectRoot,
        env: { COMPLETED_PATH: completedPath },
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      expect(response.status).toBe(202);

      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });
      await Bun.sleep(40);
      expect(drained).toBe(false);
      expect(await waitForFile(completedPath)).toBe("done");
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool cooperative retirement", () => {
  test("triggers the count budget once and stops accepting requests", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-count-"));
    const functionPath = join(projectRoot, "slow.ts");
    await Bun.write(functionPath, `
      export default async function fetch(request) {
        await new Promise((resolve) => {
          const keepAlive = setInterval(() => {}, 10);
          request.signal.addEventListener("abort", () => {
            setTimeout(() => {
              clearInterval(keepAlive);
              resolve();
            }, 150);
          }, { once: true });
        });
        return new Response("retired");
      }
    `);

    const exceeded: string[] = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 25,
      retirementBudget: { maxRetiredWorkers: 1, maxRetirementAgeMs: 1_000 },
      onRetirementBudgetExceeded: (event) => exceeded.push(event.limit),
    });
    pools.push(pool);

    try {
      const dispatchSlow = () => pool.dispatch({
        functionId: "proj_retirement_count",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/slow"),
      });
      expect((await dispatchSlow()).status).toBe(504);
      expect((await dispatchSlow()).status).toBe(504);
      expect(exceeded).toEqual(["count"]);
      expect(pool.snapshotMetrics("retirement")["retirement_retirement_budget_exceeded"]).toBe(1);
      expect((await dispatchSlow()).status).toBe(503);
      await waitForMetric(pool, "total_natural_worker_exits", 2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("triggers the age budget once for a worker that cannot drain promptly", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-age-"));
    const functionPath = join(projectRoot, "slow.ts");
    await Bun.write(functionPath, `
      export default async function fetch(request) {
        await new Promise((resolve) => {
          const keepAlive = setInterval(() => {}, 10);
          request.signal.addEventListener("abort", () => {
            setTimeout(() => {
              clearInterval(keepAlive);
              resolve();
            }, 150);
          }, { once: true });
        });
        return new Response("retired");
      }
    `);

    const exceeded: string[] = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 25,
      retirementBudget: { maxRetiredWorkers: 8, maxRetirementAgeMs: 30 },
      onRetirementBudgetExceeded: (event) => exceeded.push(event.limit),
    });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_retirement_age",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/slow"),
      });
      expect(response.status).toBe(504);
      await waitForMetric(pool, "retirement_budget_exceeded", 1);
      expect(exceeded).toEqual(["age"]);
      await Bun.sleep(50);
      expect(exceeded).toEqual(["age"]);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("never returns a timed-out preheat worker to the idle pool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-retirement-"));
    const slowFunctionPath = join(projectRoot, "slow-preheat.ts");
    const fastFunctionPath = join(projectRoot, "fast.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("late");
    `);
    await Bun.write(fastFunctionPath, `export default () => new Response("replacement");`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 1_000, preheatTimeoutMs: 25 });
    pools.push(pool);

    try {
      expect(await pool.preheat(
        "proj_preheat_slow",
        slowFunctionPath,
        projectRoot,
        {},
        { moduleVersion: "v1" },
      )).toBe(false);
      const response = await pool.dispatch({
        functionId: "proj_preheat_fast",
        functionPath: fastFunctionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fast"),
      });
      expect(await response.text()).toBe("replacement");
      expect(pool.snapshotMetrics("preheat")["preheat_total_worker_retirements"]).toBe(1);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      expect(pool.snapshotMetrics("preheat")["preheat_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool TLS policy handoff", () => {
  test("passes host TLS policy into smol workers for HTTPS fetch", async () => {
    const openssl = Bun.spawnSync(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    if (!openssl.success) {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-tls-policy-"));
    const keyPath = join(projectRoot, "key.pem");
    const certPath = join(projectRoot, "cert.pem");
    const functionPath = join(projectRoot, "fn.ts");
    const previousSkipVerify = process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY;
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      const cert = Bun.spawnSync([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(cert.success).toBe(true);

      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: {
          key: await Bun.file(keyPath).text(),
          cert: await Bun.file(certPath).text(),
        },
        fetch() {
          return new Response("tls-ok");
        },
      });

      await Bun.write(functionPath, `
        export default {
          async fetch() {
            const res = await fetch("https://127.0.0.1:${server.port}/probe");
            return new Response(await res.text(), { status: res.status });
          }
        }
      `);

      process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY = "true";
      const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
      pools.push(pool);

      const response = await pool.dispatch({
        functionId: "proj_tls",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/tls"),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("tls-ok");
    } finally {
      if (previousSkipVerify === undefined) {
        delete process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY;
      } else {
        process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY = previousSkipVerify;
      }
      server?.stop(true);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool metrics NaN fix", () => {
  test("reports per-pool smol worker mode in metrics", async () => {
    const foreground = new WorkerPool({ size: 1, requestTimeout: 2_000, smol: false });
    const background = new WorkerPool({ size: 1, requestTimeout: 2_000, smol: true });
    pools.push(foreground, background);

    expect(foreground.snapshotMetrics("fg")["fg_worker_smol"]).toBe(0);
    expect(background.snapshotMetrics("bg")["bg_worker_smol"]).toBe(1);
  });

  test("avg_queue_wait_ms is 0 (never NaN) for immediate dispatch", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-nan-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("ok", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const res = await pool.dispatch({
        functionId: "test_nan",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/test"),
      });
      expect(res.status).toBe(200);

      const metrics = pool.snapshotMetrics("test");
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isNaN(value)).toBe(false);
      }
      expect(metrics["test_avg_queue_wait_ms"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("queued dispatch produces non-NaN avg_queue_wait_ms", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-nan-q-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          await Bun.sleep(10);
          return new Response("ok", { status: 200 });
        }
      }
    `);

    // Pool size 1, dispatch 2 requests to force one to queue
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const [res1, res2] = await Promise.all([
        pool.dispatch({
          functionId: "test_nan_q1",
          functionPath,
          projectRoot,
          env: {},
          request: new Request("http://edge.local/functions/v1/test1"),
        }),
        pool.dispatch({
          functionId: "test_nan_q2",
          functionPath,
          projectRoot,
          env: {},
          request: new Request("http://edge.local/functions/v1/test2"),
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const metrics = pool.snapshotMetrics("testq");
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isNaN(value)).toBe(false);
      }
      // At least one request was queued, so total_queue_wait_ms > 0
      expect(metrics["testq_total_queue_wait_ms"]).toBeGreaterThan(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool module cache", () => {
  function moduleLoadCounterSource(counterPath: string): string {
    return `
      const counterPath = ${JSON.stringify(counterPath)};
      let previous = "0";
      try {
        previous = await Bun.file(counterPath).text();
      } catch {}
      const loadCount = Number(previous || "0") + 1;
      await Bun.write(counterPath, String(loadCount));

      export default {
        async fetch() {
          return new Response(String(loadCount), { status: 200 });
        }
      }
    `;
  }

  test("reuses stable module versions and reloads when moduleVersion changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-cache-"));
    const counterPath = join(projectRoot, "counter.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, moduleLoadCounterSource(counterPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const dispatch = (moduleVersion: string) =>
        pool.dispatch({
          functionId: "proj_cache_fn",
          functionPath,
          projectRoot,
          projectRef: "proj_cache",
          moduleVersion,
          env: {},
          request: new Request("http://edge.local/functions/v1/fn"),
        });

      const first = await dispatch("v1");
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("1");

      const second = await dispatch("v1");
      expect(second.status).toBe(200);
      expect(await second.text()).toBe("1");
      expect(await Bun.file(counterPath).text()).toBe("1");

      const third = await dispatch("v2");
      expect(third.status).toBe(200);
      expect(await third.text()).toBe("2");
      expect(await Bun.file(counterPath).text()).toBe("2");

      const metrics = pool.snapshotMetrics("cache");
      expect(metrics["cache_total_module_cache_hits"]).toBe(1);
      expect(metrics["cache_total_module_cache_misses"]).toBe(2);
      expect(metrics["cache_total_worker_replacements"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("invalidates only the target function cache entry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-invalidate-"));
    const functionAPath = join(projectRoot, "a.ts");
    const functionBPath = join(projectRoot, "b.ts");
    const counterAPath = join(projectRoot, "counter-a.txt");
    const counterBPath = join(projectRoot, "counter-b.txt");
    await Bun.write(functionAPath, moduleLoadCounterSource(counterAPath));
    await Bun.write(functionBPath, moduleLoadCounterSource(counterBPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (functionId: string, functionPath: string, moduleVersion: string) =>
      pool.dispatch({
        functionId,
        functionPath,
        projectRoot,
        projectRef: "proj_precise",
        moduleVersion,
        env: {},
        request: new Request(`http://edge.local/functions/v1/${functionId}`),
      });

    try {
      expect(await (await dispatch("proj_precise_a", functionAPath, "v1")).text()).toBe("1");
      expect(await (await dispatch("proj_precise_b", functionBPath, "v1")).text()).toBe("1");

      const result = await pool.invalidateModule("proj_precise_a");
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.invalidated).toBe(1);

      expect(await (await dispatch("proj_precise_b", functionBPath, "v1")).text()).toBe("1");
      expect(await Bun.file(counterBPath).text()).toBe("1");

      expect(await (await dispatch("proj_precise_a", functionAPath, "v2")).text()).toBe("2");
      expect(await Bun.file(counterAPath).text()).toBe("2");

      const metrics = pool.snapshotMetrics("precise");
      expect(metrics["precise_total_module_cache_invalidated"]).toBe(1);
      expect(metrics["precise_total_worker_replacements"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("project invalidation does not evict another project's module cache", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-project-invalidate-"));
    const functionAPath = join(projectRoot, "project-a.ts");
    const functionBPath = join(projectRoot, "project-b.ts");
    const counterAPath = join(projectRoot, "counter-project-a.txt");
    const counterBPath = join(projectRoot, "counter-project-b.txt");
    await Bun.write(functionAPath, moduleLoadCounterSource(counterAPath));
    await Bun.write(functionBPath, moduleLoadCounterSource(counterBPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (
      functionId: string,
      functionPath: string,
      projectRef: string,
      moduleVersion: string,
    ) =>
      pool.dispatch({
        functionId,
        functionPath,
        projectRoot,
        projectRef,
        moduleVersion,
        env: {},
        request: new Request(`http://edge.local/functions/v1/${functionId}`),
      });

    try {
      expect(await (await dispatch("proj_env_a_fn", functionAPath, "proj_env_a", "v1")).text()).toBe("1");
      expect(await (await dispatch("proj_env_b_fn", functionBPath, "proj_env_b", "v1")).text()).toBe("1");

      const result = await pool.invalidateProject("proj_env_a");
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.invalidated).toBe(1);

      expect(await (await dispatch("proj_env_b_fn", functionBPath, "proj_env_b", "v1")).text()).toBe("1");
      expect(await Bun.file(counterBPath).text()).toBe("1");

      expect(await (await dispatch("proj_env_a_fn", functionAPath, "proj_env_a", "v2")).text()).toBe("2");
      expect(await Bun.file(counterAPath).text()).toBe("2");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("project env epoch can force reload even when function file metadata is unchanged", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-env-epoch-"));
    const functionPath = join(projectRoot, "env.ts");
    await Bun.write(functionPath, `
      const loadedSecret = process.env.RUNTIME_SECRET || "missing";
      export default {
        async fetch() {
          return new Response(loadedSecret, { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (moduleVersion: string, secret: string) =>
      pool.dispatch({
        functionId: "proj_env_epoch_fn",
        functionPath,
        projectRoot,
        projectRef: "proj_env_epoch",
        moduleVersion,
        env: { RUNTIME_SECRET: secret },
        request: new Request("http://edge.local/functions/v1/env"),
      });

    try {
      expect(await (await dispatch("env:0:stat:same", "old")).text()).toBe("old");
      expect(await (await dispatch("env:0:stat:same", "new-but-same-version")).text()).toBe("old");

      const result = await pool.invalidateProject("proj_env_epoch");
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.invalidated).toBe(1);

      expect(await (await dispatch("env:1:stat:same", "new")).text()).toBe("new");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("preheats all idle workers by default and can limit attempted workers", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-"));
    const functionPath = join(projectRoot, "preheat.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("preheated", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 2, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const first = await pool.preheatIdleWorkers(
        "proj_preheat_fn",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1" },
      );
      expect(first.attempted).toBe(2);
      expect(first.succeeded).toBe(2);
      expect(first.cacheHits).toBe(0);
      expect(first.cacheMisses).toBe(2);
      expect(first.durationMs).toBeGreaterThanOrEqual(0);

      const second = await pool.preheatIdleWorkers(
        "proj_preheat_fn",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1", maxWorkers: 1 },
      );
      expect(second.attempted).toBe(1);
      expect(second.succeeded).toBe(1);
      expect(second.cacheHits).toBe(1);
      expect(second.cacheMisses).toBe(0);

      const metrics = pool.snapshotMetrics("preheat");
      expect(metrics["preheat_total_preheat_attempts"]).toBe(3);
      expect(metrics["preheat_total_preheat_succeeded"]).toBe(3);
      expect(metrics["preheat_total_preheat_ms"]).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool body size limit", () => {
  test("rejects request with content-length exceeding default limit (30MB)", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-limit-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const oversizedLength = 31 * 1024 * 1024;
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(oversizedLength) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_limit",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("Request body too large");
      expect(body.error).toContain("30MB");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects request when actual body exceeds default limit", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-actual-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const oversizedBody = "x".repeat(31 * 1024 * 1024);
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        body: oversizedBody,
      });

      const res = await pool.dispatch({
        functionId: "test_body_actual",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("Request body too large");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("respects EDGE_MAX_BODY_SIZE_MB environment variable", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-env-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("ok", { status: 200 });
        }
      }
    `);

    const previousLimit = process.env.EDGE_MAX_BODY_SIZE_MB;
    process.env.EDGE_MAX_BODY_SIZE_MB = "1";

    const { WorkerPool: FreshPool } = await import("./worker-pool?" + Date.now());
    const pool = new FreshPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(2 * 1024 * 1024) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_env",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("1MB");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.EDGE_MAX_BODY_SIZE_MB;
      } else {
        process.env.EDGE_MAX_BODY_SIZE_MB = previousLimit;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("falls back to default limit for invalid EDGE_MAX_BODY_SIZE_MB", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-invalid-env-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const previousLimit = process.env.EDGE_MAX_BODY_SIZE_MB;
    process.env.EDGE_MAX_BODY_SIZE_MB = "Infinity";

    const { WorkerPool: FreshPool } = await import("./worker-pool?" + Date.now());
    const pool = new FreshPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(31 * 1024 * 1024) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_invalid_env",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("30MB");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.EDGE_MAX_BODY_SIZE_MB;
      } else {
        process.env.EDGE_MAX_BODY_SIZE_MB = previousLimit;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
