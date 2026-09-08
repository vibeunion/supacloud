import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "./worker-pool";
import { parseTraceparent } from "./tracing";

test("real worker propagates handler and waitUntil traces across tenant reuse", async () => {
  const seen: Array<{ tenant: string | null; trace: string | null; baggage: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      seen.push({ tenant: request.headers.get("x-test-tenant"), trace: request.headers.get("traceparent"), baggage: request.headers.get("baggage") });
      return new Response("ok");
    },
  });
  const root = await mkdtemp(join(tmpdir(), "supacloud-trace-worker-"));
  const path = join(root, "function.ts");
  await Bun.write(path, `
    const cachedFetch = globalThis.fetch;
    export default async (request) => {
      const headers = { "x-test-tenant": request.headers.get("x-test-tenant"), baggage: "secret" };
      await cachedFetch("http://127.0.0.1:${server.port}/sync", { headers });
      EdgeRuntime.waitUntil(Promise.resolve().then(() =>
        cachedFetch("http://127.0.0.1:${server.port}/background", { headers })));
      return Response.json({ trace: request.headers.get("traceparent") });
    };
  `);
  const pool = new WorkerPool({ size: 1, requestTimeout: 5000 });
  try {
    for (const [index, tenant] of ["tenant_a", "tenant_b"].entries()) {
      const traceId = String(index + 1).repeat(32);
      const response = await pool.dispatch({
        functionId: `${tenant}_trace`, projectRef: tenant, functionPath: path,
        projectRoot: root, env: {},
        request: new Request("http://edge.local/functions/v1/trace", {
          headers: { traceparent: `00-${traceId}-${"a".repeat(16)}-00`, "x-test-tenant": tenant },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { trace: string };
      expect(parseTraceparent(body.trace)?.traceId).toBe(traceId);
      expect(response.headers.get("traceparent")).toBe(body.trace);
    }
    // 等待已登记的后台工作结束后再检查全部出站请求。
    await pool.shutdown();
    expect(seen.length).toBe(4);
    for (const [index, tenant] of ["tenant_a", "tenant_b"].entries()) {
      const calls = seen.filter((call) => call.tenant === tenant);
      expect(calls.length).toBe(2);
      for (const call of calls) {
        expect(parseTraceparent(call.trace)?.traceId).toBe(String(index + 1).repeat(32));
        expect(call.baggage).toBeNull();
      }
      expect(calls[0]!.trace).not.toBe(calls[1]!.trace);
    }
  } finally {
    await pool.shutdown();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
