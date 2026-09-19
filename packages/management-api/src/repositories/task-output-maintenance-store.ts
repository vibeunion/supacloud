import type { SQL } from "bun";
import { controlPlaneDatabaseFingerprint, inspectControlPlaneDatabaseIdentity } from "../db/control-plane-database-identity";
import { taskOutputMaintenanceFingerprint } from "../utils/task-output-maintenance-options";

export interface TaskOutputMaintenanceReport {
  schema_version: 1;
  mode: "dry-run" | "apply";
  lock_acquired: boolean | null;
  pruned_tasks: number;
  eligible_tasks: number | null;
  has_more: boolean | null;
  oldest_eligible_at: string | null;
}

/** Bounded single batch, no scheduler/DDL and no automatic retry of COMMIT. */
export async function maintainTaskOutput(
  database: SQL,
  input: { fingerprint: string; apply: boolean; limit: number },
): Promise<TaskOutputMaintenanceReport> {
  const fingerprint = taskOutputMaintenanceFingerprint(input.fingerprint);
  if (typeof input.apply !== "boolean" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Invalid task output maintenance options");
  }
  return database.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    // Same transaction/connection as deletion. A database name alone is not a
    // trust root, and an expiring backup snapshot is not a recurring-job token.
    if (controlPlaneDatabaseFingerprint(await inspectControlPlaneDatabaseIdentity(tx)) !== fingerprint) {
      throw new Error("Task output maintenance database identity mismatch");
    }
    const [ready] = await tx`SELECT to_regclass('public.projects') IS NOT NULL
      AND to_regclass('public.project_tasks') IS NOT NULL
      AND to_regclass('public.project_task_output_quotas') IS NOT NULL AS ready`;
    if (!ready?.ready) throw new Error("Task output governance migration is required");
    const report: TaskOutputMaintenanceReport = {
      schema_version: 1, mode: input.apply ? "apply" : "dry-run", lock_acquired: null,
      pruned_tasks: 0, eligible_tasks: null, has_more: null, oldest_eligible_at: null,
    };
    if (input.apply) {
      const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended('supacloud.task-output-retention.v1', 0)) AS acquired`;
      report.lock_acquired = lock?.acquired === true;
      if (!report.lock_acquired) return report;
      const [pruned] = await tx`SELECT public.supacloud_prune_task_output(
        clock_timestamp() - interval '7 days', ${input.limit}::integer) AS count`;
      if (!Number.isInteger(pruned?.count) || pruned.count < 0 || pruned.count > input.limit) {
        throw new Error("Invalid retention receipt");
      }
      report.pruned_tasks = pruned.count;
    }
    // Bounded backlog sample, not a full-table count or a promise that the
    // skipped/locked tasks have all been removed. Values describe post-run state.
    const candidates = await tx`SELECT task.completed_at FROM public.project_tasks AS task
      JOIN public.project_task_output_streams AS stream ON stream.task_id = task.id
      WHERE task.status IN ('succeeded', 'failed', 'dead_lettered', 'cancelled')
        AND task.completed_at < clock_timestamp() - interval '7 days'
        AND stream.retained_after < stream.last_sequence
      ORDER BY task.completed_at, task.id LIMIT ${input.limit + 1}`;
    report.eligible_tasks = Math.min(candidates.length, input.limit);
    report.has_more = candidates.length > input.limit;
    report.oldest_eligible_at = candidates[0]?.completed_at instanceof Date
      ? candidates[0].completed_at.toISOString() : null;
    return report;
  });
}
