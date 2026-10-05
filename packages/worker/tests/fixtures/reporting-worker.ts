import { SQL } from "bun";
import { startQueueWorkerFromEnvironment } from "../../src/delivery.js";
import { LocalArtifacts, reportHandler } from "../../examples/reporting/report.js";
import { createWorkerTelemetry, serveWorkerHealth } from "../../src/telemetry.js";

const sql = new SQL(process.env.EDGE_WORKER_DB_URL!, { max: 2, connectionTimeout: 3 });
const telemetry = createWorkerTelemetry();
const workerName = `scw-report-${crypto.randomUUID()}`;
process.env.WORKER_NAME = workerName;
const handler = reportHandler({
  sql, telemetry, artifacts: new LocalArtifacts("/artifacts"), batchSize: 128,
});
const worker = await startQueueWorkerFromEnvironment(telemetry.wrap({
  ...handler,
  async execute(input, context) {
    try { await handler.execute(input, context); }
    catch (error) {
      console.error("REPORT_FIXTURE_FAILURE", error instanceof Error ? error.message : "unknown");
      throw error;
    }
    if (input.operationId === process.env.SCW_TEST_HOLD_AFTER) {
      await Bun.write("/artifacts/hold", "effect-committed");
      await Bun.sleep(120000);
    }
  },
}));
serveWorkerHealth({
  port: 19090, state: () => worker.state, telemetry,
  maxQueueAgeSeconds: 120, maxActiveMs: 60000,
  async probe() {
    const [heartbeat] = await sql<{ healthy: boolean }[]>`
      SELECT COALESCE(max(last_heartbeat_at)>clock_timestamp()-interval '15 seconds',false) healthy
      FROM pgflow.workers WHERE function_name=${workerName} AND deprecated_at IS NULL`;
    if (!heartbeat?.healthy) throw new Error("WORKER_HEARTBEAT_STALE");
    const [row] = await sql<{ pending: number; age: number }[]>`
      SELECT count(*)::int pending,COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(enqueued_at)),0)::float8 age
      FROM pgmq.q_scw_reports`;
    return { pending: row!.pending, oldestAgeSeconds: Math.max(0, row!.age) };
  },
});
