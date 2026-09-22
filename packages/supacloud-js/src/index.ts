import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { SupaCloudWorkflowsClient } from "./workflows.js";
import { SupaCloudCommandsClient } from "./commands.js";
import { SupaCloudArtifactsClient } from "./artifacts.js";
import { SupaCloudApiError } from "./api-error.js";
import { createBoundedRpcFetch, type FetchTransport } from "./bounded-rpc-fetch.js";
import { SupaCloudOAuthClientsClient } from "./oauth-clients.js";
import { SupaCloudOAuthServerClient } from "./oauth-server.js";
import {
  SupaCloudQueueError, queueJsonSnapshot, queueMessage,
  queueMessageId, queueReadCount, queueRpcBoolean, queueRpcId, queueRpcIds, queueRpcMessages, queueSeconds,
  type SupaCloudQueueJson, type SupaCloudQueueMessage, type SupaCloudQueueSendResult,
  type SupaCloudQueueMutationResult,
} from "./queue-rpc.js";
export { SupaCloudApiError } from "./api-error.js";
export {
  SupaCloudQueueError, type SupaCloudQueueJson, type SupaCloudQueueMessage,
  type SupaCloudQueueSendResult, type SupaCloudQueueMutationResult,
} from "./queue-rpc.js";
export * from "./oauth-clients.js";
export * from "./oauth-server.js";

export {
  createSupaCloudOAuthFetch,
  type SupaCloudOAuthFetchOptions,
} from "./auth-fetch.js";
export * from "./workflows.js";
export { createSupaCloudWorkflowFetch, type SupaCloudWorkflowFetchOptions } from "./workflow-fetch.js";
export { createSupaCloudCommandFetch, type SupaCloudCommandFetchOptions } from "./command-fetch.js";
export { createSupaCloudArtifactFetch, type SupaCloudArtifactFetchOptions } from "./artifact-fetch.js";
export * from "./commands.js";
export * from "./artifacts.js";

export type SupaCloudTaskStatus =
  | "pending"
  | "leased"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "dead_lettered"
  | "cancelled"
  | "queued"
  | "processing"
  | "completed";

export type SupaCloudTaskLogEntry = {
  timestamp: string;
  stream: "stdout" | "stderr";
  level: string;
  message: string;
};

export type SupaCloudTaskAttempt = {
  attempt_no: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  response_status: number | null;
  error: string | null;
  logs: SupaCloudTaskLogEntry[];
};

export type SupaCloudTaskResultDecoder<TResult> = (value: unknown) => TResult;

/** Alias kept short for consumers that already use decoder terminology. */
export type SupaCloudTaskDecoder<TResult> = SupaCloudTaskResultDecoder<TResult>;

export type SupaCloudTaskDetail<TResult = unknown> = {
  id: string;
  project_ref: string;
  status: SupaCloudTaskStatus | string;
  task_type?: string;
  executor?: {
    kind: string;
    version: string;
    definition: string;
    run_id: string;
    native_status: string;
  };
  capabilities?: { cancel: boolean; retry: boolean };
  blocked_reason?: string | null;
  total_steps?: number;
  finished_steps?: number;
  function_slug?: string | null;
  function_version?: string | null;
  attempt?: number | null;
  max_attempts?: number | null;
  progress?: number | null;
  error?: string | null;
  error_message?: string | null;
  result?: TResult;
  payload?: Record<string, unknown>;
  attempts?: SupaCloudTaskAttempt[];
  latest_logs?: SupaCloudTaskLogEntry[];
  correlation_id?: string | null;
  business_task_id?: string | null;
  metadata?: Record<string, unknown> | null;
  updated_at?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
};

export type SupaCloudTaskSnapshot<TResult = unknown> = {
  id: string;
  status: SupaCloudTaskStatus | string;
  progress?: number | null;
  error?: string | null;
  updatedAt?: string | null;
  raw: SupaCloudTaskDetail<TResult>;
};

export type SupaCloudTaskListFilters = {
  status?: string | string[];
  taskType?: string | string[];
  functionSlug?: string;
  dlq?: boolean;
  limit?: number;
};

export type SupaCloudTaskSubmitOptions = {
  body?:
    | string
    | Blob
    | ArrayBuffer
    | FormData
    | File
    | ReadableStream<Uint8Array>
    | Record<string, unknown>;
  headers?: Record<string, string>;
  /** @deprecated Configure retry policy on the platform; this compatibility field is ignored. */
  retries?: number;
  /** @deprecated Configure execution timeout on the platform; this compatibility field is ignored. */
  timeoutSec?: number;
  idempotencyKey?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Opaque correlation ID — the platform stores it but does not interpret it */
  correlationId?: string;
  /** Business-layer task ID for mapping back to the caller's own task table */
  businessTaskId?: string;
  /** Arbitrary JSON metadata — the platform stores it but does not interpret it */
  metadata?: Record<string, unknown>;
};

export type SupaCloudQueueSendOptions = {
  /** Official Supabase Queues visibility delay, in seconds. */
  sleepSeconds?: number;
  /** Official Supabase Queues visibility delay, in seconds. */
  sleep_seconds?: number;
  /** Convenience alias converted to sleep_seconds for compatibility with older SupaCloud callers. */
  delayMs?: number;
  /** @deprecated PGMQ does not store per-message retry budgets. Keep retry policy at the consumer layer. */
  maxAttempts?: number;
  /** @deprecated PGMQ does not provide enqueue idempotency keys. Deduplicate in your payload or application table. */
  idempotencyKey?: string;
  /** @deprecated PGMQ messages are plain JSON payloads. Put trace data inside message if needed. */
  traceId?: string;
  /** @deprecated PGMQ messages are plain JSON payloads. Put correlation data inside message if needed. */
  correlationId?: string;
  /** @deprecated PGMQ messages are plain JSON payloads. Put business IDs inside message if needed. */
  businessTaskId?: string;
  /** @deprecated PGMQ messages are plain JSON payloads. Put metadata inside message if needed. */
  metadata?: Record<string, unknown>;
};

export type SupaCloudQueueReceiveOptions = {
  /** Official Supabase Queues visibility timeout, in seconds. */
  sleepSeconds?: number;
  /** Official Supabase Queues visibility timeout, in seconds. */
  sleep_seconds?: number;
  /** Number of messages to read when using read(). receive() always reads one. */
  n?: number;
  /** Alias for n. */
  count?: number;
  /** Convenience alias converted to sleep_seconds for older SupaCloud callers. */
  visibilityTimeoutSec?: number;
};

export type SupaCloudQueueReleaseOptions = {
  sleepSeconds?: number;
  sleep_seconds?: number;
  delayMs?: number;
  error?: string;
};

export type SupaCloudQueueFailOptions = {
  error?: string;
  deadLetter?: boolean;
};

export type SupaCloudQueueListFilters = {
  status?: string | string[];
  archived?: boolean;
  dlq?: boolean;
  limit?: number;
};

export type SupaCloudQueueStats = {
  queue_name: string;
  queue_length: number;
  newest_msg_age_sec: number | null;
  oldest_msg_age_sec: number | null;
  total_messages: number;
  scrape_time: string;
  [key: string]: unknown;
};

export type SupaCloudQueueInfo = {
  queue_name: string;
  created_at?: string | null;
  is_partitioned?: boolean;
  is_unlogged?: boolean;
  type?: string;
};

export type SupaCloudQueueCreateOptions = {
  unlogged?: boolean;
};

export type SupaCloudQueueSettings = {
  max_in_flight: number;
  default_visibility_timeout_sec: number;
  max_attempts: number;
  rate_limit_per_minute: number;
};

export type SupaCloudQueueSettingsUpdate = Partial<SupaCloudQueueSettings>;

