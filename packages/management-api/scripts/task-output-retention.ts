import { SQL } from "bun";
import { controlPlaneDatabaseFingerprint, inspectControlPlaneDatabaseIdentity } from "../src/db/control-plane-database-identity";
import { maintainTaskOutput } from "../src/repositories/task-output-maintenance-store";
import { taskOutputMaintenanceFingerprint, taskOutputMaintenanceOptions } from "../src/utils/task-output-maintenance-options";

let database: SQL | undefined;
try {
  const options = taskOutputMaintenanceOptions(process.argv.slice(2));
  const fingerprint = options.mode === "inspect" ? null
    : taskOutputMaintenanceFingerprint(process.env.SUPACLOUD_TASK_OUTPUT_CONTROL_FINGERPRINT);
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("DATABASE_URL is required");
  database = new SQL(connection, { max: 1, connectTimeout: 10, idleTimeout: 5 });
  if (options.mode === "inspect") {
    const identity = await inspectControlPlaneDatabaseIdentity(database);
    console.log(JSON.stringify({ schema_version: 1, mode: "inspect", database_name: identity.databaseName,
      fingerprint: controlPlaneDatabaseFingerprint(identity) }));
  } else {
    const report = await maintainTaskOutput(database, {
      fingerprint: fingerprint!, apply: options.mode === "apply", limit: options.limit,
    });
    console.log(JSON.stringify(report));
  }
} catch {
  // Never log connection strings or raw database/provider exceptions. A timeout
  // or unknown COMMIT is a failure, never a synthetic successful cleanup report.
  console.error(JSON.stringify({ schema_version: 1, code: "TASK_OUTPUT_RETENTION_FAILED" }));
  process.exitCode = 1;
} finally {
  await database?.close();
}
