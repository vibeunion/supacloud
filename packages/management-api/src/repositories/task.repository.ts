import { sql, type ProjectTask, type ProjectTaskAttempt, type TaskStatus, type TaskType, TaskStatus as TaskStatuses } from "../db";
import { withRetry } from "../utils/retry";

export interface CreateTaskInput {
  ref: string;
  type: TaskType;
  payload?: Record<string, unknown>;
  status?: TaskStatus;
  maxAttempts?: number;
  timeoutSec?: number | null;
  functionSlug?: string | null;
  functionVersion?: string | null;
  idempotencyKey?: string | null;
  traceId?: string | null;
  nextRunAt?: Date | null;
}

export interface TaskLeaseOptions {
  workerId: string;
  allowedTaskTypes?: string[];
  leaseSeconds?: number;
  concurrencyByProject?: number;
}

export interface TaskListFilters {
  statuses?: string[];
  taskTypes?: string[];
  functionSlug?: string;
  functionVersion?: string;
  onlyDeadLettered?: boolean;
  limit?: number;
}

export interface ClaimQueueMessageOptions {
  projectRef: string;
  queueName: string;
  visibilityTimeoutSec?: number;
}

export interface LeasedTask extends ProjectTask {
  worker_id?: string;
}

const DEFAULT_LEASE_SECONDS = 330;

function mapTask(row: unknown): ProjectTask {
  const task = row as ProjectTask & {
    payload?: Record<string, unknown> | string | null;
    result?: Record<string, unknown> | string | null;
  };

  return {
    ...task,
    payload: parseJsonObject(task.payload),
    result: parseOptionalJsonObject(task.result),
  } as ProjectTask;
}

function mapAttempt(row: unknown): ProjectTaskAttempt {
  const attempt = row as ProjectTaskAttempt & {
    logs?: ProjectTaskAttempt["logs"] | string | null;
  };

  return {
    ...attempt,
    logs: parseAttemptLogs(attempt.logs),
  } as ProjectTaskAttempt;
}

function parseJsonObject(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value;
}

