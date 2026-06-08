import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";

const pools: WorkerPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    for (const worker of (pool as any).workers || []) {
      await worker.terminate();
    }
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

describe("WorkerPool request body size limit", () => {
  const maxBodySize = 30 * 1024 * 1024;

  test("rejects declared request bodies above 30MB", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-limit-header-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should-not-run", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "test_body_limit_header",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/test", {
          method: "POST",
          headers: { "content-length": String(maxBodySize + 1) },
          body: new Uint8Array([1]),
        }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Request body too large (max 30MB)",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects actual request bodies above 30MB", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-limit-actual-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should-not-run", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "test_body_limit_actual",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/test", {
          method: "POST",
          body: new Uint8Array(maxBodySize + 1),
        }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Request body too large (max 30MB)",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

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
