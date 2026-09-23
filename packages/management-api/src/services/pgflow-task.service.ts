import { getProjectDb, sql, type ProjectTask } from "../db";
import { projectRepository } from "../repositories/project.repository";
import { parseTaskRecord } from "../utils/task-record";
import { readPgmqProjectDatabase } from "../utils/pgmq-project";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";

export const PGFLOW_TASK_TYPE = "pgflow";

export class PgflowTaskError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

const idPattern =
  /^pgflow:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const isPgflowTask = (id: string): boolean => id.startsWith("pgflow:");

export class PgflowTaskReadError extends Error {
  constructor() {
    super("PGFLOW_TASKS_UNAVAILABLE");
    this.name = "PgflowTaskReadError";
  }
}

export interface PgflowTaskFilters {
  limit: number;
  statuses?: string[];
}

export interface PgflowTask {
  id: string;
  project_ref: string;
  task_type: "pgflow";
  status: "pending" | "running" | "retry_scheduled" | "succeeded" | "failed";
  executor: {
    kind: "pgflow";
    version: string;
    definition: string;
    run_id: string;
    native_status: string;
  };
  capabilities: { cancel: false; retry: false };
  blocked_reason: string | null;
  total_steps: number;
  finished_steps: number;
  created_at: Date;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
  error: string | null;
  result: unknown;
}

async function database(projectRef: string) {
  const project: unknown = await projectRepository.findByRef(projectRef);
  return getProjectDb(readPgmqProjectDatabase(project, projectRef));
}

interface PgflowObjects {
  runs: boolean;
  steps: boolean;
  stepTasks: boolean;
  installation: boolean;
  control: boolean;
  legacyState: boolean;
}

async function readPgflowObjects(db: ReturnType<typeof getProjectDb>): Promise<PgflowObjects> {
  const [objects] = await db<PgflowObjects[]>`
    SELECT
      to_regclass('pgflow.runs') IS NOT NULL AS runs,
      to_regclass('pgflow.step_states') IS NOT NULL AS steps,
      to_regclass('pgflow.step_tasks') IS NOT NULL AS "stepTasks",
      to_regclass('supacloud_worker.installation') IS NOT NULL AS installation,
      to_regclass('supacloud_worker.control') IS NOT NULL AS control,
      to_regclass('pgflow._supacloud_state') IS NOT NULL AS "legacyState"
  `;
  return objects ?? {
    runs: false,
    steps: false,
    stepTasks: false,
    installation: false,
    control: false,
    legacyState: false,
  };
}

async function hasManagedPgflow(db: ReturnType<typeof getProjectDb>, projectRef: string): Promise<boolean> {
  const objects = await readPgflowObjects(db);
  if (!objects.runs || !objects.steps || !objects.stepTasks) return false;

  if (objects.installation) {
    const [binding] = await db`
      SELECT project_ref, engine_version
      FROM supacloud_worker.installation
      WHERE singleton
    `;
    if (!binding || binding.project_ref !== projectRef || binding.engine_version !== "0.16.0") return false;
    if (objects.control) {
      const [control] = await db`SELECT enabled FROM supacloud_worker.control WHERE singleton`;
      if (!control) return false;
    }
    return true;
  }

  // FA's opt-in runtime predates the platform installation table. Its
  // database is already project-scoped, so the managed state marker is the
  // only binding available to the read-only observer.
  if (objects.legacyState) {
    const [state] = await db`
      SELECT version
      FROM pgflow._supacloud_state
      WHERE singleton
    `;
    return state?.version === "0.16.0";
  }

  return false;
}

