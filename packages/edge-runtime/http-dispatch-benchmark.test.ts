import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkHttpDispatch } from "./http-dispatch-benchmark";

async function withHealthFixture(
  instanceIdExpression: string,
  run: (entrypoint: string) => Promise<void>,
  responseExpression = 'Response.json({ ok: true, path: "/functions/v1/bench" })',
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-http-bench-health-"));
  try {
    const entrypoint = join(root, "server.ts");
    await Bun.write(entrypoint, `
      Bun.serve({
        hostname: "127.0.0.1",
        port: Number(process.env.EDGE_RUNTIME_PORT),
        fetch: (request) => new URL(request.url).pathname === "/health"
          ? Response.json({ instanceId: ${instanceIdExpression} })
          : ${responseExpression},
      });
    `);
    await run(entrypoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const options = {
  size: 1,
  concurrency: 1,
  requests: 2,
  ioMs: 0,
  responseBytes: 0,
};

test("rejects a healthy listener that does not match the spawned runtime", async () => {
  await withHealthFixture('"foreign-runtime"', async (entrypoint) => {
    await expect(benchmarkHttpDispatch({ ...options, entrypoint }))
      .rejects.toThrow("unexpected runtime instance");
  });
});

test("accepts the unique identity injected into the spawned runtime", async () => {
  await withHealthFixture("process.env.EDGE_RUNTIME_INSTANCE_ID", async (entrypoint) => {
    const benchmark = await benchmarkHttpDispatch({ ...options, entrypoint });
    expect(benchmark.requests).toBe(2);
    expect(benchmark.requestsPerSecond).toBeGreaterThan(0);
  });
});

test("rejects HTTP 200 with a body that did not come from the fixture", async () => {
  await withHealthFixture("process.env.EDGE_RUNTIME_INSTANCE_ID", async (entrypoint) => {
    await expect(benchmarkHttpDispatch({ ...options, entrypoint }))
      .rejects.toThrow("unexpected benchmark response body");
  }, 'Response.json({ instanceId: process.env.EDGE_RUNTIME_INSTANCE_ID })');
});

test("rejects a truncated or corrupted sized response", async () => {
  for (const response of ['new Response("a")', 'new Response("bb")']) {
    await withHealthFixture("process.env.EDGE_RUNTIME_INSTANCE_ID", async (entrypoint) => {
      await expect(benchmarkHttpDispatch({ ...options, responseBytes: 2, entrypoint }))
        .rejects.toThrow("unexpected benchmark response body");
    }, response);
  }
});

test("counts completed bytes for a valid sized response", async () => {
  await withHealthFixture("process.env.EDGE_RUNTIME_INSTANCE_ID", async (entrypoint) => {
    const benchmark = await benchmarkHttpDispatch({ ...options, concurrency: 2, responseBytes: 2, entrypoint });
    expect(benchmark.requests).toBe(2);
    expect(benchmark.completedBytes).toBe(4);
  }, 'new Response("aa")');
});