function parseOptionalJsonObject(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (value == null) return null;
  const parsed = parseJsonObject(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseAttemptLogs(
  value: ProjectTaskAttempt["logs"] | string | null | undefined,
): ProjectTaskAttempt["logs"] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as ProjectTaskAttempt["logs"]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

export function buildTaskListQuery(projectRef: string, filters: TaskListFilters = {}): {
  sqlText: string;
  values: unknown[];
} {
  const conditions = [`project_ref = $1`];
  const values: unknown[] = [projectRef];

  if (filters.onlyDeadLettered) {
    conditions.push(`status = 'dead_lettered'`);
  } else if (filters.statuses && filters.statuses.length > 0) {
    const placeholders = filters.statuses.map((_, index) => `$${values.length + index + 1}`).join(", ");
    values.push(...filters.statuses);
    conditions.push(`status IN (${placeholders})`);
  }

  if (filters.taskTypes && filters.taskTypes.length > 0) {
    const placeholders = filters.taskTypes.map((_, index) => `$${values.length + index + 1}`).join(", ");
    values.push(...filters.taskTypes);
    conditions.push(`task_type IN (${placeholders})`);
  }

  if (filters.functionSlug) {
    values.push(filters.functionSlug);
    conditions.push(`function_slug = $${values.length}`);
  }

  if (filters.functionVersion) {
    values.push(filters.functionVersion);
    conditions.push(`function_version = $${values.length}`);
  }

  values.push(filters.limit || 50);

  return {
    sqlText: `
      SELECT *
      FROM project_tasks
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${values.length}
    `,
    values,
  };
}

export async function createTask(inputOrRef: CreateTaskInput | string, type?: TaskType, payload: Record<string, unknown> = {}): Promise<ProjectTask> {
  const input: CreateTaskInput =
    typeof inputOrRef === "string"
      ? { ref: inputOrRef, type: type!, payload }
      : inputOrRef;

  return withRetry("TaskRepository.createTask", async () => {
    const [task] = await sql`
      INSERT INTO project_tasks (
        project_ref,
        task_type,
        function_slug,
        function_version,
        status,
        payload,
        max_attempts,
        next_run_at,
        timeout_sec,
        idempotency_key,
        trace_id
      )
      VALUES (
        ${input.ref},
        ${input.type},
        ${input.functionSlug || null},
        ${input.functionVersion || null},
        ${input.status || TaskStatuses.PENDING},
        ${JSON.stringify(input.payload || {})},
        ${input.maxAttempts || 3},
        ${input.nextRunAt || new Date()},
        ${input.timeoutSec ?? null},
        ${input.idempotencyKey || null},
        ${input.traceId || null}
      )
      RETURNING *
    `;

    return mapTask(task);
  });
}

export async function createTasks(tasks: CreateTaskInput[]): Promise<void> {
  for (const task of tasks) {
    await createTask(task);
  }
}

export async function claimQueueMessage(options: ClaimQueueMessageOptions): Promise<LeasedTask | null> {
  const leaseSeconds = options.visibilityTimeoutSec || DEFAULT_LEASE_SECONDS;

  return withRetry("TaskRepository.claimQueueMessage", async () => {
    const [task] = await sql`
      WITH candidate AS (
        SELECT id
        FROM project_tasks
        WHERE project_ref = ${options.projectRef}
          AND task_type = ${options.queueName}
          AND status IN (${TaskStatuses.PENDING}, ${TaskStatuses.RETRY_SCHEDULED})
          AND COALESCE(next_run_at, created_at, NOW()) <= NOW()
          AND cancel_requested_at IS NULL
        ORDER BY COALESCE(next_run_at, created_at, NOW()) ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE project_tasks pt
      SET
        status = ${TaskStatuses.LEASED},
        attempt = COALESCE(pt.attempt, 0) + 1,
        retries = GREATEST(COALESCE(pt.attempt, 0), COALESCE(pt.retries, 0)) + 1,
        lease_until = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        started_at = COALESCE(pt.started_at, NOW()),
        updated_at = NOW()
      FROM candidate
      WHERE pt.id = candidate.id
      RETURNING pt.*
    `;

    return task ? (mapTask(task) as LeasedTask) : null;
  });
}

export async function claimNextTask(options: TaskLeaseOptions): Promise<LeasedTask | null> {
  const leaseSeconds = options.leaseSeconds || DEFAULT_LEASE_SECONDS;
  const allowedTaskTypes = options.allowedTaskTypes || [];

  return withRetry("TaskRepository.claimNextTask", async () => {
    const params: unknown[] = [
      TaskStatuses.LEASED,
      TaskStatuses.RUNNING,
      TaskStatuses.PENDING,
      TaskStatuses.RETRY_SCHEDULED,
    ];

    let taskTypeFilter = "";
    if (allowedTaskTypes.length > 0) {
      const typePlaceholders = allowedTaskTypes.map((_, i) => `$${params.length + i + 1}`).join(', ');
      taskTypeFilter = `AND pt.task_type IN (${typePlaceholders})`;
      params.push(...allowedTaskTypes);
    }

    params.push(TaskStatuses.LEASED);
    const leasedStatusIdx = params.length;
    params.push(leaseSeconds);
    const leaseSecondsIdx = params.length;

    const sqlText = `
      WITH candidate AS (
        SELECT pt.id
        FROM project_tasks pt
        JOIN projects p ON p.ref = pt.project_ref
        WHERE pt.status IN ($3, $4)
          AND COALESCE(pt.next_run_at, pt.created_at, NOW()) <= NOW()
          AND pt.cancel_requested_at IS NULL
          AND (
            SELECT COUNT(*)::int
            FROM project_tasks active
            WHERE active.project_ref = pt.project_ref
              AND active.task_type = pt.task_type
              AND active.status IN ($1, $2)
              AND active.lease_until IS NOT NULL
              AND active.lease_until > NOW()
          ) < GREATEST(
            1,
            COALESCE(
              NULLIF((p.config->'background_tasks'->>'concurrency'), '')::int,
              2
            )
          )
          ${taskTypeFilter}
        ORDER BY COALESCE(pt.next_run_at, pt.created_at, NOW()) ASC, pt.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE project_tasks pt
      SET
        status = $${leasedStatusIdx},
        attempt = COALESCE(pt.attempt, 0) + 1,
        retries = GREATEST(COALESCE(pt.attempt, 0), COALESCE(pt.retries, 0)) + 1,
        lease_until = NOW() + ($${leaseSecondsIdx} * INTERVAL '1 second'),
        started_at = COALESCE(pt.started_at, NOW()),
        updated_at = NOW()
      FROM candidate
      WHERE pt.id = candidate.id
      RETURNING pt.*
    `;

    const rows = await sql.unsafe(sqlText, params);
    const [task] = rows as unknown[];

    return task ? (mapTask(task) as LeasedTask) : null;
  });
}

export async function markTaskRunning(id: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.markTaskRunning", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET status = ${TaskStatuses.RUNNING}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function markTaskSucceeded(id: string, result?: Record<string, unknown> | null): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.markTaskSucceeded", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.SUCCEEDED},
        result = ${result ? JSON.stringify(result) : null},
        error = NULL,
        lease_until = NULL,
        cancel_requested_at = NULL,
        cancellation_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function acknowledgeQueueMessage(id: string, result?: Record<string, unknown> | null): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.acknowledgeQueueMessage", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.SUCCEEDED},
        result = ${result ? JSON.stringify(result) : null},
        error = NULL,
        lease_until = NULL,
        cancel_requested_at = NULL,
        cancellation_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND status IN (${TaskStatuses.LEASED}, ${TaskStatuses.RUNNING})
        AND lease_until IS NOT NULL
        AND lease_until > NOW()
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function scheduleRetry(id: string, error: string, nextRunAt: Date): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.scheduleRetry", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.RETRY_SCHEDULED},
        error = ${error},
        lease_until = NULL,
        next_run_at = ${nextRunAt},
        cancel_requested_at = NULL,
        cancellation_reason = NULL,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function markTaskFailed(id: string, error: string, deadLetter = false): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.markTaskFailed", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${deadLetter ? TaskStatuses.DEAD_LETTERED : TaskStatuses.FAILED},
        error = ${error},
        lease_until = NULL,
        cancel_requested_at = NULL,
        cancellation_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function cancelTask(id: string, error?: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.cancelTask", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.CANCELLED},
        error = ${error || null},
        lease_until = NULL,
        cancel_requested_at = NOW(),
        cancellation_reason = ${error || "Cancelled by user"},
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function updateStatus(id: string, status: TaskStatus, error?: string): Promise<ProjectTask | null> {
  switch (status) {
    case TaskStatuses.RUNNING:
      return markTaskRunning(id);
    case TaskStatuses.SUCCEEDED:
      return markTaskSucceeded(id);
    case TaskStatuses.CANCELLED:
      return cancelTask(id, error);
    case TaskStatuses.FAILED:
    case TaskStatuses.DEAD_LETTERED:
      return markTaskFailed(id, error || "Task execution failed", status === TaskStatuses.DEAD_LETTERED);
    default:
      return withRetry("TaskRepository.updateStatus", async () => {
        const [task] = await sql`
          UPDATE project_tasks
          SET status = ${status}, error = ${error || null}, updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `;
        return task ? mapTask(task) : null;
      });
  }
}

export async function updateTaskError(id: string, error: string): Promise<void> {
  await withRetry("TaskRepository.updateTaskError", async () => {
    await sql`
      UPDATE project_tasks
      SET error = ${error}, updated_at = NOW()
      WHERE id = ${id}
    `;
  });
}

export async function getTaskById(id: string, projectRef?: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.getTaskById", async () => {
    const rows = projectRef
      ? await sql`SELECT * FROM project_tasks WHERE id = ${id} AND project_ref = ${projectRef} LIMIT 1`
      : await sql`SELECT * FROM project_tasks WHERE id = ${id} LIMIT 1`;
    return rows[0] ? mapTask(rows[0]) : null;
  });
}

export async function getTaskByIdAndType(id: string, projectRef: string, taskType: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.getTaskByIdAndType", async () => {
    const [task] = await sql`
      SELECT *
      FROM project_tasks
      WHERE id = ${id}
        AND project_ref = ${projectRef}
        AND task_type = ${taskType}
      LIMIT 1
    `;
    return task ? mapTask(task) : null;
  });
}

