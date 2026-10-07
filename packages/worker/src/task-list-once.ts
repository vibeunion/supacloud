import type { Json } from "@pgflow/edge-worker";
import type { TaskContext, TaskHandler } from "./queue-handler.js";

export interface TaskListMessage {
  readonly messageId: string;
  readonly payload: Json;
  readonly attempt?: number;
  readonly jobKey?: string;
}

export type TaskListOnceResult =
  | { readonly messageId: string; readonly status: "succeeded"; readonly attempt: number }
  | { readonly messageId: string; readonly status: "failed"; readonly attempt: number; readonly code: string };

/**
 * Executes a finite message list without opening a database connection.
 * This is intended for deterministic local tests and replay fixtures.
 */
export async function runTaskListOnce<T>(
  messages: readonly TaskListMessage[],
  binding: {
    readonly projectRef: string;
    readonly queueName: string;
    readonly taskKey: string;
  },
  handler: TaskHandler<T>,
): Promise<TaskListOnceResult[]> {
  const results: TaskListOnceResult[] = [];
  for (const message of messages) {
    const attempt = message.attempt ?? 1;
    const controller = new AbortController();
    const context: TaskContext = Object.freeze({
      projectRef: binding.projectRef,
      queueName: binding.queueName,
      taskKey: binding.taskKey,
      idempotencyKey: `${binding.queueName}:${message.messageId}`,
      ...(message.jobKey === undefined ? {} : { jobKey: message.jobKey }),
      priority: 0,
      messageId: message.messageId,
      attempt,
      signal: controller.signal,
    });
    try {
      const input = handler.decode(message.payload);
      if (await handler.authorize(input, context) !== true) {
        results.push({ messageId: message.messageId, status: "failed", attempt, code: "WORKER_TASK_FORBIDDEN" });
        continue;
      }
      await handler.execute(input, context);
      results.push({ messageId: message.messageId, status: "succeeded", attempt });
    } catch (error) {
      results.push({
        messageId: message.messageId,
        status: "failed",
        attempt,
        code: error instanceof Error && error.message.startsWith("WORKER_")
          ? error.message : "WORKER_TASK_FAILED",
      });
    }
  }
  return results;
}
