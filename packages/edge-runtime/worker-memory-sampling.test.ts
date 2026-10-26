import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";

// `Bun.jsc.heapStats()` walks the whole isolate heap, so the executor samples it
// on an interval instead of once per execution. These tests pin both halves of
// that contract: the reported heap must be reused inside the sampling window and
// must still refresh once the window elapses.

const pools: WorkerPool[] = [];
const originalInterval = process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS;

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.shutdown();
  }
  if (originalInterval === undefined) delete process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS;
  else process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = originalInterval;
});

async function projectFixture(retainMebibytes: number) {
  const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-memory-sampling-"));
  await Bun.write(join(projectRoot, "fn.ts"), `
    const retained: unknown[] = [];
    export default () => {
      for (let index = 0; index < ${retainMebibytes}; index++) {
        retained.push(new Uint8Array(1024 * 1024).fill(7));
      }
      return new Response("ok");
    };
  `);
  return { projectRoot, functionPath: join(projectRoot, "fn.ts") };
}

async function reportHeap(
  pool: WorkerPool,
  fixture: { projectRoot: string; functionPath: string },
): Promise<number> {
  const response = await pool.dispatch({
    functionId: "memory_sampling_fn",
    projectRef: "test-project",
    functionPath: fixture.functionPath,
    projectRoot: fixture.projectRoot,
    functionVersion: null,
    env: {},
    request: new Request("http://edge.local/functions/v1/memory-sampling"),
  });
  await response.body?.cancel().catch(() => {});
  return pool.snapshotMetrics().supacloud_edge_worker_heap_bytes;
}

describe("WorkerPool heap sampling", () => {
  test("reuses the reported heap inside the sampling interval", async () => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "600000";
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const first = await reportHeap(pool, fixture);
      // A second execution retains 4MiB more. Inside the sampling window the
      // pool must keep reporting the previous sample rather than paying for
      // another full heap walk.
      const second = await reportHeap(pool, fixture);
      expect(second).toBe(first);
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  test("refreshes the reported heap when the interval elapses", async () => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "0";
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const first = await reportHeap(pool, fixture);
      const second = await reportHeap(pool, fixture);
      expect(second).toBeGreaterThan(first);
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects a malformed sampling interval instead of disabling sampling", async () => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "not-a-number";
    const fixture = await projectFixture(0);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      // Falls back to the default interval, so the metric stays a number.
      expect(await reportHeap(pool, fixture)).toBeGreaterThan(0);
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });
});