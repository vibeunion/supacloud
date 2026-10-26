import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerPool,
  resolveMaxConcurrentExecutions,
  type WorkerPoolDispatchOptions,
} from "./worker-pool";

const pools: WorkerPool[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.shutdown()));
});

async function fixtureFunction(body: string): Promise<{
  functionPath: string;
  projectRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-concurrency-"));
  const functionPath = join(projectRoot, "fn.ts");
  await Bun.write(functionPath, body);
  return { functionPath, projectRoot };
}

function dispatch(
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
  return pool.dispatch(options);
}

const SLEEP_FIXTURE = `
  export default async function (request) {
    const delay = Number(new URL(request.url).searchParams.get("delay") ?? 0);
    await Bun.sleep(delay);
    return Response.json({ delay, at: performance.now() });
  }
`;

describe("resolveMaxConcurrentExecutions", () => {
  test("defaults to four times the warm pool size", () => {
    expect(resolveMaxConcurrentExecutions(4, {})).toBe(16);
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
    for (let attempt = 0; attempt < 40; attempt++) {
      metrics = pool.snapshotMetrics();
      if (metrics["supacloud_edge_total_workers"] === 1) break;
      await Bun.sleep(25);
    }

    expect(metrics["supacloud_edge_total_worker_surplus_retirements"]).toBe(3);
    expect(metrics["supacloud_edge_total_workers"]).toBe(1);
    expect(metrics["supacloud_edge_idle_workers"]).toBe(1);
  });

  test("plans surplus retirements outside the worker-leak budget", async () => {
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

    expect(exceedances).toEqual([]);
    expect(pool.snapshotMetrics()["supacloud_edge_total_worker_surplus_creations"]).toBe(11);
  });

  test("rejects an invalid ceiling instead of silently serialising", () => {
    expect(() => new WorkerPool({
      size: 2,
      requestTimeout: 1_000,
      maxConcurrentExecutions: 1,
    })).toThrow("maxConcurrentExecutions must be a safe integer of at least size");
  });
});