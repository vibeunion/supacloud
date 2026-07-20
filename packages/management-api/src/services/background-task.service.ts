import { sql, type ProjectTask, TaskStatus, TaskType, getProjectDb, resolveDbName } from "../db";
import { withRetry } from "../utils/retry";
import { encryptSecretIfNeeded } from "../utils/secret-crypto";
import { normalizedGoTrueUserId } from "../utils/project-user-lifecycle";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";

export interface BackgroundFunctionAuthContext {
  kind: "jwt" | "apikey" | "none";
  authorization?: string | null;
  apikey?: string | null;
  invoker_user_id?: string | null;
  invoker_role?: string | null;
  apikey_kind?: string | null;
}

export interface BackgroundFunctionInvocationEnvelope {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
  body_encoding: "utf8";
  auth: BackgroundFunctionAuthContext;
  requested_timeout_sec: number;
}

export interface EnqueueBackgroundFunctionTaskInput {
  projectRef: string;
  functionSlug: string;
  functionVersion?: string | null;
  envelope: BackgroundFunctionInvocationEnvelope;
  timeoutSec: number;
  maxAttempts: number;
  maxPayloadBytes?: number;
  idempotencyKey?: string | null;
  traceId: string;
}

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_MAX_ATTEMPTS = 10;

export function normalizeBackgroundTaskTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_TIMEOUT_SEC;
  const rounded = Math.floor(value);
  return Math.max(1, Math.min(MAX_TIMEOUT_SEC, rounded));
}

export function normalizeBackgroundTaskMaxAttempts(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_MAX_ATTEMPTS;
  const rounded = Math.floor(value);
  return Math.max(1, Math.min(MAX_MAX_ATTEMPTS, rounded));
}

export async function enqueueBackgroundFunctionTask(
  input: EnqueueBackgroundFunctionTaskInput,
): Promise<ProjectTask> {
  const timeoutSec = normalizeBackgroundTaskTimeout(input.timeoutSec);
  const maxAttempts = normalizeBackgroundTaskMaxAttempts(input.maxAttempts);
  const rawInvokerUserId = input.envelope.auth.invoker_user_id;
  const invokerUserId = rawInvokerUserId
    ? normalizedGoTrueUserId(rawInvokerUserId)
    : null;
  if (rawInvokerUserId && !invokerUserId) {
    throw new Error("Background invoker user id must be a GoTrue UUID");
  }
  const authAuthorityRef = getAuthRuntimeDescriptor(input.projectRef).authority_project_ref;
  const envelope: BackgroundFunctionInvocationEnvelope = {
    ...input.envelope,
    auth: {
      ...input.envelope.auth,
      invoker_user_id: invokerUserId,
      authorization: input.envelope.auth.authorization
        ? encryptSecretIfNeeded(input.envelope.auth.authorization)
        : null,
      apikey: input.envelope.auth.apikey
        ? encryptSecretIfNeeded(input.envelope.auth.apikey)
        : null,
    },
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  const maxPayloadBytes = input.maxPayloadBytes || 256 * 1024;
  if (payloadBytes > maxPayloadBytes) {
    throw new Error(`Async payload too large (${payloadBytes} bytes > ${maxPayloadBytes} bytes)`);
  }

  return withRetry("BackgroundTaskService.enqueueBackgroundFunctionTask", async () => {
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
        trace_id,
        invoker_user_id,
        auth_authority_ref
      )
      VALUES (
        ${input.projectRef},
        ${TaskType.EDGE_FUNCTION},
        ${input.functionSlug},
        ${input.functionVersion || null},
        ${TaskStatus.PENDING},
        ${JSON.stringify(envelope)},
        ${maxAttempts},
        NOW(),
        ${timeoutSec},
        ${input.idempotencyKey || null},
        ${input.traceId},
        ${invokerUserId}::uuid,
        ${authAuthorityRef}
      )
      ON CONFLICT (project_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;

    return task as ProjectTask;
  });
}

/**
 * mirror 只记录租户侧执行证据；worker 仍须在 dispatch 前直读 auth.users 授权。
 * 这里的 userExists 仅解释为何没有写入证据，不能替代最终授权判断。
 */
export async function createBackgroundTaskMirrorIfUserExists(
  task: ProjectTask,
): Promise<{ inserted: boolean; userExists: boolean; degraded?: boolean }> {
  const payload = (task.payload || {}) as {
    auth?: { invoker_user_id?: string | null };
  };
  const userId = payload.auth?.invoker_user_id
    ? normalizedGoTrueUserId(payload.auth.invoker_user_id)
    : null;
  if (!userId) {
    return { inserted: false, userExists: true };
  }

  try {
    const dbName = await resolveDbName(task.project_ref);
    const projectDb = getProjectDb(dbName);

    const [tableCheck] = await projectDb`
      SELECT to_regclass('public.background_task_mirrors') IS NOT NULL AS exists
    `;
    if (!tableCheck?.exists) {
      const { logger } = await import("../utils/logger");
      logger.warn("[BackgroundTaskService] background_task_mirrors table not found, mirror degraded", {
        taskId: task.id,
        projectRef: task.project_ref,
      });
      return { inserted: false, userExists: true, degraded: true };
    }

    const [mirrorRow] = await projectDb`
      INSERT INTO public.background_task_mirrors (
        id, project_ref, task_type, function_slug, status,
        invoker_user_id, attempt, max_attempts, trace_id, created_at
      )
      SELECT
        ${task.id}::uuid,
        ${task.project_ref},
        ${task.task_type},
        ${task.function_slug || null},
        ${TaskStatus.RUNNING},
        ${userId}::uuid,
        ${task.attempt || 1},
        ${task.max_attempts},
        ${task.trace_id || null},
        NOW()
      WHERE EXISTS (
        SELECT 1 FROM auth.users WHERE id = ${userId}::uuid AND deleted_at IS NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        attempt = EXCLUDED.attempt,
        max_attempts = EXCLUDED.max_attempts,
        trace_id = EXCLUDED.trace_id,
        updated_at = NOW()
      RETURNING id
    `;

    if (mirrorRow?.id) {
      return { inserted: true, userExists: true };
    }

    const [userCheck] = await projectDb`
      SELECT 1 FROM auth.users WHERE id = ${userId}::uuid AND deleted_at IS NULL LIMIT 1
    `;
    return { inserted: false, userExists: !!userCheck };
  } catch (error: unknown) {
    const { logger } = await import("../utils/logger");
    logger.warn("[BackgroundTaskService] mirror insert failed (degraded)", {
      taskId: task.id,
      projectRef: task.project_ref,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { inserted: false, userExists: true, degraded: true };
  }
}

export async function removeBackgroundTaskMirror(task: ProjectTask): Promise<boolean> {
  const payload = (task.payload || {}) as { auth?: { invoker_user_id?: string | null } };
  if (!payload.auth?.invoker_user_id) return true;
  try {
    const projectDb = getProjectDb(await resolveDbName(task.project_ref));
    await projectDb`
      DELETE FROM public.background_task_mirrors
      WHERE id = ${task.id}::uuid
    `;
    return true;
  } catch (error: unknown) {
    const { logger } = await import("../utils/logger");
    logger.warn("[BackgroundTaskService] terminal mirror cleanup failed", {
      taskId: task.id,
      projectRef: task.project_ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export const backgroundTaskService = {
  enqueueBackgroundFunctionTask,
  normalizeBackgroundTaskTimeout,
  normalizeBackgroundTaskMaxAttempts,
  createBackgroundTaskMirrorIfUserExists,
  removeBackgroundTaskMirror,
};