export async function listTasksByProject(projectRef: string, limit = 50): Promise<ProjectTask[]> {
  return withRetry("TaskRepository.listTasksByProject", async () => {
    const rows = await sql`
      SELECT *
      FROM project_tasks
      WHERE project_ref = ${projectRef}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapTask);
  });
}

export async function listTasksByProjectFiltered(projectRef: string, filters: TaskListFilters = {}): Promise<ProjectTask[]> {
  return withRetry("TaskRepository.listTasksByProjectFiltered", async () => {
    const { sqlText, values } = buildTaskListQuery(projectRef, filters);
    const rows = await sql.unsafe(sqlText, values);
    return (rows as unknown[]).map(mapTask);
  });
}

export async function retryTask(id: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.retryTask", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.PENDING},
        error = NULL,
        lease_until = NULL,
        next_run_at = NOW(),
        completed_at = NULL,
        cancel_requested_at = NULL,
        cancellation_reason = NULL,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

  export async function countActiveTasksForProject(projectRef: string, taskTypes?: string[]): Promise<number> {
    return withRetry("TaskRepository.countActiveTasksForProject", async () => {
      if (taskTypes && taskTypes.length > 0) {
        const typePlaceholders = taskTypes.map((_, i) => `$${4 + i}`).join(', ');
        const rows = await sql.unsafe(
          `
            SELECT COUNT(*)::int AS count
            FROM project_tasks
            WHERE project_ref = $1
              AND status IN ($2, $3)
              AND lease_until IS NOT NULL
              AND lease_until > NOW()
              AND task_type IN (${typePlaceholders})
          `,
          [projectRef, TaskStatuses.LEASED, TaskStatuses.RUNNING, ...taskTypes],
        );
        return Number(rows[0]?.count || 0);
      }

    const rows = await sql`
      SELECT COUNT(*)::int AS count
      FROM project_tasks
      WHERE project_ref = ${projectRef}
        AND status IN (${TaskStatuses.LEASED}, ${TaskStatuses.RUNNING})
        AND lease_until IS NOT NULL
        AND lease_until > NOW()
    `;
    return Number(rows[0]?.count || 0);
  });
}

export async function releaseTask(id: string, nextRunAt: Date, error?: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.releaseTask", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        status = ${TaskStatuses.PENDING},
        error = ${error || null},
        lease_until = NULL,
        next_run_at = ${nextRunAt},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function extendLease(id: string, leaseSeconds: number): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.extendLease", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        lease_until = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        updated_at = NOW()
      WHERE id = ${id} AND cancel_requested_at IS NULL
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function requestTaskCancellation(id: string, reason: string): Promise<ProjectTask | null> {
  return withRetry("TaskRepository.requestTaskCancellation", async () => {
    const [task] = await sql`
      UPDATE project_tasks
      SET
        cancel_requested_at = NOW(),
        cancellation_reason = ${reason},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return task ? mapTask(task) : null;
  });
}

