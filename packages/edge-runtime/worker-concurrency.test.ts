import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import {
  WorkerPool,
  resolveMaxConcurrentExecutions,
  type WorkerPoolDispatchOptions,
} from "./worker-pool";

const pools: WorkerPool[] = [];
const fixtureRoots: string[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.shutdown()));
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureFunction(body: string): Promise<{
  functionPath: string;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-concurrency-"));
  fixtureRoots.push(projectRoot);
  const functionPath = join(projectRoot, "fn.ts");
  await Bun.write(functionPath, body);
  return { functionPath, projectRoot };
}

async function dispatch(
  pool: WorkerPool,
  { functionPath, projectRoot }: { functionPath: string; projectRoot: string },
  delayMs: number,
): Promise<Response> {
  const options: WorkerPoolDispatchOptions = {
    functionId: `proj_concurrency_${functionPath.split("/").pop()}`,
    projectRef: "test-project",
    functionPath,
    projectRoot,
    functionVersion: null,
    env: {},
    request: new Request(`http://edge.local/functions/v1/slow?delay=${delayMs}`),
  };
  const response = await pool.dispatch(options);
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}

const SLEEP_FIXTURE = `
  export default async function (request) {
    const delay = Number(new URL(request.url).searchParams.get("delay") ?? 0);
    await Bun.sleep(delay);
    return Response.json({ delay, at: performance.now() });
  }
`;

describe("resolveMaxConcurrentExecutions", () => {
  test("preserves the memory-sized warm pool unless expansion is configured", () => {
    expect(resolveMaxConcurrentExecutions(4, {})).toBe(4);
    expect(resolveMaxConcurrentExecutions(0, {})).toBe(0);
  });

  test("honours an explicit ceiling", () => {
    expect(resolveMaxConcurrentExecutions(4, { EDGE_MAX_FUNCTION_CONCURRENCY: "24" })).toBe(24);
    expect(resolveMaxConcurrentExecutions(4, { EDGE_MAX_FUNCTION_CONCURRENCY: "4" })).toBe(4);
  });

  test("rejects values that would starve warm slots", () => {
    expect(() => resolveMaxConcurrentExecutions(4, { EDGE_MAX_FUNCTION_CONCURRENCY: "2" }))
      .toThrow("at least WORKER_POOL_SIZE");
    expect(() => resolveMaxConcurrentExecutions(4, { EDGE_MAX_FUNCTION_CONCURRENCY: "-1" }))
      .toThrow("non-negative safe integer");
    expect(() => resolveMaxConcurrentExecutions(4, { EDGE_MAX_FUNCTION_CONCURRENCY: "8.5" }))
      .toThrow("non-negative safe integer");
  });
});