async function readNativeTasks(
  db: ReturnType<typeof getProjectDb>,
  projectRef: string,
  filters: PgflowTaskFilters,
  runId?: string,
): Promise<PgflowTask[]> {
  const statusClause = filters.statuses === undefined
    ? db`TRUE`
    : db`(
        CASE r.status
          WHEN 'completed' THEN 'succeeded'
          WHEN 'failed' THEN 'failed'
          ELSE CASE
            WHEN task_stats.has_started THEN 'running'
            WHEN task_stats.has_retry THEN 'retry_scheduled'
            WHEN NOT coalesce(task_stats.has_attempted, false) THEN 'pending'
            ELSE 'running'
          END
        END
      ) = ANY(${db.array(filters.statuses, "TEXT")})`;
  const runClause = runId === undefined ? db`TRUE` : db`r.run_id = ${runId}::uuid`;
  return db<PgflowTask[]>`
    SELECT
      'pgflow:' || r.run_id::text AS id,
      ${projectRef}::text AS project_ref,
      'pgflow'::text AS task_type,
      CASE r.status
        WHEN 'completed' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        ELSE CASE
          WHEN task_stats.has_started THEN 'running'
          WHEN task_stats.has_retry THEN 'retry_scheduled'
          WHEN NOT coalesce(task_stats.has_attempted, false) THEN 'pending'
          ELSE 'running'
        END
      END AS status,
      jsonb_build_object(
        'kind', 'pgflow',
        'version', '0.16.0',
        'definition', r.flow_slug,
        'run_id', r.run_id,
        'native_status', r.status
      ) AS executor,
      jsonb_build_object('cancel', false, 'retry', false) AS capabilities,
      CASE
        WHEN r.status = 'started' AND task_stats.permanently_stalled
          THEN 'PGFLOW_PERMANENTLY_STALLED'
        ELSE NULL
      END AS blocked_reason,
      steps.total_steps,
      steps.finished_steps,
      r.started_at AS created_at,
      r.started_at,
      coalesce(r.completed_at, r.failed_at) AS completed_at,
      greatest(r.completed_at, r.failed_at, r.started_at, task_stats.updated_at, steps.updated_at) AS updated_at,
      CASE WHEN r.status = 'failed' THEN 'PGFLOW_RUN_FAILED' ELSE NULL END AS error,
      NULL::jsonb AS result
    FROM pgflow.runs r
    CROSS JOIN LATERAL (
      SELECT
        count(*)::int AS total_steps,
        count(*) FILTER (WHERE s.status IN ('completed', 'skipped'))::int AS finished_steps,
        max(greatest(s.created_at, s.started_at, s.completed_at, s.failed_at)) AS updated_at
      FROM pgflow.step_states s
      WHERE s.run_id = r.run_id
    ) steps
    CROSS JOIN LATERAL (
      SELECT
        bool_or(t.status = 'started') AS has_started,
        bool_or(t.status = 'queued' AND t.attempts_count > 0) AS has_retry,
        bool_or(t.attempts_count > 0) AS has_attempted,
        false AS permanently_stalled,
        max(greatest(t.queued_at, t.started_at, t.completed_at, t.failed_at)) AS updated_at
      FROM pgflow.step_tasks t
      WHERE t.run_id = r.run_id
    ) task_stats
    WHERE ${runClause}
      AND ${statusClause}
    ORDER BY r.started_at DESC, r.run_id DESC
    LIMIT ${Math.min(filters.limit, 200)}
  `;
}

export const pgflowTaskService = {
  async list(
    projectRef: string,
    filters: PgflowTaskFilters,
  ): Promise<PgflowTask[]> {
    try {
      const db = await database(projectRef);
      const [installed] = await db<
        { ready: boolean }[]
      >`SELECT to_regclass('supacloud_worker.tasks') IS NOT NULL AS ready`;
      if (installed?.ready) {
        return await db<PgflowTask[]>`
          SELECT * FROM supacloud_worker.tasks
          WHERE project_ref=${projectRef}
            AND (${filters.statuses === undefined} OR status=ANY(${db.array(filters.statuses ?? [], "TEXT")}))
          ORDER BY created_at DESC, id DESC LIMIT ${Math.min(filters.limit, 200)}
        `;
      }
      if (!await hasManagedPgflow(db, projectRef)) return [];
      return await readNativeTasks(db, projectRef, filters);
    } catch {
      throw new PgflowTaskReadError();
    }
  },
  async get(projectRef: string, id: string): Promise<PgflowTask | null> {
    if (!idPattern.test(id)) return null;
    try {
      const db = await database(projectRef);
      const [installed] = await db<
        { ready: boolean }[]
      >`SELECT to_regclass('supacloud_worker.tasks') IS NOT NULL AS ready`;
      if (installed?.ready) {
        const [task] = await db<PgflowTask[]>`
          SELECT * FROM supacloud_worker.tasks WHERE project_ref=${projectRef} AND id=${id}
        `;
        return task ?? null;
      }
      if (!await hasManagedPgflow(db, projectRef)) return null;
      const [task] = await readNativeTasks(db, projectRef, { limit: 1 }, id.slice("pgflow:".length));
      return task ?? null;
    } catch {
      throw new PgflowTaskReadError();
    }
  },
};

async function projectDatabase(ref: string) {
  const project = await projectRepository.findByRef(ref);
  if (!project) throw new PgflowTaskError(404, "Project not found");
  if (project.config?.pgflow_enabled !== true) {
    throw new PgflowTaskError(409, "pgflow is not enabled for this project");
  }
  if (!project.db_name) throw new PgflowTaskError(503, "Project database is unavailable");
  return getProjectDb(project.db_name);
}

