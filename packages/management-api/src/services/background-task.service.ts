import { sql, type ProjectTask, TaskStatus, TaskType } from "../db";
import { withRetry } from "../utils/retry";
import { encryptSecretIfNeeded } from "../utils/secret-crypto";

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
  const envelope: BackgroundFunctionInvocationEnvelope = {
    ...input.envelope,
    auth: {
      ...input.envelope.auth,
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
        trace_id
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
        ${input.traceId}
      )
      ON CONFLICT (project_ref, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;

    return task as ProjectTask;
  });
}

export const backgroundTaskService = {
  enqueueBackgroundFunctionTask,
  normalizeBackgroundTaskTimeout,
  normalizeBackgroundTaskMaxAttempts,
};