export type SupaCloudTaskWaitOptions = {
  intervalMs?: number;
  signal?: AbortSignal;
};

export type SupaCloudTaskSubscribeState =
  | "connecting"
  | "realtime"
  | "polling"
  | "closed";

export type SupaCloudTaskSubscription = {
  readonly connectionState: SupaCloudTaskSubscribeState;
  unsubscribe: () => void;
};

export type SupaCloudTaskSubscribeOptions<TResult = unknown> = {
  realtime?: { schema: string; table: string };
  pollingIntervalMs?: number;
  realtimeTimeoutMs?: number;
  reconcileIntervalMs?: number;
  onUpdate: (task: SupaCloudTaskSnapshot<TResult>) => void;
  onStateChange?: (
    state: SupaCloudTaskSubscribeState,
    details?: { error?: unknown },
  ) => void;
  onError?: (error: unknown) => void;
  stopOnTerminal?: boolean;
};

export type SupaCloudTaskReceipt<TResult = unknown> = {
  taskId: string;
  status: string;
  get: () => Promise<SupaCloudTaskDetail<TResult>>;
  wait: (options?: SupaCloudTaskWaitOptions) => Promise<SupaCloudTaskDetail<TResult>>;
  cancel: () => Promise<SupaCloudTaskDetail<TResult>>;
  retry: () => Promise<SupaCloudTaskDetail<TResult>>;
  subscribe: (
    options: SupaCloudTaskSubscribeOptions<TResult>,
  ) => SupaCloudTaskSubscription;
};

export type SupaCloudClientOptions<TClient extends SupabaseClient = SupabaseClient> = {
  supabase: TClient;
  managementApiUrl: string;
  projectRef: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  pollingIntervalMs?: number;
};

export class SupaCloudTaskSubmitError extends Error {
  readonly code = "TASK_SUBMIT_UNCONFIRMED";
  readonly mutationMayHaveApplied = true;
  readonly responseBody: unknown;

  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "SupaCloudTaskSubmitError";
    this.responseBody = responseBody;
  }
}

export interface SupaCloudTaskFetchOptions {
  functionUrls: readonly string[];
  fetch?: FetchTransport;
}

const boundedTaskHttpFailures = new WeakSet<Response>();

function matchesForeignTaskHttpError(error: unknown, response: Response): boolean {
  try {
    return error instanceof Error
      && Object.getOwnPropertyDescriptor(error, "name")?.value === "FunctionsHttpError"
      && Object.getOwnPropertyDescriptor(error, "context")?.value === response;
  } catch {
    return false;
  }
}

export function createSupaCloudTaskFetch(options: SupaCloudTaskFetchOptions): FetchTransport {
  const captured = queueJsonSnapshot(options.functionUrls);
  if (!Array.isArray(captured) || captured.length === 0) throw new Error("Invalid task function URLs");
  const urls = new Set(captured.map(value => {
    if (typeof value !== "string" || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Invalid task function URLs");
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Invalid task function URLs"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid task function URLs");
    }
    return url.origin + url.pathname;
  }));
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const bounded = createBoundedRpcFetch(/./, () => new SupaCloudTaskSubmitError(
    "Background task submission could not be confirmed", undefined,
  ), fetchImpl);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!urls.has(url.origin + url.pathname)) return fetchImpl(input, init);
    const response = await bounded(input, init);
    if (response.status >= 400 && response.status < 500
      && response.headers.get("x-relay-error") !== "true") {
      boundedTaskHttpFailures.add(response);
    }
    return response;
  };
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ResponseDecoder<T> = (value: unknown) => T;

const TERMINAL_STATUSES = new Set<string>([
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
  "completed",
]);

function waitForPollingInterval(
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled: boolean = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => {
      reject(signal ? signal.reason : new DOMException("Aborted", "AbortError"));
    });
    const timer = setTimeout(() => finish(resolve), intervalMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function toArray(value?: string | string[]): string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}

function createQueryString(filters: SupaCloudTaskListFilters = {}): string {
  let captured: Record<string, unknown>;
  try {
    captured = responseRecord(queueJsonSnapshot(filters), "task filters");
  } catch {
    throw new Error("Invalid task list filters");
  }
  if (Object.keys(captured).some(key => !["status", "taskType", "functionSlug", "dlq", "limit"].includes(key))) {
    throw new Error("Invalid task list filters");
  }
  const text = (value: unknown, commaAllowed = false): string => {
    if (typeof value !== "string" || !value || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value) || (!commaAllowed && value.includes(","))) {
      throw new Error("Invalid task list filters");
    }
    try { encodeURIComponent(value); } catch { throw new Error("Invalid task list filters"); }
    return value;
  };
  const values = (value: unknown): string[] => {
    const items: unknown[] = Array.isArray(value) ? value : [value];
    if (items.length === 0) throw new Error("Invalid task list filters");
    return items.map(item => text(item));
  };
  const params = new URLSearchParams();
  if (Object.hasOwn(captured, "status")) params.set("status", values(captured.status).join(","));
  if (Object.hasOwn(captured, "taskType")) params.set("task_type", values(captured.taskType).join(","));
  if (Object.hasOwn(captured, "functionSlug")) params.set("function_slug", text(captured.functionSlug, true));
  if (Object.hasOwn(captured, "dlq")) {
    if (typeof captured.dlq !== "boolean") throw new Error("Invalid task list filters");
    if (captured.dlq) params.set("dlq", "true");
  }
  if (Object.hasOwn(captured, "limit")) {
    if (typeof captured.limit !== "number" || !Number.isSafeInteger(captured.limit) || captured.limit < 1) {
      throw new Error("Invalid task list filters");
    }
    params.set("limit", String(captured.limit));
  }

  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function createQueueQueryString(filters: SupaCloudQueueListFilters = {}): string {
  const params = new URLSearchParams();
  const statuses = toArray(filters.status);

  if (statuses?.length) params.set("status", statuses.join(","));
  if (filters.archived) params.set("archived", "true");
  if (filters.dlq) params.set("dlq", "true");
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));

  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function normalizeSecondsFromOptions(
  options: { sleepSeconds?: number; sleep_seconds?: number; delayMs?: number; visibilityTimeoutSec?: number } = {},
): number {
  return queueSeconds(options);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function valueRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) record[key] = item;
  return record;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response`);
  }
  return valueRecord(value);
}

function responseString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label} response: ${key} is required`);
  }
  return value;
}

function responseNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label} response: ${key} is required`);
  }
  return value;
}

function decodeVoid(value: unknown): void {
  if (value !== undefined) throw new Error("Expected an empty response");
}

function taskText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid task response: expected text");
  return value;
}

function taskNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid task response: expected number");
  return value;
}

function taskNullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null ? null : decode(value);
}

function taskArray<T>(value: unknown, decode: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid task response: expected array");
  return value.map(decode);
}

function decodeTaskLog(value: unknown): SupaCloudTaskLogEntry {
  const data = responseRecord(value, "task log");
  if (data.stream !== "stdout" && data.stream !== "stderr") throw new Error("Invalid task log response: stream");
  return {
    timestamp: taskText(data.timestamp), stream: data.stream,
    level: taskText(data.level), message: taskText(data.message),
  };
}

function decodeTaskAttempt(value: unknown): SupaCloudTaskAttempt {
  const data = responseRecord(value, "task attempt");
  return {
    attempt_no: taskNumber(data.attempt_no), status: taskText(data.status),
    started_at: taskNullable(data.started_at, taskText), completed_at: taskNullable(data.completed_at, taskText),
    duration_ms: taskNullable(data.duration_ms, taskNumber),
    response_status: taskNullable(data.response_status, taskNumber),
    error: taskNullable(data.error, taskText), logs: taskArray(data.logs, decodeTaskLog),
  };
}

function decodeTaskDetail(value: unknown): SupaCloudTaskDetail {
  const record = responseRecord(value, "task");
  let executor: SupaCloudTaskDetail["executor"];
  let capabilities: SupaCloudTaskDetail["capabilities"];
  if (Object.hasOwn(record, "executor")) {
    const source = responseRecord(record.executor, "task executor");
    executor = {
      kind: taskText(source.kind), version: taskText(source.version),
      definition: taskText(source.definition), run_id: taskText(source.run_id),
      native_status: taskText(source.native_status),
    };
  }
  if (Object.hasOwn(record, "capabilities")) {
    const source = responseRecord(record.capabilities, "task capabilities");
    if (typeof source.cancel !== "boolean" || typeof source.retry !== "boolean") {
      throw new Error("Invalid task capabilities");
    }
    capabilities = { cancel: source.cancel, retry: source.retry };
  }
  for (const key of [
    "function_slug", "function_version", "error", "error_message", "correlation_id",
    "business_task_id", "updated_at", "created_at", "blocked_reason",
  ]) {
    if (Object.hasOwn(record, key)) taskNullable(record[key], taskText);
  }
  for (const key of ["attempt", "max_attempts", "progress"]) {
    if (Object.hasOwn(record, key)) taskNullable(record[key], taskNumber);
  }
  if (Object.hasOwn(record, "task_type")) taskText(record.task_type);
  for (const key of ["total_steps", "finished_steps"]) {
    if (Object.hasOwn(record, key)) {
      const count = taskNumber(record[key]);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid task step count");
    }
  }
  if (Object.hasOwn(record, "payload")) responseRecord(record.payload, "task payload");
  if (Object.hasOwn(record, "metadata") && record.metadata !== null) responseRecord(record.metadata, "task metadata");
  return {
    ...record,
    id: responseString(record, "id", "task"),
    project_ref: responseString(record, "project_ref", "task"),
    status: responseString(record, "status", "task"),
    ...(executor === undefined ? {} : { executor }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(Object.hasOwn(record, "attempts") ? { attempts: taskArray(record.attempts, decodeTaskAttempt) } : {}),
    ...(Object.hasOwn(record, "latest_logs") ? { latest_logs: taskArray(record.latest_logs, decodeTaskLog) } : {}),
  };
}

function decodeTaskDetails(value: unknown): SupaCloudTaskDetail[] {
  if (!Array.isArray(value)) throw new Error("Invalid task list response");
  return value.map(decodeTaskDetail);
}

export class SupaCloudTaskResponseError extends SupaCloudApiError {
  readonly mutationMayHaveApplied: boolean;

  constructor(operation: "get" | "cancel" | "retry") {
    const mutation = operation !== "get";
    super("Invalid task response: could not validate the requested task", 0, {
      code: operation === "get" ? "TASK_READ_INVALID" : `TASK_${operation.toUpperCase()}_UNCONFIRMED`,
      mutation_may_have_applied: mutation,
    });
    this.name = "SupaCloudTaskResponseError";
    this.mutationMayHaveApplied = mutation;
  }
}

export type SupaCloudTaskDecodeOperation = "get" | "list" | "wait" | "cancel" | "retry" | "subscribe";

/**
 * A caller-supplied result decoder failed. The original decoder error and
 * response value are intentionally not retained because either may contain
 * secrets or unbounded application data.
 */
export class SupaCloudTaskDecoderError extends SupaCloudApiError {
  override readonly code = "TASK_RESULT_INVALID" as const;
  readonly mutationMayHaveApplied: boolean;

  constructor(readonly operation: SupaCloudTaskDecodeOperation) {
    const mutation = operation === "cancel" || operation === "retry";
    super("Task result could not be decoded", 0, {
      code: "TASK_RESULT_INVALID",
      mutation_may_have_applied: mutation,
    });
    this.name = "SupaCloudTaskDecoderError";
    this.mutationMayHaveApplied = mutation;
  }
}

/** Compatibility spelling for callers that refer to decoding rather than decoding contracts. */
export { SupaCloudTaskDecoderError as SupaCloudTaskDecodeError };

export class SupaCloudTaskAuthenticationError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;

  constructor(code: "TASK_AUTH_INVALID" | "TASK_AUTH_TIMEOUT" = "TASK_AUTH_INVALID") {
    super("Task authentication could not be validated", 0, {
      code, mutation_may_have_applied: false,
    });
    this.name = "SupaCloudTaskAuthenticationError";
  }
}

function captureTaskId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value === "." || value === ".." || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid task ID");
  }
  try { encodeURIComponent(value); } catch { throw new Error("Invalid task ID"); }
  const candidate = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(candidate)) return value;
  const hex = candidate.replaceAll("-", "").toLowerCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function captureTaskDecoder<TResult>(value: unknown): SupaCloudTaskResultDecoder<TResult> {
  if (typeof value !== "function") throw new TypeError("Invalid task result decoder");
  return value as SupaCloudTaskResultDecoder<TResult>;
}

function decodeTaskResult<TResult>(
  task: SupaCloudTaskDetail,
  decoder: SupaCloudTaskResultDecoder<TResult>,
  operation: SupaCloudTaskDecodeOperation,
): SupaCloudTaskDetail<TResult> {
  if (!Object.hasOwn(task, "result")) return task as SupaCloudTaskDetail<TResult>;
  try {
    const input = task.result === undefined ? undefined : queueJsonSnapshot(task.result);
    return { ...task, result: decoder(input) };
  } catch {
    throw new SupaCloudTaskDecoderError(operation);
  }
}

function decodeTaskDetailsWithResult<TResult>(
  value: unknown,
  decoder: SupaCloudTaskResultDecoder<TResult>,
): SupaCloudTaskDetail<TResult>[] {
  return decodeTaskDetails(value).map((task) => decodeTaskResult(task, decoder, "list"));
}

function decodeBoundTask(
  value: unknown, taskId: string, operation: "get" | "cancel" | "retry",
): SupaCloudTaskDetail {
  try {
    const task = decodeTaskDetail(value);
    if (task.id !== taskId) throw new Error("Mismatched task ID");
    return task;
  } catch {
    throw new SupaCloudTaskResponseError(operation);
  }
}

function decodeQueueMessages(value: unknown, queueName: string): SupaCloudQueueMessage[] {
  if (!Array.isArray(value) || value.length > 10000) throw new SupaCloudQueueError();
  const messages = value.map((row: unknown) => queueMessage(row, { queueName }));
  if (new Set(messages.map(row => row.id)).size !== messages.length) throw new SupaCloudQueueError();
  return messages;
}

function decodeQueueStats(value: unknown): SupaCloudQueueStats {
  const record = responseRecord(value, "queue stats");
  return {
    ...record,
    queue_name: responseString(record, "queue_name", "queue stats"),
    queue_length: responseNumber(record, "queue_length", "queue stats"),
    newest_msg_age_sec: record.newest_msg_age_sec === null
      ? null
      : responseNumber(record, "newest_msg_age_sec", "queue stats"),
    oldest_msg_age_sec: record.oldest_msg_age_sec === null
      ? null
      : responseNumber(record, "oldest_msg_age_sec", "queue stats"),
    total_messages: responseNumber(record, "total_messages", "queue stats"),
    scrape_time: responseString(record, "scrape_time", "queue stats"),
  };
}

function decodeQueueSettings(value: unknown): SupaCloudQueueSettings {
  const record = responseRecord(value, "queue settings");
  return {
    max_in_flight: responseNumber(record, "max_in_flight", "queue settings"),
    default_visibility_timeout_sec: responseNumber(
      record,
      "default_visibility_timeout_sec",
      "queue settings",
    ),
    max_attempts: responseNumber(record, "max_attempts", "queue settings"),
    rate_limit_per_minute: responseNumber(record, "rate_limit_per_minute", "queue settings"),
  };
}

function decodeQueueInfo(value: unknown): SupaCloudQueueInfo {
  const record = responseRecord(value, "queue info");
  return {
    ...record,
    queue_name: responseString(record, "queue_name", "queue info"),
  };
}

function decodeQueueInfos(value: unknown): SupaCloudQueueInfo[] {
  if (!Array.isArray(value)) throw new Error("Invalid queue info list response");
  return value.map(decodeQueueInfo);
}

function decodePurgeResult(value: unknown): { queue_name: string; purged: number } {
  const record = responseRecord(value, "queue purge");
  return {
    queue_name: responseString(record, "queue_name", "queue purge"),
    purged: responseNumber(record, "purged", "queue purge"),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

async function defaultAccessTokenResolver(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

function validateTaskProject(record: Record<string, unknown>, projectRef: string): void {
  if (!Object.hasOwn(record, "project_ref") || record.project_ref !== projectRef) {
    throw new Error("Invalid task response project");
  }
}

const MAX_TASK_TIMER_MS = 2147483647;

function taskTimerMs(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isInteger(value)
    || value < (allowZero ? 0 : 1) || value > MAX_TASK_TIMER_MS) {
    throw new Error("Invalid task timer interval");
  }
  return value;
}

function captureTaskWaitOptions(options: unknown): SupaCloudTaskWaitOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid task wait options");
  }
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid task wait options");
  let intervalMs: number | undefined;
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    const property = Object.getOwnPropertyDescriptor(options, key);
    if ((key !== "intervalMs" && key !== "signal") || !property || !("value" in property)) {
      throw new Error("Invalid task wait options");
    }
    const value: unknown = property.value;
    if (value === undefined) continue;
    if (key === "intervalMs") intervalMs = taskTimerMs(value);
    else {
      if (!(value instanceof AbortSignal)) throw new Error("Invalid task wait options");
      signal = value;
    }
  }
  return {
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function captureTaskRealtimeSource(value: unknown): { schema: string; table: string } | null {
  if (value === undefined) return null;
  try {
    const source = responseRecord(queueJsonSnapshot(value), "task Realtime source");
    if (Object.keys(source).some(key => key !== "schema" && key !== "table")) throw new Error();
    const schema = responseString(source, "schema", "task Realtime source");
    const table = responseString(source, "table", "task Realtime source");
    if (![schema, table].every(name => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name))) throw new Error();
    return { schema, table };
  } catch {
    throw new Error("Invalid task Realtime source");
  }
}

function captureTaskSubscribeOptions<TResult>(
  options: SupaCloudTaskSubscribeOptions<TResult>,
): SupaCloudTaskSubscribeOptions<TResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
    throw new Error("Invalid task subscription options");
  }
  const allowed = new Set([
    "realtime", "pollingIntervalMs", "realtimeTimeoutMs", "reconcileIntervalMs",
    "onUpdate", "onStateChange", "onError", "stopOnTerminal",
  ]);
  for (const key of Reflect.ownKeys(options)) {
    const property = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== "string" || !allowed.has(key) || !property || !("value" in property)) {
      throw new Error("Invalid task subscription options");
    }
  }
  const captured = { ...options };
  if (typeof captured.onUpdate !== "function"
    || (captured.onStateChange !== undefined && typeof captured.onStateChange !== "function")
    || (captured.onError !== undefined && typeof captured.onError !== "function")
    || (captured.stopOnTerminal !== undefined && typeof captured.stopOnTerminal !== "boolean")) {
    throw new Error("Invalid task subscription options");
  }
  const realtime = captureTaskRealtimeSource(captured.realtime);
  if (realtime) captured.realtime = realtime;
  return captured;
}

function normalizeTaskSnapshot<TResult = unknown>(
  task: unknown,
  taskId: string,
  projectRef: string,
  decoder?: SupaCloudTaskResultDecoder<TResult>,
): SupaCloudTaskSnapshot<TResult> {
  let value: SupaCloudTaskDetail;
  try {
    value = decodeBoundTask(queueJsonSnapshot(task), taskId, "get");
    validateTaskProject(value, projectRef);
    if (Object.hasOwn(value, "updatedAt")) taskNullable(value.updatedAt, taskText);
  } catch {
    throw new SupaCloudTaskResponseError("get");
  }
  const decoded = decoder === undefined ? value as SupaCloudTaskDetail<TResult>
    : decodeTaskResult(value, decoder, "subscribe");
  return {
    id: decoded.id,
    status: decoded.status,
    progress: typeof decoded.progress === "number" ? decoded.progress : null,
    error:
      typeof decoded.error === "string"
        ? decoded.error
        : typeof decoded.error_message === "string"
          ? decoded.error_message
          : null,
    updatedAt:
      typeof decoded.updated_at === "string"
        ? decoded.updated_at
        : typeof decoded.updatedAt === "string"
          ? decoded.updatedAt
          : null,
    raw: decoded,
  };
}

class SupaCloudManagementClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(protected readonly options: Required<SupaCloudClientOptions<TClient>>) {}

  protected async resolveAccessToken(_signal?: AbortSignal): Promise<string> {
    const token = await this.options.getAccessToken();
    if (!token) {
      throw new Error(
        "No SupaCloud management API access token available. Pass getAccessToken() or ensure supabase.auth has an active session.",
      );
    }
    return token;
  }

  protected async request<T>(
    path: string,
    method: HttpMethod,
    body: unknown,
    decode: ResponseDecoder<T>,
    transport: FetchTransport = globalThis.fetch.bind(globalThis),
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const accessToken = await this.resolveAccessToken(signal);
    signal?.throwIfAborted();
    const response = await transport(`${this.options.managementApiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });

    if (response.status === 204) return decode(undefined);

    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      const responseRecord = valueRecord(responseBody);
      const message =
        typeof responseRecord.message === "string"
          ? responseRecord.message
          : `SupaCloud request failed (${response.status})`;
      throw new SupaCloudApiError(message, response.status, responseBody);
    }

    return decode(responseBody);
  }
}

class SupaCloudTasksClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  protected override async resolveAccessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const timeoutError = new SupaCloudTaskAuthenticationError("TASK_AUTH_TIMEOUT");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), 15000);
    });
    try {
      const token = await Promise.race([super.resolveAccessToken(), deadline, aborted]);
      signal?.throwIfAborted();
      if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
        throw new SupaCloudTaskAuthenticationError();
      }
      return token;
    } catch (error) {
      signal?.throwIfAborted();
      if (error === timeoutError) throw timeoutError;
      throw new SupaCloudTaskAuthenticationError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  protected override request<T>(
    path: string, method: HttpMethod, body: unknown, decode: ResponseDecoder<T>,
    _transport?: FetchTransport, signal?: AbortSignal,
  ): Promise<T> {
    const operation = method === "POST" ? (path.endsWith("/cancel") ? "cancel" : "retry") : "get";
    const projectRef = this.options.projectRef;
    const failure = () => new SupaCloudTaskResponseError(operation);
    const bounded = createBoundedRpcFetch(/./, failure);
    const transport: FetchTransport = async (input, init) => {
      const response = await bounded(input, init);
      if (response.status >= 500 || (response.ok && response.status !== 200)) throw failure();
      return response;
    };
    return super.request(path, method, body, value => {
      try {
        const rows: unknown[] = Array.isArray(value) ? value : [value];
        for (const task of rows) {
          const record = responseRecord(task, "task");
          validateTaskProject(record, projectRef);
        }
        return decode(value);
      }
      catch (error) {
        if (error instanceof SupaCloudTaskDecoderError) throw error;
        throw failure();
      }
    }, transport, signal).then(value => {
      signal?.throwIfAborted();
      return value;
    }, error => {
      signal?.throwIfAborted();
      throw error;
    });
  }

  private createReceipt(taskId: string, status: string): SupaCloudTaskReceipt<unknown> {
    return {
      taskId,
      status,
      get: () => this.get(taskId),
      wait: (options?: SupaCloudTaskWaitOptions) => this.wait(taskId, options),
      cancel: () => this.cancel(taskId),
      retry: () => this.retry(taskId),
      subscribe: (options: SupaCloudTaskSubscribeOptions) =>
        this.subscribe(taskId, options),
    };
  }

  private createTypedReceipt<TResult>(
    taskId: string,
    status: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): SupaCloudTaskReceipt<TResult> {
    return {
      taskId,
      status,
      get: () => this.getTyped(taskId, decoder),
      wait: (options?: SupaCloudTaskWaitOptions) => this.waitTyped(taskId, decoder, options),
      cancel: () => this.cancelTyped(taskId, decoder),
      retry: () => this.retryTyped(taskId, decoder),
      subscribe: (options: SupaCloudTaskSubscribeOptions<TResult>) =>
        this.subscribeTypedInternal(taskId, options, decoder),
    };
  }

  private async submitInternal<TResult = unknown>(
    functionName: string,
    options: SupaCloudTaskSubmitOptions = {},
    decoder?: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskReceipt<TResult>> {
    const projectRef = this.options.projectRef;
    const { body, headers = {}, idempotencyKey, method } = options;
    // Background execution is selected by server-side background_routes.
    // Keep the async decision server-side, but forward the logical idempotency key
    // so management-api can dedupe background-route submissions.
    const invokeHeaders = {
      ...headers,
      ...(idempotencyKey ? { "x-supacloud-idempotency-key": idempotencyKey } : {}),
      ...(options.correlationId ? { "x-supacloud-correlation-id": options.correlationId } : {}),
      ...(options.businessTaskId ? { "x-supacloud-business-task-id": options.businessTaskId } : {}),
      ...(options.metadata ? { "x-supacloud-task-metadata": JSON.stringify(options.metadata) } : {}),
    };
    const controller = new AbortController();
    const failure = () => new SupaCloudTaskSubmitError(
      "Background task submission could not be confirmed", undefined,
    );
    const timeoutError = new SupaCloudTaskSubmitError(
      "Background task submission timed out; outcome is unconfirmed", undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, 15000);
    });
    let invocation: { data: unknown; error: unknown; response?: unknown };
    try {
      invocation = await Promise.race([
        this.options.supabase.functions.invoke(functionName, {
          ...(body === undefined ? {} : { body }),
          ...(method === undefined ? {} : { method }),
          headers: invokeHeaders,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      if (error === timeoutError) throw timeoutError;
      throw failure();
    } finally {
      clearTimeout(timer);
    }
    const { data, error, response } = invocation;
    const boundedHttpFailure = response instanceof Response && boundedTaskHttpFailures.delete(response);

    if (error !== null && error !== undefined) {
      if (error instanceof FunctionsHttpError && response instanceof Response
        && error.context === response && !response.redirected
        && response.status >= 400 && response.status < 500) {
        throw error;
      }
      // Peer copies have different constructors; require transport provenance, not just a name.
      if (boundedHttpFailure && response instanceof Response && !response.redirected
        && response.status >= 400 && response.status < 500
        && matchesForeignTaskHttpError(error, response)) {
        throw new FunctionsHttpError(response);
      }
      if (response instanceof Response) void response.body?.cancel().catch(() => {});
      throw failure();
    }
    if (!(response instanceof Response) || response.status !== 202 || response.redirected) {
      if (response instanceof Response) void response.body?.cancel().catch(() => {});
      throw failure();
    }

    try {
      const payload = responseRecord(queueJsonSnapshot(data), "task submission");
      validateTaskProject(payload, projectRef);
      const snakeId = Object.hasOwn(payload, "task_id")
        ? captureTaskId(payload.task_id) : undefined;
      const camelId = Object.hasOwn(payload, "taskId")
        ? captureTaskId(payload.taskId) : undefined;
      const taskId = snakeId ?? camelId;
      if (taskId === undefined || (snakeId !== undefined && camelId !== undefined && snakeId !== camelId)) {
        throw new Error("Invalid task receipt identity");
      }
      const status = responseString(payload, "status", "task submission");
      if (status.trim() !== status || /[\u0000-\u001f\u007f]/.test(status)) {
        throw new Error("Invalid task receipt status");
      }
      return decoder === undefined
        ? this.createReceipt(taskId, status) as SupaCloudTaskReceipt<TResult>
        : this.createTypedReceipt(taskId, status, decoder);
    } catch {
      throw new SupaCloudTaskSubmitError(
        "Background task submission could not be confirmed",
        data,
      );
    }
  }

  async submit(
    functionName: string,
    options: SupaCloudTaskSubmitOptions = {},
  ): Promise<SupaCloudTaskReceipt<unknown>> {
    return this.submitInternal(functionName, options);
  }

  async submitTyped<TResult>(
    functionName: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
    options?: SupaCloudTaskSubmitOptions,
  ): Promise<SupaCloudTaskReceipt<TResult>>;
  async submitTyped<TResult>(
    functionName: string,
    options: SupaCloudTaskSubmitOptions,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskReceipt<TResult>>;
  async submitTyped<TResult>(
    functionName: string,
    decoderOrOptions: SupaCloudTaskResultDecoder<TResult> | SupaCloudTaskSubmitOptions,
    optionsOrDecoder?: SupaCloudTaskSubmitOptions | SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskReceipt<TResult>> {
    const decoder = typeof decoderOrOptions === "function"
      ? captureTaskDecoder<TResult>(decoderOrOptions)
      : captureTaskDecoder<TResult>(optionsOrDecoder);
    const options = typeof decoderOrOptions === "function"
      ? optionsOrDecoder ?? {}
      : decoderOrOptions;
    return this.submitInternal(functionName, options as SupaCloudTaskSubmitOptions, decoder);
  }

  private getInternal<TResult = unknown>(
    taskId: string,
    decoder?: SupaCloudTaskResultDecoder<TResult>,
    signal?: AbortSignal,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    const captured = captureTaskId(taskId);
    return this.request<SupaCloudTaskDetail<TResult>>(
      `/v1/projects/${this.options.projectRef}/tasks/${encodeURIComponent(captured)}`,
      "GET",
      undefined,
      value => {
        const task = decodeBoundTask(value, captured, "get");
        return decoder === undefined ? task as SupaCloudTaskDetail<TResult>
          : decodeTaskResult(task, decoder, "get");
      },
      undefined,
      signal,
    );
  }

  async get(taskId: string, signal?: AbortSignal): Promise<SupaCloudTaskDetail<unknown>> {
    return this.getInternal(taskId, undefined, signal);
  }

  async getTyped<TResult>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
    signal?: AbortSignal,
  ): Promise<SupaCloudTaskDetail<TResult>>;
  async getTyped<TResult>(
    taskId: string,
    signal: AbortSignal | undefined,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>>;
  async getTyped<TResult>(
    taskId: string,
    decoderOrSignal: SupaCloudTaskResultDecoder<TResult> | AbortSignal | undefined,
    signalOrDecoder?: AbortSignal | SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    const decoder = typeof decoderOrSignal === "function"
      ? captureTaskDecoder<TResult>(decoderOrSignal)
      : captureTaskDecoder<TResult>(signalOrDecoder);
    const signal = typeof decoderOrSignal === "function"
      ? signalOrDecoder as AbortSignal | undefined
      : decoderOrSignal;
    return this.getInternal(taskId, decoder, signal);
  }

  async list(filters: SupaCloudTaskListFilters = {}): Promise<SupaCloudTaskDetail<unknown>[]> {
    return this.request<SupaCloudTaskDetail<unknown>[]>(
      `/v1/projects/${this.options.projectRef}/tasks${createQueryString(filters)}`,
      "GET",
      undefined,
      decodeTaskDetails,
    );
  }

  async listTyped<TResult>(
    decoder: SupaCloudTaskResultDecoder<TResult>,
    filters?: SupaCloudTaskListFilters,
  ): Promise<SupaCloudTaskDetail<TResult>[]>;
  async listTyped<TResult>(
    filters: SupaCloudTaskListFilters,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>[]>;
  async listTyped<TResult>(
    decoderOrFilters: SupaCloudTaskResultDecoder<TResult> | SupaCloudTaskListFilters,
    filtersOrDecoder?: SupaCloudTaskListFilters | SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>[]> {
    const decoder = typeof decoderOrFilters === "function"
      ? captureTaskDecoder<TResult>(decoderOrFilters)
      : captureTaskDecoder<TResult>(filtersOrDecoder);
    const filters = typeof decoderOrFilters === "function"
      ? filtersOrDecoder as SupaCloudTaskListFilters | undefined
      : decoderOrFilters;
    return this.request<SupaCloudTaskDetail<TResult>[]>(
      `/v1/projects/${this.options.projectRef}/tasks${createQueryString(filters)}`,
      "GET",
      undefined,
      value => decodeTaskDetailsWithResult(value, decoder),
    );
  }

  private cancelInternal<TResult = unknown>(
    taskId: string,
    decoder?: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    const captured = captureTaskId(taskId);
    return this.request<SupaCloudTaskDetail<TResult>>(
      `/v1/projects/${this.options.projectRef}/tasks/${encodeURIComponent(captured)}/cancel`,
      "POST",
      undefined,
      value => {
        const task = decodeBoundTask(value, captured, "cancel");
        return decoder === undefined ? task as SupaCloudTaskDetail<TResult>
          : decodeTaskResult(task, decoder, "cancel");
      },
    );
  }

  async cancel(taskId: string): Promise<SupaCloudTaskDetail<unknown>> {
    return this.cancelInternal(taskId);
  }

  async cancelTyped<TResult>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    return this.cancelInternal(taskId, captureTaskDecoder<TResult>(decoder));
  }

  private retryInternal<TResult = unknown>(
    taskId: string,
    decoder?: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    const captured = captureTaskId(taskId);
    return this.request<SupaCloudTaskDetail<TResult>>(
      `/v1/projects/${this.options.projectRef}/tasks/${encodeURIComponent(captured)}/retry`,
      "POST",
      undefined,
      value => {
        const task = decodeBoundTask(value, captured, "retry");
        return decoder === undefined ? task as SupaCloudTaskDetail<TResult>
          : decodeTaskResult(task, decoder, "retry");
      },
    );
  }

  async retry(taskId: string): Promise<SupaCloudTaskDetail<unknown>> {
    return this.retryInternal(taskId);
  }

  async retryTyped<TResult>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    return this.retryInternal(taskId, captureTaskDecoder<TResult>(decoder));
  }

  async listDlq(limit = 100): Promise<SupaCloudTaskDetail<unknown>[]> {
    return this.list({ dlq: true, limit });
  }

  async listDlqTyped<TResult>(
    decoder: SupaCloudTaskResultDecoder<TResult>,
    limit = 100,
  ): Promise<SupaCloudTaskDetail<TResult>[]> {
    return this.listTyped({ dlq: true, limit }, captureTaskDecoder<TResult>(decoder));
  }

  private async waitInternal<TResult = unknown>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult> | undefined,
    options: SupaCloudTaskWaitOptions = {},
  ): Promise<SupaCloudTaskDetail<TResult>> {
    options = captureTaskWaitOptions(options);
    const { signal } = options;
    const intervalMs = taskTimerMs(
      options.intervalMs === undefined ? this.options.pollingIntervalMs : options.intervalMs,
    );

    while (true) {
      if (signal?.aborted) {
        throw signal.reason;
      }

      const task: SupaCloudTaskDetail<TResult> = decoder === undefined
        ? await this.get(taskId, signal) as SupaCloudTaskDetail<TResult>
        : await this.getTyped(taskId, decoder, signal);
      if (TERMINAL_STATUSES.has(task.status)) return task;

      await waitForPollingInterval(intervalMs, signal);
    }
  }

  async wait(
    taskId: string,
    options: SupaCloudTaskWaitOptions = {},
  ): Promise<SupaCloudTaskDetail<unknown>> {
    return this.waitInternal(taskId, undefined, options);
  }

  async waitTyped<TResult>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
    options?: SupaCloudTaskWaitOptions,
  ): Promise<SupaCloudTaskDetail<TResult>>;
  async waitTyped<TResult>(
    taskId: string,
    options: SupaCloudTaskWaitOptions,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>>;
  async waitTyped<TResult>(
    taskId: string,
    decoderOrOptions: SupaCloudTaskResultDecoder<TResult> | SupaCloudTaskWaitOptions,
    optionsOrDecoder?: SupaCloudTaskWaitOptions | SupaCloudTaskResultDecoder<TResult>,
  ): Promise<SupaCloudTaskDetail<TResult>> {
    const decoder = typeof decoderOrOptions === "function"
      ? captureTaskDecoder<TResult>(decoderOrOptions)
      : captureTaskDecoder<TResult>(optionsOrDecoder);
    const options = typeof decoderOrOptions === "function"
      ? optionsOrDecoder as SupaCloudTaskWaitOptions | undefined
      : decoderOrOptions;
    return this.waitInternal(taskId, decoder, options);
  }

  subscribe(taskId: string, options: SupaCloudTaskSubscribeOptions): SupaCloudTaskSubscription {
    return this.subscribeInternal(taskId, options);
  }

  subscribeTyped<TResult>(
    taskId: string,
    decoder: SupaCloudTaskResultDecoder<TResult>,
    options: SupaCloudTaskSubscribeOptions<TResult>,
  ): SupaCloudTaskSubscription;
  subscribeTyped<TResult>(
    taskId: string,
    options: SupaCloudTaskSubscribeOptions<TResult>,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): SupaCloudTaskSubscription;
  subscribeTyped<TResult>(
    taskId: string,
    decoderOrOptions: SupaCloudTaskResultDecoder<TResult> | SupaCloudTaskSubscribeOptions<TResult>,
    optionsOrDecoder?: SupaCloudTaskSubscribeOptions<TResult> | SupaCloudTaskResultDecoder<TResult>,
  ): SupaCloudTaskSubscription {
    const decoder = typeof decoderOrOptions === "function"
      ? captureTaskDecoder<TResult>(decoderOrOptions)
      : captureTaskDecoder<TResult>(optionsOrDecoder);
    const options = typeof decoderOrOptions === "function"
      ? optionsOrDecoder as SupaCloudTaskSubscribeOptions<TResult>
      : decoderOrOptions;
    return this.subscribeTypedInternal(taskId, options, decoder);
  }

  private subscribeTypedInternal<TResult>(
    taskId: string,
    options: SupaCloudTaskSubscribeOptions<TResult>,
    decoder: SupaCloudTaskResultDecoder<TResult>,
  ): SupaCloudTaskSubscription {
    return this.subscribeInternal(taskId, options, decoder);
  }

  private subscribeInternal<TResult = unknown>(
    taskId: string,
    options: SupaCloudTaskSubscribeOptions<TResult>,
    decoder?: SupaCloudTaskResultDecoder<TResult>,
  ): SupaCloudTaskSubscription {
    taskId = captureTaskId(taskId);
    options = captureTaskSubscribeOptions(options);
    const realtime = captureTaskRealtimeSource(options.realtime);
    const projectRef = this.options.projectRef;
    let closed: boolean = false;
    let channel: RealtimeChannel | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let realtimeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let mode: SupaCloudTaskSubscribeState = "connecting";
    const pollingIntervalMs = taskTimerMs(
      options.pollingIntervalMs === undefined ? this.options.pollingIntervalMs : options.pollingIntervalMs,
    );
    const realtimeTimeoutMs = taskTimerMs(options.realtimeTimeoutMs === undefined ? 10000 : options.realtimeTimeoutMs, true);
    const reconcileIntervalMs = taskTimerMs(options.reconcileIntervalMs === undefined
      ? Math.min(MAX_TASK_TIMER_MS, Math.max(30000, pollingIntervalMs * 10))
      : options.reconcileIntervalMs, true);
    const stopOnTerminal = options.stopOnTerminal ?? true;
    const readController = new AbortController();
    const readTask = async (signal: AbortSignal): Promise<SupaCloudTaskDetail<TResult>> =>
      decoder === undefined
        ? await this.get(taskId, signal) as SupaCloudTaskDetail<TResult>
        : await this.getTyped(taskId, decoder, signal);
    let callbackFailed = false;
    const callCallback = (callback: () => unknown, onFailure: (error: unknown) => void) => {
      try {
        const result: unknown = callback();
        if (result !== undefined) void Promise.resolve(result).catch(onFailure);
      } catch (error) { onFailure(error); }
    };
    const handleCallbackFailure = (error: unknown, report = true) => {
      if (callbackFailed) return;
      callbackFailed = true;
      void close();
      if (report) reportError(error);
    };
    const reportError = (error: unknown) => {
      callCallback(() => options.onError?.(error), cause => handleCallbackFailure(cause, false));
    };

    const setMode = (
      next: SupaCloudTaskSubscribeState,
      details?: { error?: unknown },
    ) => {
      if ((closed && next !== "closed") || mode === next) return;
      mode = next;
      callCallback(() => options.onStateChange?.(next, details), handleCallbackFailure);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const stopRealtimeTimeout = () => {
      if (realtimeTimeoutTimer) {
        clearTimeout(realtimeTimeoutTimer);
        realtimeTimeoutTimer = null;
      }
    };

    const stopReconcile = () => {
      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
    };

    const teardownRealtime = async () => {
      if (channel) {
        const current = channel;
        channel = null;
        try { await this.options.supabase.removeChannel(current); }
        catch (error) { reportError(error); }
      }
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      readController.abort();
      stopPolling();
      stopRealtimeTimeout();
      stopReconcile();
      try { await teardownRealtime(); }
      finally { setMode("closed"); }
    };

    const emitTask = (task: unknown) => {
      if (closed) return;
      let snapshot: SupaCloudTaskSnapshot<TResult>;
      try { snapshot = normalizeTaskSnapshot(task, taskId, projectRef, decoder); }
      catch (error) {
        reportError(error);
        return;
      }
      callCallback(() => options.onUpdate(snapshot), handleCallbackFailure);

      if (stopOnTerminal && TERMINAL_STATUSES.has(snapshot.status)) {
        void close();
      }
    };

    const pollOnce = async () => {
      if (closed) return;

      try {
        const task = await readTask(readController.signal);
        emitTask(task);
      } catch (error) {
        if (!closed) reportError(error);
      } finally {
        if (!closed && mode === "polling") {
          pollTimer = setTimeout(() => {
            void pollOnce();
          }, pollingIntervalMs);
        }
      }
    };

    const reconcileOnce = async () => {
      if (closed || mode !== "realtime") return;

      try {
        emitTask(await readTask(readController.signal));
      } catch (error) {
        if (!closed) reportError(error);
      } finally {
        if (!closed && mode === "realtime") {
          reconcileTimer = setTimeout(() => {
            void reconcileOnce();
          }, reconcileIntervalMs);
        }
      }
    };

    const startReconcile = () => {
      if (closed || reconcileIntervalMs <= 0) return;
      stopReconcile();
      reconcileTimer = setTimeout(() => {
        void reconcileOnce();
      }, reconcileIntervalMs);
    };

    const startPolling = (error?: unknown) => {
      if (closed) return;
      stopPolling();
      stopRealtimeTimeout();
      stopReconcile();
      setMode("polling", { error });
      void pollOnce();
    };

    const subscription = {
      get connectionState() { return mode; },
      unsubscribe() { void close(); },
    };
    if (!realtime) {
      startPolling();
      return subscription;
    }

    channel = this.options.supabase
      .channel(`supacloud-task:${this.options.projectRef}:${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: realtime.schema,
          table: realtime.table,
          filter: `id=eq.${taskId}`,
        },
        (payload) => {
          const next = payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old;
          if (next) emitTask(next);
        },
      );
    channel.subscribe(async (status, error) => {
        if (closed) return;

        if (status === "SUBSCRIBED") {
          stopPolling();
          stopRealtimeTimeout();
          setMode("realtime");
          if (closed) return;
          try {
            emitTask(await readTask(readController.signal));
          } catch (err) {
            if (!closed) reportError(err);
          }
          startReconcile();
          return;
        }

        if (
          status === "TIMED_OUT" ||
          status === "CHANNEL_ERROR" ||
          status === "CLOSED"
        ) {
          await teardownRealtime();
          startPolling(error);
        }
      });

    if (!closed && realtimeTimeoutMs > 0) {
      realtimeTimeoutTimer = setTimeout(() => {
        if (!closed && mode === "connecting") {
          void teardownRealtime().finally(() => {
            startPolling(new Error("SupaCloud Realtime subscription timed out"));
          });
        }
      }, realtimeTimeoutMs);
    }

    setMode("connecting");

    return subscription;
  }
}

class SupaCloudQueueClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  constructor(
    options: Required<SupaCloudClientOptions<TClient>>,
    private readonly name: string,
  ) {
    super(options);
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name)
      || name.startsWith("supacloud_internal_")) throw new SupaCloudQueueError();
  }

  private get encodedName(): string {
    return encodeURIComponent(this.name);
  }

  private async rpc<T>(
    fn: string,
    params: Record<string, unknown>,
    decode: ResponseDecoder<T>,
  ): Promise<T> {
    const scopedClient = this.options.supabase.schema("pgmq_public");
    try {
      const rpcResult: { data: unknown; error: unknown } = await scopedClient.rpc(fn, params).retry(false);
      const { data, error } = rpcResult;
      if (error) throw new SupaCloudQueueError(true, "QUEUE_RPC_FAILED");
      return decode(data);
    } catch (error) {
      // Read changes visibility and pop deletes a message, so every RPC here can mutate.
      throw new SupaCloudQueueError(true, error instanceof SupaCloudQueueError
        ? error.code ?? "QUEUE_CONTRACT_INVALID" : "QUEUE_RPC_FAILED");
    }
  }

  async send(
    payload: SupaCloudQueueJson = {},
    options: SupaCloudQueueSendOptions = {},
  ): Promise<SupaCloudQueueSendResult> {
    const captured = queueJsonSnapshot(payload);
    const msgId = await this.rpc("send", {
      queue_name: this.name,
      message: captured,
      sleep_seconds: normalizeSecondsFromOptions(options),
    }, queueRpcId);
    return {
      id: String(msgId),
      msg_id: msgId,
      queue_name: this.name,
      status: "pending",
      payload: captured,
    };
  }

  async sendBatch(
    messages: SupaCloudQueueJson[],
    options: SupaCloudQueueSendOptions = {},
  ): Promise<SupaCloudQueueSendResult[]> {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 10000) throw new SupaCloudQueueError();
    const captured = queueJsonSnapshot(messages);
    if (!Array.isArray(captured)) throw new SupaCloudQueueError();
    const ids = await this.rpc("send_batch", {
      queue_name: this.name,
      messages: captured,
      sleep_seconds: normalizeSecondsFromOptions(options),
    }, value => queueRpcIds(value, captured.length));
    return ids.map((msgId, index): SupaCloudQueueSendResult => {
      const payload = captured[index];
      if (payload === undefined) throw new SupaCloudQueueError(true);
      return {
        id: msgId,
        msg_id: msgId,
        queue_name: this.name,
        status: "pending",
        payload,
      };
    });
  }

  async read(
    options: SupaCloudQueueReceiveOptions = {},
  ): Promise<SupaCloudQueueMessage[]> {
    const count = queueReadCount(options);
    return this.rpc("read", {
      queue_name: this.name,
      sleep_seconds: normalizeSecondsFromOptions(options),
      n: count,
    }, (value) => queueRpcMessages(this.name, value, count, "leased"));
  }

  async receive(
    options: SupaCloudQueueReceiveOptions = {},
  ): Promise<SupaCloudQueueMessage | null> {
    queueReadCount(options, true);
    const messages = await this.read({ ...options, n: 1 });
    return messages[0] ?? null;
  }

  async pop(): Promise<SupaCloudQueueMessage | null> {
    return this.rpc("pop", { queue_name: this.name }, (value) =>
      queueRpcMessages(this.name, value, 1, "deleted")[0] ?? null);
  }

  async list(filters: SupaCloudQueueListFilters = {}): Promise<SupaCloudQueueMessage[]> {
    return this.request<SupaCloudQueueMessage[]>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages${createQueueQueryString(filters)}`,
      "GET",
      undefined,
      value => decodeQueueMessages(value, this.name),
    );
  }

  async listFailed(limit = 100): Promise<SupaCloudQueueMessage[]> {
    return this.list({ archived: true, dlq: true, limit });
  }

  async listArchived(limit = 100): Promise<SupaCloudQueueMessage[]> {
    return this.list({ archived: true, limit });
  }

  async stats(): Promise<SupaCloudQueueStats> {
    return this.request<SupaCloudQueueStats>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/stats`,
      "GET",
      undefined,
      decodeQueueStats,
    );
  }

  async getSettings(): Promise<SupaCloudQueueSettings> {
    return this.request<SupaCloudQueueSettings>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/settings`,
      "GET",
      undefined,
      decodeQueueSettings,
    );
  }

  async updateSettings(settings: SupaCloudQueueSettingsUpdate): Promise<SupaCloudQueueSettings> {
    return this.request<SupaCloudQueueSettings>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/settings`,
      "PATCH",
      settings,
      decodeQueueSettings,
    );
  }

  async archive(messageId: string | number): Promise<SupaCloudQueueMutationResult> {
    const msgId = queueMessageId(messageId);
    const success = await this.rpc("archive", {
      queue_name: this.name,
      message_id: msgId,
    }, queueRpcBoolean);
    return { id: String(msgId), msg_id: msgId, queue_name: this.name, status: "archived", success };
  }

  async ack(messageId: string | number): Promise<SupaCloudQueueMutationResult> {
    return this.archive(messageId);
  }

  async delete(messageId: string | number): Promise<SupaCloudQueueMutationResult> {
    const msgId = queueMessageId(messageId);
    const success = await this.rpc("delete", {
      queue_name: this.name,
      message_id: msgId,
    }, queueRpcBoolean);
    return { id: String(msgId), msg_id: msgId, queue_name: this.name, status: "deleted", success };
  }

  async release(
    messageId: string | number,
    options: SupaCloudQueueReleaseOptions = {},
  ): Promise<SupaCloudQueueMessage> {
    const msgId = queueMessageId(messageId);
    const body = {
      sleep_seconds: normalizeSecondsFromOptions(options),
      ...(options.error ? { error: options.error } : {}),
    };
    try {
      return await this.request<SupaCloudQueueMessage>(
        `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${msgId}/release`,
        "POST", body, value => queueMessage(value, { queueName: this.name, messageId: msgId }),
      );
    } catch {
      throw new SupaCloudQueueError(true, "QUEUE_MANAGEMENT_FAILED");
    }
  }

  async purge(): Promise<{ queue_name: string; purged: number }> {
    return this.request<{ queue_name: string; purged: number }>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/purge`,
      "POST",
      undefined,
      decodePurgeResult,
    );
  }

  /**
   * SupaCloud extension alias: PGMQ has archive/delete but no failed state.
   * This archives the message, matching the management API's compatibility behavior.
   */
  async fail(
    messageId: string | number,
    _options: SupaCloudQueueFailOptions = {},
  ): Promise<SupaCloudQueueMutationResult> {
    return this.archive(messageId);
  }

  /**
   * @deprecated Direct random lookup is not part of Supabase Queues' official API.
   */
  async get(messageId: string): Promise<SupaCloudQueueMessage> {
    const msgId = queueMessageId(messageId);
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${msgId}`,
      "GET",
      undefined,
      value => queueMessage(value, { queueName: this.name, messageId: msgId }),
    );
  }

  /**
   * @deprecated PGMQ archived messages are replayed with SQL/application workflows, not an official Queue API call.
   */
  async retry(messageId: string): Promise<SupaCloudQueueMessage> {
    const msgId = queueMessageId(messageId);
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${msgId}/retry`,
      "POST",
      undefined,
      value => queueMessage(value, { queueName: this.name, messageId: msgId }),
    );
  }
}

class SupaCloudQueuesClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  async list(): Promise<SupaCloudQueueInfo[]> {
    return this.request<SupaCloudQueueInfo[]>(
      `/v1/projects/${this.options.projectRef}/tasks/queues`,
      "GET",
      undefined,
      decodeQueueInfos,
    );
  }

  async create(queueName: string, options: SupaCloudQueueCreateOptions = {}): Promise<SupaCloudQueueInfo> {
    return this.request<SupaCloudQueueInfo>(
      `/v1/projects/${this.options.projectRef}/tasks/queues`,
      "POST",
      { queue_name: queueName, unlogged: options.unlogged },
      decodeQueueInfo,
    );
  }

  async drop(queueName: string): Promise<void> {
    await this.request<void>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${encodeURIComponent(queueName)}`,
      "DELETE",
      undefined,
      decodeVoid,
    );
  }
}

export function createSupaCloudClient<TClient extends SupabaseClient = SupabaseClient>(
  options: SupaCloudClientOptions<TClient>,
) {
  const normalized: Required<SupaCloudClientOptions<TClient>> = {
    ...options,
    managementApiUrl: normalizeBaseUrl(options.managementApiUrl),
    pollingIntervalMs: options.pollingIntervalMs ?? 3000,
    getAccessToken:
      options.getAccessToken ??
      (() => defaultAccessTokenResolver(options.supabase)),
  };

  const tasks = new SupaCloudTasksClient(normalized);
  const oauthServer = new SupaCloudOAuthServerClient(normalized);
  const oauthClients = new SupaCloudOAuthClientsClient(normalized);
  const queues = new SupaCloudQueuesClient(normalized);
  const workflows = new SupaCloudWorkflowsClient(options.supabase);
  const commands = new SupaCloudCommandsClient(options.supabase);
  const artifacts = new SupaCloudArtifactsClient(options.supabase);

  return {
    supabase: options.supabase,
    projectRef: normalized.projectRef,
    managementApiUrl: normalized.managementApiUrl,
    auth: {
      oauthServer,
      oauthClients,
    },
    tasks,
    workflows,
    commands,
    artifacts,
    queues,
    queue: (name: string) => new SupaCloudQueueClient(normalized, name),
    functions: {
      invokeBackground: (
        functionName: string,
        submitOptions?: SupaCloudTaskSubmitOptions,
      ) => tasks.submit(functionName, submitOptions),
    },
  };
}
