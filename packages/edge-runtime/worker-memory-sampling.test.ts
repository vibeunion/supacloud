import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkerPool } from "./worker-pool";

const pools: WorkerPool[] = [];
const roots: string[] = [];
const originalInterval = process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS;
const originalHeapBudget = process.env.EDGE_WORKER_HEAP_BUDGET_BYTES;

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.shutdown();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalInterval === undefined) delete process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS;
  else process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = originalInterval;
  if (originalHeapBudget === undefined) delete process.env.EDGE_WORKER_HEAP_BUDGET_BYTES;
  else process.env.EDGE_WORKER_HEAP_BUDGET_BYTES = originalHeapBudget;
});

async function projectFixture(retainMebibytes: number) {
  const projectRoot = await mkdtemp(join(homedir(), ".supacloud-memory-sampling-"));
  roots.push(projectRoot);
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
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
  return pool.snapshotMetrics().supacloud_edge_worker_heap_bytes;
}

describe("WorkerPool heap sampling", () => {
  test.each([false, true])("reuses the reported heap inside the sampling interval (smol=%s)", async (smol) => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "600000";
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000, smol });
    pools.push(pool);

    try {
      const first = await reportHeap(pool, fixture);
      expect(first).toBeGreaterThan(0);
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
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "250";
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const first = await reportHeap(pool, fixture);
      expect(first).toBeGreaterThan(0);
      await Bun.sleep(300);
      const second = await reportHeap(pool, fixture);
      expect(second).toBeGreaterThan(first);
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  test.each(["not-a-number", "-1", "Infinity", ""])("falls back to a finite sampling interval for %s", async (interval) => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = interval;
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const first = await reportHeap(pool, fixture);
      expect(first).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(await reportHeap(pool, fixture)).toBeGreaterThan(first);
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  test("zero refreshes after every execution", async () => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "0";
    const fixture = await projectFixture(4);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000, smol: true });
    pools.push(pool);
    const first = await reportHeap(pool, fixture);
    expect(first).toBeGreaterThan(0);
    expect(await reportHeap(pool, fixture)).toBeGreaterThan(first);
  });

  test("preheat forces a fresh sample within a warm sampling window", async () => {
    process.env.EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS = "600000";
    process.env.EDGE_WORKER_HEAP_BUDGET_BYTES = String(128 * 1024 ** 2);
    const fixture = await projectFixture(0);
    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000, smol: true });
    pools.push(pool);
    const first = await reportHeap(pool, fixture);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(128 * 1024 ** 2);
    const file = join(fixture.projectRoot, "large.ts");
    await Bun.write(file, `
      const retained = new Array(32 * 1024 * 1024).fill(7);
      export default () => new Response(String(retained.length));
    `);
    expect(await pool.preheat("large", file, fixture.projectRoot, {}, {
      projectRef: "test-project", bytecode: "off",
    })).toBe(false);
    expect(pool.snapshotMetrics().supacloud_edge_memory_retirements).toBe(1);
  });
});
