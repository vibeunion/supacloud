import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";

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
  delayMs?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  businessTaskId?: string;
  metadata?: Record<string, unknown>;
};

export type SupaCloudQueueReceiveOptions = {
  visibilityTimeoutSec?: number;
};

export type SupaCloudQueueReleaseOptions = {
  delayMs?: number;
  error?: string;
};

export type SupaCloudQueueFailOptions = {
  error?: string;
  deadLetter?: boolean;
};

export type SupaCloudQueueListFilters = {
  status?: string | string[];
  dlq?: boolean;
  limit?: number;
};

export type SupaCloudQueueMessage = SupaCloudTaskDetail & {
  payload: Record<string, unknown>;
};

export type SupaCloudQueueStats = {
  pending: number;
  leased: number;
  running: number;
  retryScheduled: number;
  succeededLast24h: number;
  failedLast24h: number;
  deadLettered: number;
  oldestPendingAgeSec: number | null;
  inFlight: number;
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

const TERMINAL_STATUSES = new Set<string>([
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
  "completed",
]);

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
  if (filters.dlq) params.set("dlq", "true");
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));

  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
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
  const value = (task ?? {}) as Record<string, unknown>;
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

  protected async request<T>(path: string, method: HttpMethod, body?: unknown): Promise<T> {
    const accessToken = await this.resolveAccessToken();
    const response = await fetch(`${this.options.managementApiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) return undefined as T;

    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      const message =
        responseBody && typeof responseBody === "object" && typeof (responseBody as Record<string, unknown>).message === "string"
          ? String((responseBody as Record<string, unknown>).message)
          : `SupaCloud request failed (${response.status})`;
      throw new SupaCloudApiError(message, response.status, responseBody);
    }

    return responseBody as T;
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
    const { data, error } = await this.options.supabase.functions.invoke(functionName, {
      body,
      method,
      headers: invokeHeaders,
    });

    if (error) throw error;

    const payload = (data ?? {}) as Record<string, unknown>;
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
    );
  }

  async list(filters: SupaCloudTaskListFilters = {}): Promise<SupaCloudTaskDetail[]> {
    return this.request<SupaCloudTaskDetail[]>(
      `/v1/projects/${this.options.projectRef}/tasks${createQueryString(filters)}`,
      "GET",
    );
  }

  async cancel(taskId: string): Promise<SupaCloudTaskDetail> {
    return this.request<SupaCloudTaskDetail>(
      `/v1/projects/${this.options.projectRef}/tasks/${taskId}/cancel`,
      "POST",
    );
  }

  async retry(taskId: string): Promise<SupaCloudTaskDetail> {
    return this.request<SupaCloudTaskDetail>(
      `/v1/projects/${this.options.projectRef}/tasks/${taskId}/retry`,
      "POST",
    );
  }

  async listDlq(limit = 100): Promise<SupaCloudTaskDetail[]> {
    return this.request<SupaCloudTaskDetail[]>(
      `/v1/projects/${this.options.projectRef}/tasks/dlq?limit=${limit}`,
      "GET",
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

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);

        if (options.signal) {
          const onAbort = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };

          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  subscribe(taskId: string, options: SupaCloudTaskSubscribeOptions) {
    let closed = false;
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

  async send(
    payload: Record<string, unknown> = {},
    options: SupaCloudQueueSendOptions = {},
  ): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages`,
      "POST",
      {
        payload,
        delayMs: options.delayMs,
        maxAttempts: options.maxAttempts,
        idempotencyKey: options.idempotencyKey,
        traceId: options.traceId,
        correlationId: options.correlationId,
        businessTaskId: options.businessTaskId,
        metadata: options.metadata,
      },
    );
  }

  async receive(
    options: SupaCloudQueueReceiveOptions = {},
  ): Promise<SupaCloudQueueMessage | null> {
    const message = await this.request<SupaCloudQueueMessage | undefined>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/receive`,
      "POST",
      options,
    );
    return message ?? null;
  }

  async list(filters: SupaCloudQueueListFilters = {}): Promise<SupaCloudQueueMessage[]> {
    return this.request<SupaCloudQueueMessage[]>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages${createQueueQueryString(filters)}`,
      "GET",
    );
  }

  async listFailed(limit = 100): Promise<SupaCloudQueueMessage[]> {
    return this.list({ dlq: true, limit });
  }

  async stats(): Promise<SupaCloudQueueStats> {
    return this.request<SupaCloudQueueStats>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/stats`,
      "GET",
    );
  }

  async getSettings(): Promise<SupaCloudQueueSettings> {
    return this.request<SupaCloudQueueSettings>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/settings`,
      "GET",
    );
  }

  async updateSettings(settings: SupaCloudQueueSettingsUpdate): Promise<SupaCloudQueueSettings> {
    return this.request<SupaCloudQueueSettings>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/settings`,
      "PATCH",
      settings,
    );
  }

  async get(messageId: string): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}`,
      "GET",
    );
  }

  async ack(
    messageId: string,
    result?: Record<string, unknown>,
  ): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/ack`,
      "POST",
      result ? { result } : {},
    );
  }

  async delete(messageId: string): Promise<void> {
    await this.request<void>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}`,
      "DELETE",
    );
  }

  async release(
    messageId: string,
    options: SupaCloudQueueReleaseOptions = {},
  ): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/release`,
      "POST",
      options,
    );
  }

  async fail(
    messageId: string,
    options: SupaCloudQueueFailOptions = {},
  ): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/fail`,
      "POST",
      options,
    );
  }

  async retry(messageId: string): Promise<SupaCloudQueueMessage> {
    return this.request<SupaCloudQueueMessage>(
      `/v1/projects/${this.options.projectRef}/tasks/queues/${this.encodedName}/messages/${messageId}/retry`,
      "POST",
    );
  }
}