export async function startTaskAttempt(task: ProjectTask): Promise<ProjectTaskAttempt> {
  return withRetry("TaskRepository.startTaskAttempt", async () => {
    const [attempt] = await sql`
      INSERT INTO project_task_attempts (
        task_id,
        project_ref,
        attempt_no,
        status,
        started_at
      )
      VALUES (
        ${task.id},
        ${task.project_ref},
        ${task.attempt || 1},
        'running',
        NOW()
      )
      ON CONFLICT (task_id, attempt_no)
      DO UPDATE SET
        status = 'running',
        started_at = NOW(),
        completed_at = NULL,
        duration_ms = NULL,
        error = NULL,
        response_status = NULL,
        updated_at = NOW()
      RETURNING *
    `;
    return mapAttempt(attempt);
  });
}

export async function completeTaskAttempt(
  taskId: string,
  attemptNo: number,
  input: {
    status: string;
    error?: string | null;
    responseStatus?: number | null;
    durationMs?: number | null;
    logs?: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> | null;
  },
): Promise<ProjectTaskAttempt | null> {
  return withRetry("TaskRepository.completeTaskAttempt", async () => {
    const [attempt] = await sql`
      UPDATE project_task_attempts
      SET
        status = ${input.status},
        error = ${input.error || null},
        response_status = ${input.responseStatus ?? null},
        duration_ms = ${input.durationMs ?? null},
        logs = ${JSON.stringify(input.logs || [])}::jsonb,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE task_id = ${taskId} AND attempt_no = ${attemptNo}
      RETURNING *
    `;
    return attempt ? mapAttempt(attempt) : null;
  });
}

