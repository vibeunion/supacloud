import { SQL } from "bun";
import { Flow } from "@pgflow/dsl";
import { createPgflowWorker } from "../src/index.js";

export const acceptanceShape = {
  slug: "scw_platform_acceptance_v1",
  maxAttempts: 2,
  baseDelay: 1,
  timeout: 3,
} as const;

if (import.meta.main) {
  const url = process.env.EDGE_WORKER_DB_URL;
  const projectRef = process.env.SUPACLOUD_PROJECT_REF;
  if (!url || !projectRef) throw new Error("ACCEPTANCE_CONFIG_REQUIRED");
  const db = new SQL(url);
  const flow = new Flow<{ operationId: string }>(acceptanceShape)
    .step({ slug: "effect" }, async (input) => {
      await db`INSERT INTO supacloud_worker.acceptance_attempts(operation_id) VALUES (${input.operationId}::uuid)`;
      await db`INSERT INTO supacloud_worker.acceptance_effects(operation_id) VALUES (${input.operationId}::uuid) ON CONFLICT DO NOTHING`;
      if (process.env.ACCEPTANCE_HOLD === "1" && process.env.ACCEPTANCE_OPERATION === input.operationId)
        await Bun.sleep(600_000);
      return { operationId: input.operationId };
    });
  await createPgflowWorker(flow, { projectRef, connectionString: url, concurrency: 1 }).start();
}
