import type { EdgeWorker } from "@pgflow/edge-worker";
import type { AnyFlow, CompatibleFlow } from "@pgflow/dsl";
import type { SupabaseResources } from "@pgflow/dsl/supabase";
import { createLifecycle } from "./lifecycle.js";
import {
  createQueueHandler,
  type QueueBinding,
  type TaskHandler,
} from "./queue-handler.js";
export {
  WorkerTaskError,
  type TaskContext,
  type TaskHandler,
} from "./queue-handler.js";

export interface ProcessWorkerOptions {
  readonly projectRef: string;
  /** Explicit project database, never a platform administrator connection. */
  connectionString: string;
  concurrency?: number;
  maxPgConnections?: number;
}
export interface QueueWorkerOptions extends ProcessWorkerOptions, QueueBinding {
  visibilityTimeoutSeconds?: number;
  retryLimit?: number;
}
let processClaimed = false;
function integer(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error("WORKER_CONFIG_INVALID");
  return result;
}
function config(options: ProcessWorkerOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(options.projectRef))
    throw new Error("WORKER_PROJECT_INVALID");
  let url: URL;
  try {
    url = new URL(options.connectionString);
  } catch {
    throw new Error("WORKER_CONNECTION_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2
  )
    throw new Error("WORKER_CONNECTION_INVALID");
  const maxConcurrent = integer(options.concurrency, 4, 1, 32);
  return Object.freeze({
    connectionString: options.connectionString,
    maxConcurrent,
    batchSize: maxConcurrent,
    maxPgConnections: integer(options.maxPgConnections, 4, 1, 16),
    maxPollSeconds: 2,
    pollIntervalMs: 200,
  });
}
function preflight(projectRef: string): void {
  if (
    typeof process === "undefined" ||
    "Deno" in globalThis ||
    "EdgeRuntime" in globalThis
  ) {
    throw new Error("WORKER_REQUIRES_DEDICATED_PROCESS");
  }
  if (
    process.env.SUPACLOUD_PROJECT_REF !== projectRef ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error("WORKER_PROJECT_ENV_REQUIRED");
  }
  if (processClaimed) throw new Error("WORKER_PROCESS_ALREADY_CLAIMED");
  processClaimed = true;
}

/**
 * One process per project/queue. No import-time connection or browser SDK dependency.
 * pgflow owns polling, retries and archive operations; this package owns the business boundary.
 */
export function createPgflowQueueWorker<T>(
  options: QueueWorkerOptions,
  handler: TaskHandler<T>,
) {
  if (
    !/^scw_[a-z0-9_]{1,40}$/.test(options.queueName) ||
    !/^[a-z][a-z0-9_.-]{0,99}$/.test(options.taskKey)
  )
    throw new Error("WORKER_QUEUE_INVALID");
  if (
    ![handler.decode, handler.authorize, handler.execute].every(
      (value) => typeof value === "function",
    )
  ) {
    throw new Error("WORKER_HANDLER_INVALID");
  }
  const projectRef = options.projectRef;
  const queueConfig: NonNullable<
    Parameters<typeof EdgeWorker.startQueueWorker>[1]
  > = {
    ...config(options),
    queueName: options.queueName,
    visibilityTimeout: integer(options.visibilityTimeoutSeconds, 300, 15, 3600),
    retry: {
      strategy: "exponential",
      limit: integer(options.retryLimit, 5, 0, 10),
      baseDelay: 5,
      maxDelay: 300,
    },
  };
  const execute = createQueueHandler(options, handler);
  return createLifecycle(async () => {
    preflight(projectRef);
    const { EdgeWorker } = await import("@pgflow/edge-worker");
    return EdgeWorker.startQueueWorker(execute, queueConfig);
  });
}

/**
 * Native pgflow DSL, not a translated SupaCloud linear workflow.
 * Flow handlers remain trusted server code and must implement validation/authorization/redaction.
 */
export function createPgflowWorker<TFlow extends AnyFlow>(
  flow: CompatibleFlow<TFlow, SupabaseResources>,
  options: ProcessWorkerOptions,
) {
  const flowConfig = config(options);
  const projectRef = options.projectRef;
  if (!/^scw_[a-z0-9_]{1,40}$/.test(flow.slug))
    throw new Error("WORKER_FLOW_INVALID");
  return createLifecycle(async () => {
    preflight(projectRef);
    const { EdgeWorker } = await import("@pgflow/edge-worker");
    return EdgeWorker.startFlowWorker(flow, flowConfig);
  });
}
