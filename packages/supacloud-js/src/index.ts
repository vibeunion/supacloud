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

export class SupaCloudTaskSubmitError extends Error {
  readonly responseBody: unknown;

  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "SupaCloudTaskSubmitError";
    this.responseBody = responseBody;
  }
}

type HttpMethod = "GET" | "POST";

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

class SupaCloudTasksClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(private readonly options: Required<SupaCloudClientOptions<TClient>>) {}

  private async resolveAccessToken(): Promise<string> {
    const token = await this.options.getAccessToken();
    if (!token) {
      throw new Error(
        "No SupaCloud management API access token available. Pass getAccessToken() or ensure supabase.auth has an active session.",
      );
    }
    return token;
  }

  private async request<T>(path: string, method: HttpMethod, body?: unknown): Promise<T> {
    const accessToken = await this.resolveAccessToken();
    const response = await fetch(`${this.options.managementApiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(`SupaCloud request failed (${response.status})`);
    }

    return (await response.json()) as T;
  }

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
    const { body, headers = {}, retries: _retries, timeoutSec: _timeoutSec, idempotencyKey: _idempotencyKey, method } = options;
    // Background execution is selected by server-side background_routes.
    // The SDK intentionally avoids injecting custom async headers here.
    const { data, error } = await this.options.supabase.functions.invoke(functionName, {
      body,
      method,
      headers,
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

  return {
    supabase: options.supabase,
    projectRef: normalized.projectRef,
    managementApiUrl: normalized.managementApiUrl,
    tasks,
    functions: {
      invokeBackground: (
        functionName: string,
        submitOptions?: SupaCloudTaskSubmitOptions,
      ) => tasks.submit(functionName, submitOptions),
    },
  };
}
