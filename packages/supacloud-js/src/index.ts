import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";
import { SupaCloudWorkflowsClient } from "./workflows.js";
import { SupaCloudCommandsClient } from "./commands.js";
import { SupaCloudArtifactsClient } from "./artifacts.js";

export {
  createSupaCloudOAuthFetch,
  type SupaCloudOAuthFetchOptions,
} from "./auth-fetch.js";
export * from "./workflows.js";
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

export type SupaCloudTaskDetail = {
  id: string;
  status: SupaCloudTaskStatus | string;
  function_slug?: string | null;
  function_version?: string | null;
  attempt?: number | null;
  max_attempts?: number | null;
  progress?: number | null;
  error?: string | null;
  error_message?: string | null;
  result?: unknown;
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

export type SupaCloudTaskSnapshot = {
  id: string;
  status: SupaCloudTaskStatus | string;
  progress?: number | null;
  error?: string | null;
  updatedAt?: string | null;
  raw: unknown;
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
  retries?: number;
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

export type SupaCloudQueueMessage = {
  id: string;
  msg_id: number;
  read_ct?: number;
  enqueued_at?: string | null;
  vt?: string | null;
  message?: Record<string, unknown>;
  payload: Record<string, unknown>;
  status?: string;
  queue_name?: string;
  task_type?: string;
  [key: string]: unknown;
};

export type SupaCloudQueueSendResult = {
  id: string;
  msg_id: number;
  queue_name: string;
  status: "pending";
  payload: Record<string, unknown>;
};

export type SupaCloudQueueMutationResult = {
  id: string;
  msg_id: number;
  queue_name: string;
  status: "archived" | "deleted" | "released";
  success: boolean;
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

export type SupaCloudSupAuthAdminMode = "sso" | "token" | "auto";

export type SupaCloudSupAuthStorageBucket = {
  id: string;
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
};

export type SupaCloudSupAuthProvisionOptions = {
  authDomain?: string;
  apiDomain?: string;
  adminMode?: SupaCloudSupAuthAdminMode;
  adminSsoClientId?: string;
  runtimeUrl?: string;
  supaOAuthUrl?: string;
  storageBuckets?: SupaCloudSupAuthStorageBucket[];
  metadata?: Record<string, unknown>;
};

export type SupaCloudSupAuthReconcileOptions = {
  dryRun?: boolean;
  force?: boolean;
};

export type SupaCloudSupAuthStepResult = {
  step: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | string;
  message?: string;
  details?: Record<string, unknown>;
};

export type SupaCloudSupAuthProvisionResult = {
  projectRef: string;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  steps?: SupaCloudSupAuthStepResult[];
  raw?: unknown;
};

export type SupaCloudSupAuthReconcileResult = {
  projectRef: string;
  changed: boolean;
  dryRun?: boolean;
  steps?: SupaCloudSupAuthStepResult[];
  raw?: unknown;
};

export type SupaCloudSupAuthRollbackResult = {
  projectRef: string;
  status: "succeeded" | "failed" | string;
  steps?: SupaCloudSupAuthStepResult[];
  raw?: unknown;
};

export type SupaCloudSupAuthClientConfig = {
  projectRef: string;
  supabaseUrl: string;
  anonKey?: string | null;
  authUrl: string;
  restUrl: string;
  storageUrl: string;
  realtimeUrl: string;
  functionsUrl: string;
  issuer?: string | null;
  jwksUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type SupaCloudSupAuthVerificationCheck = {
  name: string;
  status: "pass" | "fail" | "warn" | string;
  message?: string;
  details?: Record<string, unknown>;
};

export type SupaCloudSupAuthVerification = {
  projectRef: string;
  healthy: boolean;
  checks: SupaCloudSupAuthVerificationCheck[];
};

export type SupaCloudTaskWaitOptions = {
  intervalMs?: number;
  signal?: AbortSignal;
};

export type SupaCloudTaskSubscribeState =
  | "connecting"
  | "realtime"
  | "polling"
  | "closed";

export type SupaCloudTaskSubscribeOptions = {
  pollingIntervalMs?: number;
  realtimeTimeoutMs?: number;
  reconcileIntervalMs?: number;
  onUpdate: (task: SupaCloudTaskSnapshot) => void;
  onStateChange?: (
    state: SupaCloudTaskSubscribeState,
    details?: { error?: unknown },
  ) => void;
  onError?: (error: unknown) => void;
  stopOnTerminal?: boolean;
};

export type SupaCloudTaskReceipt = {
  taskId: string;
  status: string;
  get: () => Promise<SupaCloudTaskDetail>;
  wait: (options?: SupaCloudTaskWaitOptions) => Promise<SupaCloudTaskDetail>;
  cancel: () => Promise<SupaCloudTaskDetail>;
  retry: () => Promise<SupaCloudTaskDetail>;
  subscribe: (
    options: SupaCloudTaskSubscribeOptions,
  ) => { connectionState: SupaCloudTaskSubscribeState; unsubscribe: () => void };
};

export type SupaCloudClientOptions<TClient extends SupabaseClient = SupabaseClient> = {
  supabase: TClient;
  managementApiUrl: string;
  projectRef: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  pollingIntervalMs?: number;
};

export type SupaCloudOAuthServerStatus = {
  project_ref: string;
  organization_id?: string;
  account_isolated: boolean;
  enabled: boolean;
  allow_dynamic_registration: boolean;
  issuer: string;
  authorization_path?: string;
  discovery_url: string;
  oauth_authorization_server_metadata_url?: string;
  jwks_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  signing_alg?: string;
  oidc_id_token_ready?: boolean;
  migration_status?: string;
  warnings?: string[];
};

export type SupaCloudOAuthClientType = "public" | "confidential";
export type SupaCloudOAuthClientAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";

export type SupaCloudOAuthClient = {
  client_id: string;
  client_secret?: string;
  client_type?: SupaCloudOAuthClientType | string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: SupaCloudOAuthClientAuthMethod | string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  registration_type?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type SupaCloudOAuthClientList = {
  clients?: SupaCloudOAuthClient[];
  [key: string]: unknown;
};

export type SupaCloudOAuthClientCreate = {
  redirect_uris: string[];
  client_type?: SupaCloudOAuthClientType;
  token_endpoint_auth_method?: SupaCloudOAuthClientAuthMethod;
  grant_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
};

export type SupaCloudOAuthClientUpdate = Partial<Omit<SupaCloudOAuthClientCreate, "client_type">>;

export type SupaCloudAuthorizeUrlOptions = {
  clientId: string;
  redirectUri: string;
  scope?: string | string[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  nonce?: string;
  responseType?: "code";
  resource?: string;
};

export class SupaCloudTaskSubmitError extends Error {
  readonly responseBody: unknown;

  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "SupaCloudTaskSubmitError";
    this.responseBody = responseBody;
  }
}

export class SupaCloudApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly responseBody: unknown;

  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = "SupaCloudApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.code = extractErrorCode(responseBody);
  }
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
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
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
  const params = new URLSearchParams();

  const statuses = toArray(filters.status);
  const taskTypes = toArray(filters.taskType);

  if (statuses?.length) params.set("status", statuses.join(","));
  if (taskTypes?.length) params.set("task_type", taskTypes.join(","));
  if (filters.functionSlug) params.set("function_slug", filters.functionSlug);
  if (filters.dlq) params.set("dlq", "true");
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));

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
  if (typeof options.sleepSeconds === "number") return Math.max(0, Math.floor(options.sleepSeconds));
  if (typeof options.sleep_seconds === "number") return Math.max(0, Math.floor(options.sleep_seconds));
  if (typeof options.visibilityTimeoutSec === "number") return Math.max(0, Math.floor(options.visibilityTimeoutSec));
  if (typeof options.delayMs === "number") return Math.max(0, Math.floor(options.delayMs / 1000));
  return 0;
}

function normalizeMessageId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function firstRpcValue(value: unknown): unknown {
  return isUnknownArray(value) ? value[0] : value;
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

function responseBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label} response: ${key} is required`);
  }
  return value;
}

function decodeVoid(value: unknown): void {
  if (value !== undefined) throw new Error("Expected an empty response");
}

function decodeTaskDetail(value: unknown): SupaCloudTaskDetail {
  const record = responseRecord(value, "task");
  return {
    ...record,
    id: responseString(record, "id", "task"),
    status: responseString(record, "status", "task"),
  };
}

function decodeTaskDetails(value: unknown): SupaCloudTaskDetail[] {
  if (!Array.isArray(value)) throw new Error("Invalid task list response");
  return value.map(decodeTaskDetail);
}

function decodeQueueMessage(value: unknown): SupaCloudQueueMessage {
  const record = responseRecord(value, "queue message");
  const messageValue = record.message ?? record.payload;
  const message = valueRecord(messageValue);
  return {
    ...record,
    id: responseString(record, "id", "queue message"),
    msg_id: responseNumber(record, "msg_id", "queue message"),
    message,
    payload: message,
  };
}

function decodeQueueMessages(value: unknown): SupaCloudQueueMessage[] {
  if (!Array.isArray(value)) throw new Error("Invalid queue message list response");
  return value.map(decodeQueueMessage);
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

function decodeOAuthServerStatus(value: unknown): SupaCloudOAuthServerStatus {
  const record = responseRecord(value, "OAuth Server");
  return {
    ...record,
    project_ref: responseString(record, "project_ref", "OAuth Server"),
    account_isolated: responseBoolean(record, "account_isolated", "OAuth Server"),
    enabled: responseBoolean(record, "enabled", "OAuth Server"),
    allow_dynamic_registration: responseBoolean(record, "allow_dynamic_registration", "OAuth Server"),
    issuer: responseString(record, "issuer", "OAuth Server"),
    discovery_url: responseString(record, "discovery_url", "OAuth Server"),
    jwks_url: responseString(record, "jwks_url", "OAuth Server"),
    authorization_endpoint: responseString(record, "authorization_endpoint", "OAuth Server"),
    token_endpoint: responseString(record, "token_endpoint", "OAuth Server"),
  };
}

function decodeOAuthClient(value: unknown): SupaCloudOAuthClient {
  const record = responseRecord(value, "OAuth client");
  return {
    ...record,
    client_id: responseString(record, "client_id", "OAuth client"),
  };
}

function decodeOAuthClientList(value: unknown): SupaCloudOAuthClientList {
  const record = responseRecord(value, "OAuth client list");
  const clients = record.clients;
  if (clients === undefined) return record;
  if (!Array.isArray(clients)) throw new Error("Invalid OAuth client list response");
  return { ...record, clients: clients.map(decodeOAuthClient) };
}

function decodeSupAuthStepResult(value: unknown): SupaCloudSupAuthStepResult {
  const record = responseRecord(value, "SupAuth step");
  return {
    ...record,
    step: responseString(record, "step", "SupAuth step"),
    status: responseString(record, "status", "SupAuth step"),
  };
}

function decodeSupAuthProvisionResult(value: unknown): SupaCloudSupAuthProvisionResult {
  const record = responseRecord(value, "SupAuth provision");
  const steps = record.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new Error("Invalid SupAuth provision response");
  }
  return {
    ...record,
    projectRef: responseString(record, "projectRef", "SupAuth provision"),
    status: responseString(record, "status", "SupAuth provision"),
    ...(steps === undefined ? {} : { steps: steps.map(decodeSupAuthStepResult) }),
  };
}

function decodeSupAuthReconcileResult(value: unknown): SupaCloudSupAuthReconcileResult {
  const record = responseRecord(value, "SupAuth reconcile");
  const steps = record.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new Error("Invalid SupAuth reconcile response");
  }
  return {
    ...record,
    projectRef: responseString(record, "projectRef", "SupAuth reconcile"),
    changed: responseBoolean(record, "changed", "SupAuth reconcile"),
    ...(steps === undefined ? {} : { steps: steps.map(decodeSupAuthStepResult) }),
  };
}

function decodeSupAuthRollbackResult(value: unknown): SupaCloudSupAuthRollbackResult {
  const record = responseRecord(value, "SupAuth rollback");
  const steps = record.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new Error("Invalid SupAuth rollback response");
  }
  return {
    ...record,
    projectRef: responseString(record, "projectRef", "SupAuth rollback"),
    status: responseString(record, "status", "SupAuth rollback"),
    ...(steps === undefined ? {} : { steps: steps.map(decodeSupAuthStepResult) }),
  };
}

function decodeSupAuthClientConfig(value: unknown): SupaCloudSupAuthClientConfig {
  const record = responseRecord(value, "SupAuth client config");
  return {
    ...record,
    projectRef: responseString(record, "projectRef", "SupAuth client config"),
    supabaseUrl: responseString(record, "supabaseUrl", "SupAuth client config"),
    authUrl: responseString(record, "authUrl", "SupAuth client config"),
    restUrl: responseString(record, "restUrl", "SupAuth client config"),
    storageUrl: responseString(record, "storageUrl", "SupAuth client config"),
    realtimeUrl: responseString(record, "realtimeUrl", "SupAuth client config"),
    functionsUrl: responseString(record, "functionsUrl", "SupAuth client config"),
  };
}

function decodeSupAuthVerification(value: unknown): SupaCloudSupAuthVerification {
  const record = responseRecord(value, "SupAuth verification");
  const checks = record.checks;
  if (!isUnknownArray(checks)) throw new Error("Invalid SupAuth verification response");
  return {
    ...record,
    projectRef: responseString(record, "projectRef", "SupAuth verification"),
    healthy: responseBoolean(record, "healthy", "SupAuth verification"),
    checks: checks.map((check) => {
      const record = responseRecord(check, "SupAuth check");
      return {
        ...record,
        name: responseString(record, "name", "SupAuth check"),
        status: responseString(record, "status", "SupAuth check"),
      };
    }),
  };
}

function decodePurgeResult(value: unknown): { queue_name: string; purged: number } {
  const record = responseRecord(value, "queue purge");
  return {
    queue_name: responseString(record, "queue_name", "queue purge"),
    purged: responseNumber(record, "purged", "queue purge"),
  };
}

function normalizeRpcMessage(queueName: string, value: unknown, status?: string): SupaCloudQueueMessage | null {
  const row = firstRpcValue(value);
  if (!row || typeof row !== "object") return null;
  const record = valueRecord(row);
  const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
    ? valueRecord(record.message)
    : {};
  const msgId = normalizeMessageId(record.msg_id ?? record.id);
  return {
    ...record,
    id: String(msgId),
    msg_id: msgId,
    message,
    payload: message,
    status,
    queue_name: queueName,
    task_type: `queue:${queueName}`,
  };
}

function normalizeRpcMessages(queueName: string, value: unknown, status?: string): SupaCloudQueueMessage[] {
  const rows = isUnknownArray(value) ? value : value == null ? [] : [value];
  return rows
    .map((row) => normalizeRpcMessage(queueName, row, status))
    .filter((row): row is SupaCloudQueueMessage => Boolean(row));
}

function normalizeRpcMessageId(value: unknown): number {
  const row = firstRpcValue(value);
  if (row && typeof row === "object") {
    const record = valueRecord(row);
    return normalizeMessageId(record.msg_id ?? record.send ?? record.send_batch ?? record.id);
  }
  return normalizeMessageId(row);
}

function normalizeRpcMessageIds(value: unknown): number[] {
  const rows = isUnknownArray(value) ? value : value == null ? [] : [value];
  return rows.map((row) => normalizeRpcMessageId(row)).filter((id) => id > 0);
}

function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const code = valueRecord(body).code;
  return typeof code === "string" ? code : null;
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

function normalizeTaskSnapshot(task: unknown): SupaCloudTaskSnapshot {
  const value = valueRecord(task ?? {});
  return {
    id: String(value.id ?? ""),
    status: String(value.status ?? "unknown"),
    progress: typeof value.progress === "number" ? value.progress : null,
    error:
      typeof value.error === "string"
        ? value.error
        : typeof value.error_message === "string"
          ? value.error_message
          : null,
    updatedAt:
      typeof value.updated_at === "string"
        ? value.updated_at
        : typeof value.updatedAt === "string"
          ? value.updatedAt
          : null,
    raw: task,
  };
}

class SupaCloudManagementClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(protected readonly options: Required<SupaCloudClientOptions<TClient>>) {}

  protected async resolveAccessToken(): Promise<string> {
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
  ): Promise<T> {
    const accessToken = await this.resolveAccessToken();
    const response = await fetch(`${this.options.managementApiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  private createReceipt(taskId: string, status: string): SupaCloudTaskReceipt {
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

  async submit(
    functionName: string,
    options: SupaCloudTaskSubmitOptions = {},
  ) {
    const { body, headers = {}, retries: _retries, timeoutSec: _timeoutSec, idempotencyKey, method } = options;
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
    const invocation: { data: unknown; error: unknown } = await this.options.supabase.functions.invoke(functionName, {
      body,
      method,
      headers: invokeHeaders,
    });
    const { data, error } = invocation;

    if (error) throw error;

    const payload = valueRecord(data ?? {});
    const taskId =
      typeof payload.task_id === "string"
        ? payload.task_id
        : typeof payload.taskId === "string"
          ? payload.taskId
          : null;

    if (!taskId) {
      throw new SupaCloudTaskSubmitError(
        "Background task was not enqueued",
        data,
      );
    }

    return this.createReceipt(taskId, String(payload.status ?? "enqueued"));
  }

  async get(taskId: string): Promise<SupaCloudTaskDetail> {
    return this.request<SupaCloudTaskDetail>(
      `/v1/projects/${this.options.projectRef}/tasks/${taskId}`,
      "GET",
      undefined,
      decodeTaskDetail,
    );
  }

  async list(filters: SupaCloudTaskListFilters = {}): Promise<SupaCloudTaskDetail[]> {
    return this.request<SupaCloudTaskDetail[]>(
      `/v1/projects/${this.options.projectRef}/tasks${createQueryString(filters)}`,
      "GET",
      undefined,
      decodeTaskDetails,
    );
  }

  async cancel(taskId: string): Promise<SupaCloudTaskDetail> {
    return this.request<SupaCloudTaskDetail>(
      `/v1/projects/${this.options.projectRef}/tasks/${taskId}/cancel`,
      "POST",
      undefined,
      decodeTaskDetail,
    );
  }

  async retry(taskId: string): Promise<SupaCloudTaskDetail> {
    return this.request<SupaCloudTaskDetail>(
      `/v1/projects/${this.options.projectRef}/tasks/${taskId}/retry`,
      "POST",
      undefined,
      decodeTaskDetail,
    );
  }

  async listDlq(limit = 100): Promise<SupaCloudTaskDetail[]> {
    return this.request<SupaCloudTaskDetail[]>(
      `/v1/projects/${this.options.projectRef}/tasks/dlq?limit=${limit}`,
      "GET",
      undefined,
      decodeTaskDetails,
    );
  }

  async wait(
    taskId: string,
    options: SupaCloudTaskWaitOptions = {},
  ): Promise<SupaCloudTaskDetail> {
    const intervalMs = options.intervalMs ?? this.options.pollingIntervalMs;

    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      const task = await this.get(taskId);
      if (TERMINAL_STATUSES.has(String(task.status))) return task;

      await waitForPollingInterval(intervalMs, options.signal);
    }
  }

  subscribe(taskId: string, options: SupaCloudTaskSubscribeOptions) {
    let closed: boolean = false;
    let channel: RealtimeChannel | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let realtimeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let mode: SupaCloudTaskSubscribeState = "connecting";
    const pollingIntervalMs =
      options.pollingIntervalMs ?? this.options.pollingIntervalMs;
    const realtimeTimeoutMs = options.realtimeTimeoutMs ?? 10000;
    const reconcileIntervalMs = options.reconcileIntervalMs ?? Math.max(30000, pollingIntervalMs * 10);
    const stopOnTerminal = options.stopOnTerminal ?? true;

    const setMode = (
      next: SupaCloudTaskSubscribeState,
      details?: { error?: unknown },
    ) => {
      if (closed || mode === next) return;
      mode = next;
      options.onStateChange?.(next, details);
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
        await this.options.supabase.removeChannel(current);
      }
    };

    const close = async () => {
      if (closed) return;
      stopPolling();
      stopRealtimeTimeout();
      stopReconcile();
      await teardownRealtime();
      setMode("closed");
      closed = true;
    };

    const emitTask = (task: unknown) => {
      const snapshot = normalizeTaskSnapshot(task);
      options.onUpdate(snapshot);

      if (stopOnTerminal && TERMINAL_STATUSES.has(snapshot.status)) {
        void close();
      }
    };

    const pollOnce = async () => {
      if (closed) return;

      try {
        const task = await this.get(taskId);
        emitTask(task);
      } catch (error) {
        options.onError?.(error);
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
        emitTask(await this.get(taskId));
      } catch (error) {
        options.onError?.(error);
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

    channel = this.options.supabase
      .channel(`supacloud-task:${this.options.projectRef}:${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `id=eq.${taskId}`,
        },
        (payload) => {
          const next = payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old;
          if (next) emitTask(next);
        },
      )
      .subscribe(async (status, error) => {
        if (closed) return;

        if (status === "SUBSCRIBED") {
          stopPolling();
          stopRealtimeTimeout();
          setMode("realtime");
          try {
            emitTask(await this.get(taskId));
          } catch (err) {
            options.onError?.(err);
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

    if (realtimeTimeoutMs > 0) {
      realtimeTimeoutTimer = setTimeout(() => {
        if (!closed && mode === "connecting") {
          void teardownRealtime().finally(() => {
            startPolling(new Error("SupaCloud Realtime subscription timed out"));
          });
        }
      }, realtimeTimeoutMs);
    }

    setMode("connecting");

    return {
      get connectionState() {
        return mode;
      },
      unsubscribe() {
        void close();
      },
    };
  }
}

class SupaCloudQueueClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  constructor(
    options: Required<SupaCloudClientOptions<TClient>>,
    private readonly name: string,
  ) {
    super(options);
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
    const rpcResult: { data: unknown; error: unknown } = await scopedClient.rpc(fn, params);
    const { data, error } = rpcResult;
    if (error) throw error;
    return decode(data);
  }

  async send(
    payload: Record<string, unknown> = {},
    options: SupaCloudQueueSendOptions = {},
  ): Promise<SupaCloudQueueSendResult> {
    const msgId = await this.rpc("send", {
      queue_name: this.name,
      message: payload,
      sleep_seconds: normalizeSecondsFromOptions(options),
    }, normalizeRpcMessageId);
    return {
      id: String(msgId),
      msg_id: msgId,
      queue_name: this.name,
      status: "pending",
      payload,
    };
  }

  async sendBatch(
    messages: Record<string, unknown>[],
    options: SupaCloudQueueSendOptions = {},
  ): Promise<SupaCloudQueueSendResult[]> {
    const ids = await this.rpc("send_batch", {
      queue_name: this.name,
      messages,
      sleep_seconds: normalizeSecondsFromOptions(options),
    }, normalizeRpcMessageIds);
    return ids.map((msgId, index) => ({
      id: String(msgId),
      msg_id: msgId,
      queue_name: this.name,
      status: "pending",
      payload: messages[index] ?? {},
    }));
  }

  async read(
    options: SupaCloudQueueReceiveOptions = {},
  ): Promise<SupaCloudQueueMessage[]> {
    return this.rpc("read", {
      queue_name: this.name,
      sleep_seconds: normalizeSecondsFromOptions(options),
      n: Math.max(1, Math.floor(options.n ?? options.count ?? 1)),
    }, (value) => normalizeRpcMessages(this.name, value, "leased"));
  }

  async receive(
    options: SupaCloudQueueReceiveOptions = {},
  ): Promise<SupaCloudQueueMessage | null> {
    const messages = await this.read({ ...options, n: 1 });
    return messages[0] ?? null;
  }

  async pop(): Promise<SupaCloudQueueMessage | null> {
    return this.rpc("pop", { queue_name: this.name }, (value) =>
      normalizeRpcMessage(this.name, value, "deleted"));
  }

  async list(filters: SupaCloudQueueListFilters = {}): Promise<SupaCloudQueueMessage[]> {
    return this.request<SupaCloudQueueMessage[]>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages${createQueueQueryString(filters)}`,
      "GET",
      undefined,
      decodeQueueMessages,
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
    const msgId = normalizeMessageId(messageId);
    const success = await this.rpc("archive", {
      queue_name: this.name,
      message_id: msgId,
    }, (value) => Boolean(firstRpcValue(value)));
    return { id: String(msgId), msg_id: msgId, queue_name: this.name, status: "archived", success };
  }

  async ack(messageId: string | number): Promise<SupaCloudQueueMutationResult> {
    return this.archive(messageId);
  }

  async delete(messageId: string | number): Promise<SupaCloudQueueMutationResult> {
    const msgId = normalizeMessageId(messageId);
    const success = await this.rpc("delete", {
      queue_name: this.name,
      message_id: msgId,
    }, (value) => Boolean(firstRpcValue(value)));
    return { id: String(msgId), msg_id: msgId, queue_name: this.name, status: "deleted", success };
  }

  async release(
    messageId: string | number,
    options: SupaCloudQueueReleaseOptions = {},
  ): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/release`,
      "POST",
      {
        sleep_seconds: normalizeSecondsFromOptions(options),
        ...(options.error ? { error: options.error } : {}),
      },
      decodeQueueMessage,
    );
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
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}`,
      "GET",
      undefined,
      decodeQueueMessage,
    );
  }

  /**
   * @deprecated PGMQ archived messages are replayed with SQL/application workflows, not an official Queue API call.
   */
  async retry(messageId: string): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/retry`,
      "POST",
      undefined,
      decodeQueueMessage,
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

class SupaCloudOAuthServerClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  async getStatus(): Promise<SupaCloudOAuthServerStatus> {
    return this.request<SupaCloudOAuthServerStatus>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-server`,
      "GET",
      undefined,
      decodeOAuthServerStatus,
    );
  }

  async migrateToOidc(options: {
    allowDynamicRegistration?: boolean;
    authorizationPath?: string;
  } = {}): Promise<SupaCloudOAuthServerStatus> {
    return this.request<SupaCloudOAuthServerStatus>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-server/migrate`,
      "POST",
      {
        allow_dynamic_registration: options.allowDynamicRegistration === true,
        ...(options.authorizationPath === undefined
          ? {}
          : { authorization_path: options.authorizationPath }),
      },
      decodeOAuthServerStatus,
    );
  }

  async getDiscovery(): Promise<Record<string, unknown>> {
    const status = await this.getStatus();
    const response = await fetch(status.discovery_url);
    if (!response.ok) throw new Error(`SupaCloud OIDC discovery failed (${response.status})`);
    const payload: unknown = await response.json();
    return valueRecord(payload);
  }

  async getJwks(): Promise<Record<string, unknown>> {
    const status = await this.getStatus();
    const response = await fetch(status.jwks_url);
    if (!response.ok) throw new Error(`SupaCloud JWKS fetch failed (${response.status})`);
    const payload: unknown = await response.json();
    return valueRecord(payload);
  }

  async buildAuthorizeUrl(options: SupaCloudAuthorizeUrlOptions): Promise<string> {
    const status = await this.getStatus();
    const url = new URL(status.authorization_endpoint);
    url.searchParams.set("client_id", options.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("response_type", options.responseType ?? "code");
    const scope = Array.isArray(options.scope) ? options.scope.join(" ") : options.scope;
    if (scope) url.searchParams.set("scope", scope);
    if (options.state) url.searchParams.set("state", options.state);
    if (options.codeChallenge) url.searchParams.set("code_challenge", options.codeChallenge);
    if (options.codeChallengeMethod) url.searchParams.set("code_challenge_method", options.codeChallengeMethod);
    if (options.nonce) url.searchParams.set("nonce", options.nonce);
    if (options.resource) url.searchParams.set("resource", options.resource);
    return url.toString();
  }
}

class SupaCloudOAuthClientsClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  async list(): Promise<SupaCloudOAuthClientList> {
    return this.request<SupaCloudOAuthClientList>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients`,
      "GET",
      undefined,
      decodeOAuthClientList,
    );
  }

  async create(input: SupaCloudOAuthClientCreate): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients`,
      "POST",
      input,
      decodeOAuthClient,
    );
  }

  async get(clientId: string): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "GET",
      undefined,
      decodeOAuthClient,
    );
  }

  async update(clientId: string, patch: SupaCloudOAuthClientUpdate): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "PUT",
      patch,
      decodeOAuthClient,
    );
  }

  async delete(clientId: string): Promise<void> {
    await this.request<void>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "DELETE",
      undefined,
      decodeVoid,
    );
  }

  async regenerateSecret(clientId: string): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}/regenerate-secret`,
      "POST",
      undefined,
      decodeOAuthClient,
    );
  }
}

class SupaCloudSupAuthClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  private get basePath(): string {
    return `/v1/projects/${this.options.projectRef}/supauth`;
  }

  async provision(
    options: SupaCloudSupAuthProvisionOptions = {},
  ): Promise<SupaCloudSupAuthProvisionResult> {
    return this.request<SupaCloudSupAuthProvisionResult>(
      `${this.basePath}/provision`,
      "POST",
      options,
      decodeSupAuthProvisionResult,
    );
  }

  async reconcile(
    options: SupaCloudSupAuthReconcileOptions = {},
  ): Promise<SupaCloudSupAuthReconcileResult> {
    return this.request<SupaCloudSupAuthReconcileResult>(
      `${this.basePath}/reconcile`,
      "POST",
      options,
      decodeSupAuthReconcileResult,
    );
  }

  async rollback(): Promise<SupaCloudSupAuthRollbackResult> {
    return this.request<SupaCloudSupAuthRollbackResult>(
      `${this.basePath}/rollback`,
      "POST",
      undefined,
      decodeSupAuthRollbackResult,
    );
  }

  async getClientConfig(): Promise<SupaCloudSupAuthClientConfig> {
    return this.request<SupaCloudSupAuthClientConfig>(
      `${this.basePath}/client-config`,
      "GET",
      undefined,
      decodeSupAuthClientConfig,
    );
  }

  async verify(): Promise<SupaCloudSupAuthVerification> {
    return this.request<SupaCloudSupAuthVerification>(
      `${this.basePath}/verify`,
      "GET",
      undefined,
      decodeSupAuthVerification,
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
  const supauth = new SupaCloudSupAuthClient(normalized);
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
    supauth,
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