/** Validate installation before accepting durable intent; do not install into tenants implicitly. */
async function checkFlow(ref: string, flowSlug: string): Promise<void> {
  const db = await projectDatabase(ref);
  const [capability] = await db`
        SELECT to_regprocedure('pgflow.start_flow(text,jsonb,uuid)') IS NOT NULL AS ready
    `;
  if (capability?.ready !== true) throw new PgflowTaskError(503, "pgflow installation is required");
  const rows = await db`SELECT flow_slug FROM pgflow.flows WHERE flow_slug = ${flowSlug}`;
  if (rows.length !== 1) throw new PgflowTaskError(404, "pgflow flow is not registered");
}

export async function startPgflowTask(
  ref: string,
  input: { flow_slug: string; input: unknown; idempotency_key: string },
): Promise<ProjectTask> {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(input.flow_slug)
    || !input.idempotency_key.trim() || input.idempotency_key.length > 200) {
    throw new PgflowTaskError(400, "Invalid flow slug or idempotency key");
  }
  const payload = { flow_slug: input.flow_slug, input: input.input };
  if (input.input === undefined || Buffer.byteLength(JSON.stringify(payload)) > 262144) {
    throw new PgflowTaskError(400, "Flow input is missing or exceeds 256 KiB");
  }
  await checkFlow(ref, input.flow_slug);
  const authority = getAuthRuntimeDescriptor(ref).authority_project_ref;
  const rows: unknown[] = await sql`
        INSERT INTO project_tasks (
            project_ref, task_type, status, payload, idempotency_key,
            auth_authority_ref, max_attempts
        ) VALUES (
            ${ref}, ${PGFLOW_TASK_TYPE}, 'pending', ${payload},
            ${input.idempotency_key}, ${authority}, 1
        )
        ON CONFLICT (project_ref, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO UPDATE SET idempotency_key = project_tasks.idempotency_key
        WHERE project_tasks.task_type = EXCLUDED.task_type
            AND project_tasks.payload = EXCLUDED.payload
        RETURNING *
    `;
  if (rows.length !== 1) throw new PgflowTaskError(409, "Idempotency key belongs to another request");
  return parseTaskRecord(rows[0]);
}

export function pgflowTaskStatus(status: unknown): "running" | "succeeded" | "failed" {
  if (status === "started") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  throw new PgflowTaskError(503, "Unsupported pgflow run status");
}

export async function reconcilePgflowTask(id: string, ref: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows: unknown[] = await tx`
            SELECT * FROM project_tasks WHERE id = ${id}::uuid AND project_ref = ${ref}
                AND task_type = ${PGFLOW_TASK_TYPE} AND status IN ('pending', 'running')
            FOR UPDATE SKIP LOCKED
        `;
    if (rows.length === 0) return;
    const task = parseTaskRecord(rows[0]);
    const db = await projectDatabase(ref);
    const flowInput = JSON.stringify(task.payload.input);
    const run = await db.begin(async (tenant) => {
      await tenant`SELECT pg_advisory_xact_lock(hashtextextended(${task.id}, 0))`;
      const existing = await tenant`
                SELECT *, input = ${flowInput}::text::jsonb AS input_matches
                FROM pgflow.runs WHERE run_id = ${task.id}::uuid
            `;
      if (existing.length > 0) {
        const receipt = existing[0];
        if (receipt.flow_slug !== task.payload.flow_slug || receipt.input_matches !== true) {
          throw new PgflowTaskError(409, "pgflow run identity conflict");
        }
        return receipt;
      }
      if (task.status !== "pending") throw new PgflowTaskError(503, "pgflow run is missing; refusing to replay");
      const created = await tenant`
                SELECT * FROM pgflow.start_flow(
                    ${task.payload.flow_slug}::text, ${flowInput}::text::jsonb, ${task.id}::uuid
                )
            `;
      if (created.length !== 1) throw new PgflowTaskError(503, "pgflow start receipt is missing");
      return created[0];
    });
    const status = pgflowTaskStatus(run.status);
    await tx`
            UPDATE project_tasks SET status = ${status},
                started_at = ${run.started_at},
                completed_at = ${run.completed_at ?? run.failed_at ?? null},
                result = ${status === "succeeded" ? { output: run.output } : null},
                error = ${status === "failed" ? "pgflow execution failed; inspect pgflow step states" : null},
                updated_at = NOW()
            WHERE id = ${task.id}::uuid AND project_ref = ${ref}
        `;
  });
}