describe("WorkerPool concurrency governor", () => {
  test("keeps the historical serialised behaviour when no ceiling is configured", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    const startedAt = performance.now();
    const responses = await Promise.all([
      dispatch(pool, fixture, 120),
      dispatch(pool, fixture, 120),
    ]);
    const elapsed = performance.now() - startedAt;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(elapsed).toBeGreaterThanOrEqual(220);
    expect(pool.snapshotMetrics()["supacloud_edge_total_worker_surplus_creations"]).toBe(0);
  });

  test("grows past the warm pool size so I/O-bound invocations overlap", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 5_000,
      maxConcurrentExecutions: 4,
    });
    pools.push(pool);

    const startedAt = performance.now();
    const responses = await Promise.all([
      dispatch(pool, fixture, 120),
      dispatch(pool, fixture, 120),
      dispatch(pool, fixture, 120),
      dispatch(pool, fixture, 120),
    ]);
    const elapsed = performance.now() - startedAt;

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    // Serialised execution would take ~480ms; overlapping four sleeps stays near one.
    expect(elapsed).toBeLessThan(360);

    const metrics = pool.snapshotMetrics();
    expect(metrics["supacloud_edge_max_concurrent_executions"]).toBe(4);
    expect(metrics["supacloud_edge_total_worker_surplus_creations"]).toBe(3);
  });

  test("still queues once the configured ceiling is reached", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 5_000,
      maxConcurrentExecutions: 2,
    });
    pools.push(pool);

    const responses = await Promise.all([
      dispatch(pool, fixture, 60),
      dispatch(pool, fixture, 60),
      dispatch(pool, fixture, 60),
      dispatch(pool, fixture, 60),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const metrics = pool.snapshotMetrics();
    expect(metrics["supacloud_edge_total_worker_surplus_creations"]).toBe(1);
    expect(metrics["supacloud_edge_total_queued_requests"]).toBeGreaterThanOrEqual(2);
    expect(metrics["supacloud_edge_total_requests"]).toBe(4);
  });

  test("shrinks back to the warm pool size once the queue drains", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 5_000,
      maxConcurrentExecutions: 4,
    });
    pools.push(pool);

    await Promise.all([
      dispatch(pool, fixture, 80),
      dispatch(pool, fixture, 80),
      dispatch(pool, fixture, 80),
      dispatch(pool, fixture, 80),
    ]);

    // Shrink happens as each surplus worker finishes; allow the exit messages to land.
    let metrics = pool.snapshotMetrics();
    for (let attempt = 0; attempt < 100; attempt++) {
      metrics = pool.snapshotMetrics();
      if (metrics["supacloud_edge_total_workers"] === 1) break;
      await Bun.sleep(25);
    }

    expect(metrics["supacloud_edge_total_worker_surplus_retirements"]).toBe(3);
    expect(metrics["supacloud_edge_total_workers"]).toBe(1);
    expect(metrics["supacloud_edge_idle_workers"]).toBe(1);
  });

  test("sizes the default retirement count budget for a configured burst", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const exceedances: unknown[] = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 5_000,
      maxConcurrentExecutions: 12,
      onRetirementBudgetExceeded: (exceeded) => { exceedances.push(exceeded); },
    });
    pools.push(pool);

    await Promise.all(Array.from({ length: 12 }, () => dispatch(pool, fixture, 60)));
    pool.setAdmissionBlocked(true);

    expect(exceedances).toEqual([]);
    expect(pool.snapshotMetrics()["supacloud_edge_total_worker_surplus_creations"]).toBe(11);
  });

  test("reuses surplus workers across bursts before the idle grace expires", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000, maxConcurrentExecutions: 3 });
    pools.push(pool);
    for (let burst = 0; burst < 3; burst++) {
      const responses = await Promise.all(Array.from({ length: 3 }, () => dispatch(pool, fixture, 40)));
      await Promise.all(responses.map((response) => response.text()));
      await Bun.sleep(10);
    }
    const metrics = pool.snapshotMetrics();
    expect(metrics.supacloud_edge_total_worker_surplus_creations).toBe(2);
    expect(metrics.supacloud_edge_total_worker_surplus_retirements).toBe(0);
    expect(metrics.supacloud_edge_total_module_cache_hits).toBeGreaterThanOrEqual(6);
  });

  test("retires completed and idle surplus workers when admission closes", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000, maxConcurrentExecutions: 3 });
    pools.push(pool);
    const responses = [dispatch(pool, fixture, 10), dispatch(pool, fixture, 100), dispatch(pool, fixture, 100)];
    await (await responses[0]).text();
    pool.setAdmissionBlocked(true);
    await Promise.all((await Promise.all(responses.slice(1))).map((response) => response.text()));
    expect(pool.snapshotMetrics().supacloud_edge_total_workers).toBe(1);
    expect(pool.snapshotMetrics().supacloud_edge_admission_blocked).toBe(1);
    expect((await dispatch(pool, fixture, 0)).status).toBe(503);
    pool.setAdmissionBlocked(false);
    expect((await dispatch(pool, fixture, 0)).status).toBe(200);
  });

  test("counts planned surplus churn toward the lifetime recycle budget", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const recycleEvents: unknown[] = [];
    const pool = new WorkerPool({
      size: 1, requestTimeout: 5_000, maxConcurrentExecutions: 3,
      maxWorkerReplacementsBeforeRecycle: 2,
      onWorkerRecycleRequired: (event) => { recycleEvents.push(event); },
    });
    pools.push(pool);
    await Promise.all(Array.from({ length: 3 }, () => dispatch(pool, fixture, 40)));
    pool.setAdmissionBlocked(true);
    expect(recycleEvents).toHaveLength(1);
    expect(pool.snapshotMetrics().supacloud_edge_worker_recycle_required).toBe(1);
    expect(pool.snapshotMetrics().supacloud_edge_total_worker_surplus_retirements).toBe(2);
  });

  test("reserves capacity for retirees and expands when one of them exits", async () => {
    const fixture = await fixtureFunction(SLEEP_FIXTURE);
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000, maxConcurrentExecutions: 3, maxExtraProjectWorkers: 0 });
    pools.push(pool);
    await Promise.all(Array.from({ length: 3 }, () => dispatch(pool, fixture, 40)));
    const releases = new Map<Worker, () => void>();
    const workers = (pool as unknown as { activeWorkers: Set<Worker> }).activeWorkers;
    const originals = new Map([...workers].map((worker) => [worker, worker.postMessage.bind(worker)]));
    for (const [worker, postMessage] of originals) {
      worker.postMessage = (message, transfer) => {
        if (message.type === "retire") releases.set(worker, () => postMessage(message, transfer));
        else postMessage(message, transfer);
      };
    }
    try {
      pool.setAdmissionBlocked(true);
      expect(releases.size).toBe(2);
      pool.setAdmissionBlocked(false);
      const pending = Array.from({ length: 3 }, () => dispatch(pool, fixture, 200));
      expect(pool.snapshotMetrics().supacloud_edge_total_worker_surplus_creations).toBe(2);
      const [retired, release] = releases.entries().next().value!;
      releases.delete(retired);
      release();
      const deadline = performance.now() + 1_000;
      while (pool.snapshotMetrics().supacloud_edge_total_worker_surplus_creations < 3 && performance.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(pool.snapshotMetrics().supacloud_edge_total_worker_surplus_creations).toBe(3);
      expect(pool.snapshotMetrics().supacloud_edge_retired_workers).toBe(1);
      for (const release of releases.values()) release();
      releases.clear();
      expect((await Promise.all(pending)).map((response) => response.status)).toEqual([200, 200, 200]);
    } finally {
      for (const [worker, postMessage] of originals) worker.postMessage = postMessage;
      for (const release of releases.values()) release();
    }
  });

  test("rejects an invalid ceiling instead of silently serialising", () => {
    expect(() => new WorkerPool({
      size: 2,
      requestTimeout: 1_000,
      maxConcurrentExecutions: 1,
    })).toThrow("maxConcurrentExecutions must be a safe integer of at least size");
  });
});