export async function listTaskAttempts(taskId: string): Promise<ProjectTaskAttempt[]> {
  return withRetry("TaskRepository.listTaskAttempts", async () => {
    const rows = await sql`
      SELECT *
      FROM project_task_attempts
      WHERE task_id = ${taskId}
      ORDER BY attempt_no DESC
    `;
    return rows.map(mapAttempt);
  });
}

export async function getTaskStats(projectRef: string): Promise<{
  running: number;
  retryScheduled: number;
  deadLettered: number;
  failedLast24h: number;
  cancelledLast24h: number;
  topFailures: Array<{ message: string; count: number }>;
  failedTrend: Array<{ bucket: string; failures: number }>;
}> {
  return withRetry("TaskRepository.getTaskStats", async () => {
    const [summary] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN (${TaskStatuses.LEASED}, ${TaskStatuses.RUNNING}))::int AS running,
        COUNT(*) FILTER (WHERE status = ${TaskStatuses.RETRY_SCHEDULED})::int AS retry_scheduled,
        COUNT(*) FILTER (WHERE status = ${TaskStatuses.DEAD_LETTERED})::int AS dead_lettered,
        COUNT(*) FILTER (
          WHERE status IN (${TaskStatuses.FAILED}, ${TaskStatuses.DEAD_LETTERED})
            AND updated_at >= NOW() - INTERVAL '24 hours'
        )::int AS failed_last_24h,
        COUNT(*) FILTER (
          WHERE status = ${TaskStatuses.CANCELLED}
            AND updated_at >= NOW() - INTERVAL '24 hours'
        )::int AS cancelled_last_24h
      FROM project_tasks
      WHERE project_ref = ${projectRef}
    `;

    const trendRows = await sql`
      SELECT
        to_char(date_trunc('hour', updated_at), 'MM-DD HH24:00') AS bucket,
        COUNT(*)::int AS failures
      FROM project_tasks
      WHERE project_ref = ${projectRef}
        AND status IN (${TaskStatuses.FAILED}, ${TaskStatuses.DEAD_LETTERED})
        AND updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const topFailureRows = await sql`
      SELECT
        COALESCE(NULLIF(error, ''), 'Unknown error') AS message,
        COUNT(*)::int AS count
      FROM project_tasks
      WHERE project_ref = ${projectRef}
        AND status IN (${TaskStatuses.FAILED}, ${TaskStatuses.DEAD_LETTERED})
        AND updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY count DESC, message ASC
      LIMIT 5
    `;

    return {
      running: Number(summary?.running || 0),
      retryScheduled: Number(summary?.retry_scheduled || 0),
      deadLettered: Number(summary?.dead_lettered || 0),
      failedLast24h: Number(summary?.failed_last_24h || 0),
      cancelledLast24h: Number(summary?.cancelled_last_24h || 0),
      topFailures: topFailureRows.map((row: { message: string; count: number | string }) => ({
        message: String(row.message),
        count: Number(row.count || 0),
      })),
      failedTrend: trendRows.map((row: { bucket: string; failures: number | string }) => ({
        bucket: String(row.bucket),
        failures: Number(row.failures || 0),
      })),
    };
  });
}

export const taskRepository = {
  createTask,
  createTasks,
  claimQueueMessage,
  claimNextTask,
  markTaskRunning,
  markTaskSucceeded,
  acknowledgeQueueMessage,
  scheduleRetry,
  markTaskFailed,
  cancelTask,
  updateStatus,
  updateTaskError,
  getTaskById,
  getTaskByIdAndType,
  listTasksByProject,
  listTasksByProjectFiltered,
  buildTaskListQuery,
  retryTask,
  countActiveTasksForProject,
  releaseTask,
  extendLease,
  requestTaskCancellation,
  startTaskAttempt,
  completeTaskAttempt,
  listTaskAttempts,
  getTaskStats,
};
