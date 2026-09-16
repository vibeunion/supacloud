import { SQL } from "bun";
import { Flow } from "@pgflow/dsl";
import { createPgflowWorker } from "../../src/index.js";

const url = process.env.WORKER_TEST_DATABASE_URL;
if (!url) throw new Error("Missing fixture database");
const sql = new SQL(url, { connectionTimeout: 5 });
const phase = process.env.WORKER_TEST_CRASH_PHASE;
const flow = new Flow<{ operationId: string; fail?: boolean }>({
  slug: "scw_crash_v1",
  maxAttempts: 2,
  baseDelay: 1,
  timeout: 3,
}).step({ slug: "effect" }, async (input) => {
  await sql`INSERT INTO test_attempts(operation_id,phase) VALUES (${input.operationId},${phase ?? "recovered"})`;
  if (phase === "before") await Bun.sleep(600_000);
  if (input.fail) throw new Error("FIXTURE_EXPECTED_FAILURE");
  // The domain owns idempotency, not pgflow's at-least-once handler execution.
  await sql`INSERT INTO test_effects(operation_id) VALUES (${input.operationId}) ON CONFLICT DO NOTHING`;
  if (phase === "after") await Bun.sleep(600_000);
  return { operationId: input.operationId };
});
await createPgflowWorker(flow, {
  projectRef: process.env.SUPACLOUD_PROJECT_REF ?? "fixture",
  connectionString: url,
  concurrency: 1,
}).start();
