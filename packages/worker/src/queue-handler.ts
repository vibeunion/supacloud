import type { EdgeWorker, Json } from "@pgflow/edge-worker";

type UpstreamHandler = Parameters<typeof EdgeWorker.startQueueWorker>[0];
export interface TaskContext {
  readonly projectRef: string;
  readonly queueName: string;
  readonly taskKey: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}
export interface TaskHandler<T> {
  decode(input: unknown): T;
  /** Reauthorize entity/revision and original business intent, not the service-role identity. */
  authorize(input: T, context: TaskContext): boolean | Promise<boolean>;
  execute(input: T, context: TaskContext): void | Promise<void>;
}
export interface QueueBinding {
  readonly projectRef: string;
  readonly queueName: string;
  readonly taskKey: string;
}
type Failure =
  | "WORKER_TASK_INVALID"
  | "WORKER_TASK_FORBIDDEN"
  | "WORKER_TASK_FAILED"
  | "WORKER_SHUTTING_DOWN";
export class WorkerTaskError extends Error {
  constructor(readonly code: Failure) {
    super(code);
    // pgflow preserves the lease on AbortError instead of consuming retry budget.
    this.name =
      code === "WORKER_SHUTTING_DOWN" ? "AbortError" : "WorkerTaskError";
  }
}
function messageIdentity(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  // postgres returns int8 as text although the pinned upstream declaration says number.
  if (
    typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
    return value;
  throw new WorkerTaskError("WORKER_TASK_INVALID");
}
function object(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createQueueHandler<T>(
  binding: QueueBinding,
  handlers: TaskHandler<T>,
): UpstreamHandler {
  const { projectRef, queueName, taskKey } = binding;
  const { decode, authorize, execute } = handlers;
  return async (payload, upstream) => {
    if (upstream.shutdownSignal.aborted)
      throw new WorkerTaskError("WORKER_SHUTTING_DOWN");
    if (
      !object(payload) ||
      payload.schemaVersion !== 1 ||
      payload.projectRef !== projectRef ||
      payload.taskKey !== taskKey ||
      typeof payload.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(payload.idempotencyKey) ||
      !Object.hasOwn(payload, "input") ||
      Object.keys(payload).some(
        (key) =>
          ![
            "schemaVersion",
            "projectRef",
            "taskKey",
            "idempotencyKey",
            "input",
          ].includes(key),
      )
    ) {
      throw new WorkerTaskError("WORKER_TASK_INVALID");
    }
    const { msg_id: rawId, read_ct: attempt } = upstream.rawMessage;
    const messageId = messageIdentity(rawId);
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new WorkerTaskError("WORKER_TASK_INVALID");
    const context: TaskContext = Object.freeze({
      projectRef,
      queueName,
      taskKey,
      idempotencyKey: payload.idempotencyKey,
      messageId,
      attempt,
      signal: upstream.shutdownSignal,
    });
    let input: T;
    try {
      input = decode(payload.input);
    } catch {
      throw new WorkerTaskError("WORKER_TASK_INVALID");
    }
    let allowed: boolean;
    try {
      allowed = await authorize(input, context);
    } catch {
      throw new WorkerTaskError(
        context.signal.aborted ? "WORKER_SHUTTING_DOWN" : "WORKER_TASK_FAILED",
      );
    }
    if (context.signal.aborted)
      throw new WorkerTaskError("WORKER_SHUTTING_DOWN");
    if (allowed !== true) throw new WorkerTaskError("WORKER_TASK_FORBIDDEN");
    try {
      await execute(input, context);
    } catch {
      throw new WorkerTaskError(
        context.signal.aborted ? "WORKER_SHUTTING_DOWN" : "WORKER_TASK_FAILED",
      );
    }
    // Shutdown is cooperative, not proof of rollback. Idempotency must cover a retry.
    if (context.signal.aborted)
      throw new WorkerTaskError("WORKER_SHUTTING_DOWN");
  };
}
