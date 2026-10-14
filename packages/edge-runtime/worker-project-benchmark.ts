import { resolve } from "node:path";
import { WorkerPool } from "./worker-pool";

export async function benchmarkProjectWorkers(options: {
  size: number;
  projects: number;
  requests: number;
  maxExtraProjectWorkers?: number;
}) {
  const pool = new WorkerPool({
    size: options.size, requestTimeout: 5000,
    maxExtraProjectWorkers: options.maxExtraProjectWorkers,
  });
  const projectRoot = resolve(import.meta.dir, "fixtures");
  const start = performance.now();
  const latencies: number[] = [];
  try {
    const results = await Promise.all(Array.from({ length: options.requests }, async (_, index) => {
      const projectRef = `benchmark-${index % options.projects}`;
      const requestStart = performance.now();
      const response = await pool.dispatch({
        projectRef, projectRoot,
        functionPath: resolve(projectRoot, "project-affinity.ts"),
        functionId: `${projectRef}_fn`,
        env: { PROJECT_OWNER: projectRef },
        request: new Request("http://edge.local/fn"),
      });
      const output: unknown = await response.json();
      latencies.push(performance.now() - requestStart);
      return response.status === 200 && output !== null && typeof output === "object"
        && "owner" in output && output.owner === projectRef;
    }));
    const elapsedMs = performance.now() - start;
    latencies.sort((a, b) => a - b);
    return {
      ...options,
      successful: results.filter(Boolean).length,
      elapsedMs: Math.round(elapsedMs),
      requestsPerSecond: Math.round(options.requests * 1000 / elapsedMs),
      p95Ms: Math.round(latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0),
      metrics: pool.snapshotMetrics("benchmark"),
    };
  } finally {
    await pool.shutdown();
  }
}

if (import.meta.main) {
  for (const [size, projects, maxExtraProjectWorkers] of [
    [2, 1, 2], [2, 2, 2], [1, 2, 0], [1, 2, 2], [2, 3, 2],
  ]) {
    console.log(JSON.stringify(await benchmarkProjectWorkers({
      size, projects, requests: 80, maxExtraProjectWorkers,
    })));
  }
}