class SupaCloudOAuthServerClient<TClient extends SupabaseClient = SupabaseClient> extends SupaCloudManagementClient<TClient> {
  async getStatus(): Promise<SupaCloudOAuthServerStatus> {
    return this.request<SupaCloudOAuthServerStatus>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-server`,
      "GET",
    );
  }

  async migrateToOidc(options: { allowDynamicRegistration?: boolean } = {}): Promise<SupaCloudOAuthServerStatus> {
    return this.request<SupaCloudOAuthServerStatus>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-server/migrate`,
      "POST",
      { allow_dynamic_registration: options.allowDynamicRegistration === true },
    );
  }

  async getDiscovery(): Promise<Record<string, unknown>> {
    const status = await this.getStatus();
    const response = await fetch(status.discovery_url);
    if (!response.ok) throw new Error(`SupaCloud OIDC discovery failed (${response.status})`);
    return await response.json() as Record<string, unknown>;
  }

  async getJwks(): Promise<Record<string, unknown>> {
    const status = await this.getStatus();
    const response = await fetch(status.jwks_url);
    if (!response.ok) throw new Error(`SupaCloud JWKS fetch failed (${response.status})`);
    return await response.json() as Record<string, unknown>;
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
    );
  }

  async create(input: SupaCloudOAuthClientCreate): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients`,
      "POST",
      input,
    );
  }

  async get(clientId: string): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "GET",
    );
  }

  async update(clientId: string, patch: SupaCloudOAuthClientUpdate): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "PUT",
      patch,
    );
  }

  async delete(clientId: string): Promise<void> {
    await this.request<void>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`,
      "DELETE",
    );
  }

  async regenerateSecret(clientId: string): Promise<SupaCloudOAuthClient> {
    return this.request<SupaCloudOAuthClient>(
      `/v1/projects/${this.options.projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}/regenerate-secret`,
      "POST",
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

  return {
    supabase: options.supabase,
    projectRef: normalized.projectRef,
    managementApiUrl: normalized.managementApiUrl,
    auth: {
      oauthServer,
      oauthClients,
    },
    tasks,
    queue: (name: string) => new SupaCloudQueueClient(normalized, name),
    functions: {
      invokeBackground: (
        functionName: string,
        submitOptions?: SupaCloudTaskSubmitOptions,
      ) => tasks.submit(functionName, submitOptions),
    },
  };
}
