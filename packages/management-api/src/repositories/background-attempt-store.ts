import type { SQL, TransactionSQL } from "bun";
import { parseTaskAttemptLogs, parseTaskJsonObject } from "../utils/task-record";

/** A lease is identified by the monotonically increasing attempt, not a process ID. */
export interface BackgroundAttemptIdentity {
  id: string;
  project_ref: string;
  attempt: number;
}
export type BackgroundAttemptOutcome = "succeeded" | "retry_scheduled" | "dead_lettered" | "cancelled";
export interface BackgroundAttemptCompletion {
  status: BackgroundAttemptOutcome;
  result?: Record<string, unknown> | null;
  error?: string | null;
  nextRunAt?: Date;
  responseStatus?: number | null;
  durationMs?: number;
  logs?: Array<{ timestamp: string; stream: "stdout" | "stderr"; level: string; message: string }>;
}
export interface BackgroundAttemptReceipt {
  status: string;
  attempt: number;
}

type LockedTask = BackgroundAttemptIdentity & {
  status: string;
  cancel_requested_at: Date | null;
  cancellation_reason: string | null;
};

function identity(task: BackgroundAttemptIdentity, allowUnclaimed = false): BackgroundAttemptIdentity {
  const { id, project_ref, attempt } = task;
  if (typeof id !== "string" || !id || typeof project_ref !== "string" || !project_ref
    || !Number.isSafeInteger(attempt) || attempt < (allowUnclaimed ? 0 : 1) || attempt > 2147483647) {
    throw new TypeError("Invalid background attempt identity");
  }
  return { id, project_ref, attempt };
}

function leaseDuration(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800) {
    throw new TypeError("Invalid background lease duration");
  }
  return seconds;
}

/**
 * No automatic write retries: a lost COMMIT acknowledgement is not a failed model
 * invocation. The worker must leave an uncertain outcome for existing recovery.
 * All lock holders acquire project_tasks before project_task_attempts/output.
 */
