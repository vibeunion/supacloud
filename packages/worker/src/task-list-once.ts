import type { EdgeWorker, Json } from "@pgflow/edge-worker";
import { createQueueHandler, WorkerTaskError, type QueueBinding, type TaskHandler } from "./queue-handler.js";
import { stableJobKey, validateJobKey, validateQueueName } from "./job-policy.js";

export interface TaskListMessage {
  readonly messageId: string;
  readonly payload: Json;
  readonly attempt?: number;
  readonly jobKey?: string;
}
export type TaskListOnceResult =
  | { readonly messageId: string; readonly status: "succeeded"; readonly attempt: number }
  | { readonly messageId: string; readonly status: "failed"; readonly attempt: number; readonly code: string };

/** Local fixtures only: uses the same decoding, authorization and redaction boundary as a queue worker. */
export async function runTaskListOnce<T>(
  messages: readonly TaskListMessage[],
  binding: QueueBinding,
  handler: TaskHandler<T>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<TaskListOnceResult[]> {
  if (!binding || typeof binding.projectRef !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(binding.projectRef)
    || typeof binding.taskKey !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(binding.taskKey)) {
    throw new Error("WORKER_QUEUE_INVALID");
  }
  validateQueueName(binding.queueName);
  if (!handler || ![handler.decode, handler.authorize, handler.execute].every(value => typeof value === "function")) {
    throw new Error("WORKER_HANDLER_INVALID");
  }
  if (!Array.isArray(messages) || messages.length > 10000) throw new Error("WORKER_TASK_INVALID");
  const run = createQueueHandler(binding, handler);
  // Capture and validate all routing metadata before any task has effects.
  const captured = messages.map(message => {
    if (!message || typeof message.messageId !== "string" || !/^[1-9][0-9]{0,18}$/.test(message.messageId)
      || BigInt(message.messageId) > 9223372036854775807n) throw new Error("WORKER_TASK_INVALID");
    const attempt = message.attempt === undefined ? 1 : message.attempt;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("WORKER_TASK_INVALID");
    const envelope: Json = {
      schemaVersion: binding.definitionVersion === undefined ? 1 : 2,
      projectRef: binding.projectRef,
      taskKey: binding.taskKey,
      idempotencyKey: stableJobKey(binding.queueName, message.messageId),
      input: message.payload,
      ...(message.jobKey === undefined ? {} : { jobKey: validateJobKey(message.jobKey) }),
      ...(binding.definitionVersion === undefined ? {} : { definitionVersion: binding.definitionVersion }),
    };
    return { messageId: message.messageId, attempt, envelope };
  });
  const results: TaskListOnceResult[] = [];
  const signal = options.signal ?? new AbortController().signal;
  for (const message of captured) {
    signal.throwIfAborted();
    try {
      // The adapter reads only these two upstream fields; no database resources are synthesized.
      const context = { shutdownSignal: signal, rawMessage: { msg_id: message.messageId, read_ct: message.attempt } };
      await run(message.envelope, context as unknown as Parameters<Parameters<typeof EdgeWorker.startQueueWorker>[0]>[1]);
      results.push({ messageId: message.messageId, status: "succeeded", attempt: message.attempt });
    } catch (error) {
      signal.throwIfAborted();
      results.push({ messageId: message.messageId, status: "failed", attempt: message.attempt,
        code: error instanceof WorkerTaskError ? error.code : "WORKER_TASK_FAILED" });
    }
  }
  return results;
}
