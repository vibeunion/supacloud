import { sql, type ProjectTask, TaskStatus, TaskType, getProjectDb, resolveDbName } from "../db";
import { withRetry } from "../utils/retry";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";
import { normalizedGoTrueUserId } from "../utils/project-user-lifecycle";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import type { TaskTraceEnvelope } from "../utils/task-trace";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_TASK_SETTING_LIMITS, DEFAULT_BACKGROUND_TASK_SETTINGS } from "../config/background-task-settings";
import { isRecord } from "../utils/project-config";
import { copyTaskJson, InvalidTaskRecordError, parseTaskRecord } from "../utils/task-record";
import { InvalidBackgroundInvocationError, parseBackgroundInvocation } from "../utils/background-invocation";
import { ConflictError } from "../utils/errors";

export interface BackgroundFunctionAuthContext {
  kind: "jwt" | "apikey" | "none";
  authorization?: string | null;
  apikey?: string | null;
  invoker_user_id?: string | null;
  invoker_role?: string | null;
  apikey_kind?: string | null;
}

export interface BackgroundFunctionInvocationEnvelope {
  trace?: TaskTraceEnvelope;
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

export class BackgroundTaskIdempotencyConflictError extends ConflictError {
  constructor() {
    super("Idempotency key is already bound to a different background invocation");
    this.name = "BackgroundTaskIdempotencyConflictError";
    Object.defineProperty(this, "code", { value: "TASK_IDEMPOTENCY_CONFLICT", enumerable: true });
  }
}

function invocationReplayIdentity(value: unknown) {
  const invocation = parseBackgroundInvocation(value);
  const auth = invocation.auth ?? {};
  const headers = new Headers(invocation.headers);
  for (const name of ["traceparent", "tracestate", "baggage", "x-supacloud-trace-id", "x-request-id"]) {
    headers.delete(name);
  }
  return {
    method: invocation.method,
    path: invocation.path,
    query: invocation.query,
    body: invocation.body,
    body_encoding: invocation.body_encoding,
    requested_timeout_sec: invocation.requested_timeout_sec ?? null,
    headers: Object.fromEntries(headers),
    auth: {
      kind: auth.kind ?? null,
      invoker_user_id: auth.invoker_user_id ?? null,
      invoker_role: auth.invoker_role ?? null,
      apikey_kind: auth.apikey_kind ?? null,
    },
  };
}

function invocationReplayCredentials(value: unknown) {
  const auth = parseBackgroundInvocation(value).auth ?? {};
  return {
    authorization: auth.authorization ? decryptSecretIfNeeded(auth.authorization) : null,
    apikey: auth.apikey ? decryptSecretIfNeeded(auth.apikey) : null,
  };
}

function captureEnqueueInput(value: unknown): EnqueueBackgroundFunctionTaskInput {
  let captured: unknown;
  try {
    captured = copyTaskJson(value);
  } catch {
    throw new InvalidBackgroundInvocationError();
  }
  if (!isRecord(captured)) throw new InvalidBackgroundInvocationError();
  const allowed = new Set([
    "projectRef", "functionSlug", "functionVersion", "envelope", "timeoutSec",
    "maxAttempts", "maxPayloadBytes", "idempotencyKey", "traceId",
  ]);
  if (Object.keys(captured).some((key) => !allowed.has(key))) {
    throw new InvalidBackgroundInvocationError();
  }
  const {
    projectRef, functionSlug, functionVersion, envelope: rawEnvelope,
    timeoutSec, maxAttempts, maxPayloadBytes, idempotencyKey, traceId,
  } = captured;
  if (typeof projectRef !== "string" || projectRef.length === 0
    || typeof functionSlug !== "string" || functionSlug.length === 0
    || typeof traceId !== "string" || traceId.length === 0
    || typeof timeoutSec !== "number" || typeof maxAttempts !== "number"
    || (maxPayloadBytes !== undefined && typeof maxPayloadBytes !== "number")
    || (functionVersion !== undefined && functionVersion !== null && typeof functionVersion !== "string")
    || (idempotencyKey !== undefined && idempotencyKey !== null && typeof idempotencyKey !== "string")
    || !isRecord(rawEnvelope)) {
    throw new InvalidBackgroundInvocationError();
  }
  const requiredEnvelopeKeys = [
    "method", "path", "query", "headers", "body", "body_encoding", "auth", "requested_timeout_sec",
  ];
  if (requiredEnvelopeKeys.some((key) => !Object.hasOwn(rawEnvelope, key))) {
    throw new InvalidBackgroundInvocationError();
  }
  const parsedEnvelope = parseBackgroundInvocation(rawEnvelope);
  const auth = parsedEnvelope.auth;
  if (!auth || auth.kind === undefined || parsedEnvelope.requested_timeout_sec === undefined) {
    throw new InvalidBackgroundInvocationError();
  }
  const envelope: BackgroundFunctionInvocationEnvelope = {
    method: parsedEnvelope.method ?? "POST",
    path: parsedEnvelope.path ?? "",
    query: parsedEnvelope.query ?? "",
    headers: parsedEnvelope.headers ?? {},
    body: parsedEnvelope.body ?? null,
    body_encoding: "utf8",
    auth: { ...auth, kind: auth.kind },
    requested_timeout_sec: parsedEnvelope.requested_timeout_sec,
    ...(parsedEnvelope.trace === undefined ? {} : { trace: { ...parsedEnvelope.trace } }),
  };
  return {
    projectRef,
    functionSlug,
    timeoutSec,
    maxAttempts,
    traceId,
    ...(functionVersion === undefined ? {} : { functionVersion }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
    envelope,
  };
}

function normalizedIdempotencyKey(value: string | null | undefined): string | null {
  return value || null;
}

function taskReplayMatches(
  task: ProjectTask,
  input: EnqueueBackgroundFunctionTaskInput,
  envelope: BackgroundFunctionInvocationEnvelope,
  timeoutSec: number,
  maxAttempts: number,
  authAuthorityRef: string,
  invokerUserId: string | null,
): boolean {
  if (task.project_ref !== input.projectRef
    || task.task_type !== TaskType.EDGE_FUNCTION
    || task.function_slug !== input.functionSlug
    || task.function_version !== (input.functionVersion || null)
    || task.timeout_sec !== timeoutSec
    || task.max_attempts !== maxAttempts
    || task.idempotency_key !== normalizedIdempotencyKey(input.idempotencyKey)
    || task.invoker_user_id !== invokerUserId
    || task.auth_authority_ref !== authAuthorityRef) {
    return false;
  }
  try {
    return isDeepStrictEqual(invocationReplayIdentity(task.payload), invocationReplayIdentity(envelope))
      && isDeepStrictEqual(invocationReplayCredentials(task.payload), invocationReplayCredentials(envelope));
  } catch {
    throw new InvalidTaskRecordError();
  }
}

function assertPersistedTask(
  task: ProjectTask,
  input: EnqueueBackgroundFunctionTaskInput,
  envelope: BackgroundFunctionInvocationEnvelope,
  timeoutSec: number,
  maxAttempts: number,
  authAuthorityRef: string,
  invokerUserId: string | null,
  isNewTask: boolean,
): void {
  if (isNewTask && task.trace_id !== input.traceId) throw new InvalidTaskRecordError();
  if (!taskReplayMatches(task, input, envelope, timeoutSec, maxAttempts, authAuthorityRef, invokerUserId)) {
    throw new InvalidTaskRecordError();
  }
}

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
  input = captureEnqueueInput(input);
  if (!Number.isFinite(input.timeoutSec) || input.timeoutSec <= 0
    || !Number.isFinite(input.maxAttempts) || input.maxAttempts <= 0
    || (input.maxPayloadBytes !== undefined && (!Number.isSafeInteger(input.maxPayloadBytes)
      || input.maxPayloadBytes <= 0
      || input.maxPayloadBytes > BACKGROUND_TASK_SETTING_LIMITS.max_payload_bytes.max))) {
    throw new InvalidBackgroundInvocationError();
  }
  const timeoutSec = normalizeBackgroundTaskTimeout(input.timeoutSec);
  const maxAttempts = normalizeBackgroundTaskMaxAttempts(input.maxAttempts);
  const rawInvokerUserId = input.envelope.auth.invoker_user_id;
  const invokerUserId = rawInvokerUserId
    ? normalizedGoTrueUserId(rawInvokerUserId)
    : null;
  if (rawInvokerUserId && !invokerUserId) {
    throw new InvalidBackgroundInvocationError();
  }
  const authAuthorityRef = getAuthRuntimeDescriptor(input.projectRef).authority_project_ref;
  const envelope: BackgroundFunctionInvocationEnvelope = {
    ...input.envelope,
    headers: Object.fromEntries(new Headers(input.envelope.headers)),
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
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_BACKGROUND_TASK_SETTINGS.max_payload_bytes;
  if (payloadBytes > maxPayloadBytes) {
    throw new Error(`Async payload too large (${payloadBytes} bytes > ${maxPayloadBytes} bytes)`);
  }

  try {
    invocationReplayCredentials(envelope);
  } catch {
    throw new InvalidBackgroundInvocationError();
  }

  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  return withRetry(
    "BackgroundTaskService.enqueueBackgroundFunctionTask",
    () => sql.begin(async (transaction) => {
      const insertTask = () => transaction`
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
          ${JSON.stringify(envelope)}::jsonb,
          ${maxAttempts},
          NOW(),
          ${timeoutSec},
          ${idempotencyKey},
          ${input.traceId},
          ${invokerUserId}::uuid,
          ${authAuthorityRef}
        )
        RETURNING *
      `;

      let rows: unknown[];
      let isNewTask = true;
      if (idempotencyKey) {
        const existingRows: unknown[] = await transaction`
          SELECT *
          FROM project_tasks
          WHERE project_ref = ${input.projectRef}
            AND idempotency_key = ${idempotencyKey}
          FOR UPDATE
        `;
        if (existingRows.length > 1) throw new InvalidTaskRecordError();
        const existingRow = existingRows[0];
        if (existingRow !== undefined) {
          const existingTask = parseTaskRecord(existingRow);
          if (!taskReplayMatches(
            existingTask, input, envelope, timeoutSec, maxAttempts, authAuthorityRef, invokerUserId,
          )) {
            throw new BackgroundTaskIdempotencyConflictError();
          }
          rows = await transaction`
            UPDATE project_tasks
            SET updated_at = NOW()
            WHERE id = ${existingTask.id}
              AND project_ref = ${input.projectRef}
              AND idempotency_key = ${idempotencyKey}
            RETURNING *
          `;
          isNewTask = false;
        } else {
          rows = await insertTask();
        }
      } else {
        rows = await insertTask();
      }

      if (rows.length !== 1) throw new InvalidTaskRecordError();
      const task = parseTaskRecord(rows[0]);
      assertPersistedTask(
        task, input, envelope, timeoutSec, maxAttempts, authAuthorityRef, invokerUserId, isNewTask,
      );
      return task;
    }),
    {
      shouldRetry: (error) => Boolean(idempotencyKey)
        && !(error instanceof InvalidTaskRecordError)
        && !(error instanceof InvalidBackgroundInvocationError)
        && !(error instanceof BackgroundTaskIdempotencyConflictError),
    },
  );
}

/**
 * The mirror records tenant-side execution evidence only; the worker must still read auth.users directly before dispatch.
 * userExists here merely explains why evidence was not recorded, and does not replace final authorization.
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
