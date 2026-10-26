import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkHttpDispatch } from "./http-dispatch-benchmark";

async function withHealthFixture(
  instanceIdExpression: string,
  run: (entrypoint: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-http-bench-health-"));
  try {
    const entrypoint = join(root, "server.ts");
    await Bun.write(entrypoint, `
      Bun.serve({
        hostname: "127.0.0.1",
        port: Number(process.env.EDGE_RUNTIME_PORT),
        fetch: () => Response.json({ instanceId: ${instanceIdExpression} }),
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