export function createBackgroundAttemptStore(database: SQL) {
  async function locked<T>(key: BackgroundAttemptIdentity,
    operation: (tx: TransactionSQL, task: LockedTask) => Promise<T>): Promise<T | null> {
    return database.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '5s'");
      const [task] = await tx`
        SELECT id, project_ref, attempt, status, cancel_requested_at, cancellation_reason
        FROM public.project_tasks
        WHERE id = ${key.id}::uuid AND project_ref = ${key.project_ref}
          AND task_type = 'edge_function' AND attempt = ${key.attempt}
        FOR UPDATE
      `;
      return task ? operation(tx, task as LockedTask) : null;
    });
  }

  async function hasLiveLease(tx: TransactionSQL, key: BackgroundAttemptIdentity): Promise<boolean> {
    // This is deliberately a SECOND statement, AFTER acquiring the row lock.
    // now()/transaction_timestamp() or a pre-lock check can resurrect an expired lease.
    const [row] = await tx`
      SELECT lease_until > clock_timestamp() AS live FROM public.project_tasks WHERE id = ${key.id}::uuid
    `;
    return row?.live === true;
  }

  async function renew(task: BackgroundAttemptIdentity, seconds: number): Promise<boolean> {
    const key = identity(task), duration = leaseDuration(seconds);
    return (await locked(key, async (tx, current) => {
      if (!["leased", "running"].includes(current.status) || current.cancel_requested_at
        || !await hasLiveLease(tx, key)) return false;
      await tx`
        UPDATE public.project_tasks SET lease_until = clock_timestamp() + (${duration} * interval '1 second'),
          updated_at = clock_timestamp() WHERE id = ${key.id}::uuid
      `;
      return true;
    })) ?? false;
  }

  async function start(task: BackgroundAttemptIdentity, seconds: number): Promise<boolean> {
    const key = identity(task), duration = leaseDuration(seconds);
    return (await locked(key, async (tx, current) => {
      if (current.status !== "leased" || current.cancel_requested_at || !await hasLiveLease(tx, key)) return false;
      const rows = await tx`
        INSERT INTO public.project_task_attempts(task_id, project_ref, attempt_no, status, started_at)
        VALUES (${key.id}::uuid, ${key.project_ref}, ${key.attempt}, 'running', clock_timestamp())
        ON CONFLICT (task_id, attempt_no) DO NOTHING RETURNING task_id
      `;
      if (rows.length !== 1) throw new Error("Background attempt already started");
      await tx`
        UPDATE public.project_tasks SET status = 'running',
          lease_until = clock_timestamp() + (${duration} * interval '1 second'),
          started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp()
        WHERE id = ${key.id}::uuid
      `;
      return true;
    })) ?? false;
  }

  async function finish(task: BackgroundAttemptIdentity, input: BackgroundAttemptCompletion): Promise<BackgroundAttemptReceipt | null> {
    const key = identity(task);
    // Capture/validate every caller-owned value before awaiting a lock.
    const desired = input.status;
    if (!["succeeded", "retry_scheduled", "dead_lettered", "cancelled"].includes(desired)) {
      throw new TypeError("Invalid background outcome");
    }
    const result = input.result == null ? null : JSON.stringify(parseTaskJsonObject(input.result));
    const logs = JSON.stringify(parseTaskAttemptLogs(input.logs ?? []));
    const duration = input.durationMs ?? 0;
    const responseStatus = input.responseStatus ?? null;
    const message = input.error ?? null;
    const nextRunAt = input.nextRunAt ? new Date(input.nextRunAt.valueOf()) : null;
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > 2147483647
      || (responseStatus !== null && (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599))
      || (message !== null && typeof message !== "string")
      || (desired === "retry_scheduled" && (!nextRunAt || !Number.isFinite(nextRunAt.valueOf())))) {
      throw new TypeError("Invalid background completion");
    }
    return locked(key, async (tx, current) => {
      if (!["leased", "running"].includes(current.status) || !await hasLiveLease(tx, key)) return null;
      // A committed cancellation request wins over a concurrent provider success/failure.
      const status = current.cancel_requested_at ? "cancelled" : desired;
      const error = status === "cancelled" ? current.cancellation_reason || message || "Cancelled by user" : message;
      await tx`
        UPDATE public.project_tasks SET status = ${status},
          result = ${status === "succeeded" ? result : null}::text::jsonb,
          error = ${status === "succeeded" ? null : error}, lease_until = NULL,
          next_run_at = CASE WHEN ${status} = 'retry_scheduled' THEN ${nextRunAt}::timestamptz ELSE next_run_at END,
          completed_at = CASE WHEN ${status} = 'retry_scheduled' THEN NULL ELSE clock_timestamp() END,
          cancel_requested_at = CASE WHEN ${status} = 'cancelled'
            THEN COALESCE(cancel_requested_at, clock_timestamp()) ELSE NULL END,
          cancellation_reason = CASE WHEN ${status} = 'cancelled' THEN ${error} ELSE NULL END,
          updated_at = clock_timestamp()
        WHERE id = ${key.id}::uuid
      `;
      const rows = await tx`
        INSERT INTO public.project_task_attempts(
          task_id, project_ref, attempt_no, status, started_at, completed_at, duration_ms, error, response_status, logs
        ) VALUES (${key.id}::uuid, ${key.project_ref}, ${key.attempt}, ${status},
          clock_timestamp() - (${duration} * interval '1 millisecond'), clock_timestamp(),
          ${duration}, ${status === "succeeded" ? null : error}, ${responseStatus}, ${logs}::text::jsonb)
        ON CONFLICT (task_id, attempt_no) DO UPDATE SET
          status = EXCLUDED.status, completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms,
          error = EXCLUDED.error, response_status = EXCLUDED.response_status, logs = EXCLUDED.logs,
          updated_at = clock_timestamp()
        WHERE project_task_attempts.project_ref = EXCLUDED.project_ref AND project_task_attempts.status = 'running'
        RETURNING task_id
      `;
      if (rows.length !== 1) throw new Error("Background attempt history conflicts with task state");
      return { status, attempt: key.attempt };
    });
  }

  async function requestCancellation(task: BackgroundAttemptIdentity): Promise<BackgroundAttemptReceipt | null> {
    const key = identity(task, true);
    return locked(key, async (tx, current) => {
      if (!["pending", "retry_scheduled", "leased", "running"].includes(current.status)) return null;
      const queued = ["pending", "retry_scheduled"].includes(current.status);
      const status = queued ? "cancelled" : current.status;
      await tx`
        UPDATE public.project_tasks SET status = ${status},
          cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
          cancellation_reason = COALESCE(cancellation_reason, 'Cancelled by user'),
          completed_at = CASE WHEN ${queued} THEN clock_timestamp() ELSE completed_at END,
          lease_until = CASE WHEN ${queued} THEN NULL ELSE lease_until END,
          updated_at = clock_timestamp() WHERE id = ${key.id}::uuid
      `;
      return { status, attempt: key.attempt };
    });
  }

  async function recoverCancelled(): Promise<number> {
    // A worker may die after persisting cancellation. Bound the sweep; never replay it.
    return database.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '5s'");
      const rows = await tx`
        SELECT id, project_ref, attempt FROM public.project_tasks
        WHERE task_type = 'edge_function' AND status IN ('leased', 'running')
          AND cancel_requested_at IS NOT NULL AND lease_until <= clock_timestamp()
        ORDER BY lease_until, id LIMIT 100 FOR UPDATE SKIP LOCKED
      `;
      let count = 0;
      for (const row of rows) {
        const updated = await tx`
          UPDATE public.project_tasks SET status = 'cancelled', lease_until = NULL,
            error = COALESCE(cancellation_reason, 'Cancelled by user'),
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = ${row.id}::uuid AND attempt = ${row.attempt}
            AND status IN ('leased', 'running') AND cancel_requested_at IS NOT NULL
            AND lease_until <= clock_timestamp() RETURNING id
        `;
        if (!updated.length) continue;
        await tx`
          UPDATE public.project_task_attempts SET status = 'cancelled', completed_at = clock_timestamp(),
            error = 'Cancellation lease expired; execution may have been interrupted', updated_at = clock_timestamp()
          WHERE task_id = ${row.id}::uuid AND project_ref = ${row.project_ref}
            AND attempt_no = ${row.attempt} AND status = 'running'
        `;
        count++;
      }
      return count;
    });
  }

  return { renew, start, finish, requestCancellation, recoverCancelled };
}
