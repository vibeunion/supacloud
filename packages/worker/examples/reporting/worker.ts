import { SQL } from "bun";
import { startQueueWorkerFromEnvironment } from "../../src/delivery.js";
import { createWorkerTelemetry, serveWorkerHealth } from "../../src/telemetry.js";
import { LocalArtifacts, reportHandler } from "./report.js";

function positive(name: string, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("REPORT_CONFIG_INVALID");
  return value;
}
if (process.env.SUPACLOUD_WORKER_QUEUE !== "scw_reports" ||
  process.env.SUPACLOUD_WORKER_TASK !== "report.generate" || !process.env.SCW_ARTIFACT_DIRECTORY)
  throw new Error("REPORT_CONFIG_INVALID");
const sql = new SQL(process.env.EDGE_WORKER_DB_URL!, {
  max: positive("SCW_DOMAIN_PG_CONNECTIONS", 16), connectionTimeout: 3, idleTimeout: 5,
});
const telemetry = createWorkerTelemetry();
const workerName = `scw-report-${crypto.randomUUID()}`;
process.env.WORKER_NAME = workerName;
const worker = await startQueueWorkerFromEnvironment(telemetry.wrap(reportHandler({
  sql, telemetry, artifacts: new LocalArtifacts(process.env.SCW_ARTIFACT_DIRECTORY),
  batchSize: positive("SCW_REPORT_BATCH_SIZE", 1000),
  maxAttempts: Number(process.env.SUPACLOUD_WORKER_RETRY_LIMIT) + 1,
})));
serveWorkerHealth({
  port: positive("SCW_HEALTH_PORT", 65535), state: () => worker.state, telemetry,
  maxActiveMs: positive("SUPACLOUD_WORKER_VISIBILITY_SECONDS", 3600) * 1000,
  maxQueueAgeSeconds: positive("SCW_MAX_QUEUE_AGE_SECONDS", 86400),
  async probe() {
    return sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout='2s'`;
      const [heartbeat] = await tx<{ healthy: boolean }[]>`
        SELECT COALESCE(max(last_heartbeat_at)>clock_timestamp()-interval '15 seconds',false) healthy
        FROM pgflow.workers WHERE function_name=${workerName} AND deprecated_at IS NULL`;
      if (!heartbeat?.healthy) throw new Error("WORKER_HEARTBEAT_STALE");
      const [row] = await tx<{ pending: number; oldest: number }[]>`
        SELECT count(*)::int AS pending,COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(enqueued_at)),0)::float8 AS oldest
        FROM pgmq.q_scw_reports`;
      return { pending: row!.pending, oldestAgeSeconds: Math.max(0, row!.oldest) };
    });
  },
});
