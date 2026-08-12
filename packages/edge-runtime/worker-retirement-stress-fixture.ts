import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "./worker-pool";

const CHURN_BATCHES = 4;
const REQUESTS_PER_BATCH = 6;
const REQUEST_TIMEOUT_MS = 400;
const HELD_FETCH_DELAY_MS = 800;

async function waitForNaturalExits(pool: WorkerPool, expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (pool.snapshotMetrics("stress").stress_total_natural_worker_exits === expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`Only ${pool.snapshotMetrics("stress").stress_total_natural_worker_exits} workers exited naturally`);
}

async function runStress(): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-stress-"));
  const functionPath = join(projectRoot, "fetch.ts");
  const heldFetchServer = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(HELD_FETCH_DELAY_MS);
      return new Response("released");
    },
  });
  await Bun.write(functionPath, `
    export default async function execute(request) {
      if (new URL(request.url).pathname.endsWith("/slow")) {
        await globalThis.fetch(process.env.HELD_FETCH_URL);
      }
      return new Response("replacement");
    }
  `);

  const pool = new WorkerPool({
    size: 2,
    requestTimeout: REQUEST_TIMEOUT_MS,
    retirementBudget: { maxRetiredWorkers: 64, maxRetirementAgeMs: 2_000 },
  });

  try {
    const dispatch = (path: "fast" | "slow") => pool.dispatch({
      functionId: "proj_retirement_stress",
      projectRef: "proj_retirement_stress",
      functionPath,
      projectRoot,
      env: { HELD_FETCH_URL: `http://127.0.0.1:${heldFetchServer.port}` },
      request: new Request(`http://edge.local/functions/v1/stress/${path}`),
    });
    expectStatus(await dispatch("fast"), 200);

    for (let batch = 0; batch < CHURN_BATCHES; batch++) {
      const timedOut = await Promise.all(
        Array.from({ length: REQUESTS_PER_BATCH }, () => dispatch("slow")),
      );
      timedOut.forEach((response) => expectStatus(response, 504));
      const replacementResponses = await Promise.all([dispatch("fast"), dispatch("fast")]);
      replacementResponses.forEach((response) => expectStatus(response, 200));
    }

    const expectedRetirements = CHURN_BATCHES * REQUESTS_PER_BATCH;
    await waitForNaturalExits(pool, expectedRetirements);
    const metrics = pool.snapshotMetrics("stress");
    console.log(JSON.stringify({
      survived: true,
      retirements: metrics.stress_total_worker_retirements,
      naturalExits: metrics.stress_total_natural_worker_exits,
      retiredWorkers: metrics.stress_retired_workers,
      budgetExceeded: metrics.stress_retirement_budget_exceeded,
      idleWorkers: metrics.stress_idle_workers,
    }));
  } finally {
    await pool.shutdown();
    heldFetchServer.stop(true);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function expectStatus(response: Response, expected: number) {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, received ${response.status}`);
  }
}

await runStress();
