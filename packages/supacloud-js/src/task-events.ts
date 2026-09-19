/** Opt-in SupaCloud task output extension. Does not wrap or modify supabase-js. */
export interface TaskOutputEvent {
  schema_version: 1;
  project_ref: string;
  task_id: string;
  event_id: string;
  sequence: string;
  attempt: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface TaskOutputPage {
  schema_version: 1;
  project_ref: string;
  task_id: string;
  enabled: boolean;
  task_status: string;
  attempt: number;
  events: TaskOutputEvent[];
  next_cursor: string;
  last_sequence: string;
  retained_after: string;
  has_more: boolean;
  replay_available: true;
}
export interface TaskOutputAppend {
  attempt: number;
  /** Generate once per logical output event; reuse when confirming an uncertain write. */
  event_id: string;
  type: "output.delta" | "output.snapshot" | "progress" | "warning";
  payload: Record<string, unknown>;
}
export interface TaskEventClientOptions {
  baseUrl: string;
  projectRef: string;
  /** Read the current JWT on each request; never put credentials in the URL. */
  getHeaders: () => HeadersInit | Promise<HeadersInit>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}
export interface TaskEventListOptions { after?: string; limit?: number; signal?: AbortSignal }
export interface TaskEventWatchOptions extends TaskEventListOptions {
  pollIntervalMs?: number;
  maxRetries?: number;
  /** Called AFTER the consumer resumes the generator, not when a message arrives. */
  onCursor?: (cursor: string) => void | Promise<void>;
  /** Optional native Realtime notification hook. Messages only request a fresh HTTP read. */
  subscribe?: (wake: () => void) => (() => void | Promise<void>);
}
export class TaskEventError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "TaskEventError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR = 9223372036854775807n;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STATES = new Set(["pending", "leased", "running", "retry_scheduled", "succeeded", "failed", "dead_lettered", "cancelled"]);
const TERMINAL = new Set(["succeeded", "failed", "dead_lettered", "cancelled"]);
const OUTPUTS = new Set(["output.delta", "output.snapshot", "progress", "warning"]);
function invalid(): never { throw new TaskEventError(0, "TASK_OUTPUT_INVALID_RESPONSE"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cursor(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > MAX_CURSOR) {
    throw new TaskEventError(400, "TASK_OUTPUT_INVALID_CURSOR");
  }
  return value;
}
function taskId(value: string): string {
  if (!UUID.test(value)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_TASK");
  return value.toLowerCase();
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function event(value: unknown, ref: string, id: string): TaskOutputEvent {
  if (!record(value) || value.schema_version !== 1 || value.project_ref !== ref || value.task_id !== id
    || typeof value.event_id !== "string" || !UUID.test(value.event_id)
    || !integer(value.attempt, 0, 2147483647) || typeof value.type !== "string"
    || !(OUTPUTS.has(value.type) || (value.type.startsWith("task.") && STATES.has(value.type.slice(5))))
    || !record(value.payload) || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) invalid();
  const sequence = cursor(value.sequence);
  if (sequence === "0" || (OUTPUTS.has(value.type) && value.attempt < 1)) invalid();
  return { schema_version: 1, project_ref: ref, task_id: id, event_id: value.event_id,
    sequence, attempt: value.attempt, type: value.type, payload: value.payload, created_at: value.created_at };
}
function page(value: unknown, ref: string, id: string, after: string, limit: number): TaskOutputPage {
  if (!record(value) || value.schema_version !== 1 || value.project_ref !== ref || value.task_id !== id
    || typeof value.enabled !== "boolean" || typeof value.task_status !== "string" || !STATES.has(value.task_status)
    || !integer(value.attempt, 0, 2147483647) || !Array.isArray(value.events) || value.events.length > limit
    || typeof value.has_more !== "boolean" || value.replay_available !== true) invalid();
  const next = cursor(value.next_cursor), last = cursor(value.last_sequence), retained = cursor(value.retained_after);
  if (BigInt(retained) > BigInt(after) || BigInt(after) > BigInt(last)) invalid();
  let position = BigInt(after);
  const events = value.events.map((raw) => {
    const item = event(raw, ref, id);
    if (BigInt(item.sequence) !== position + 1n) invalid();
    position = BigInt(item.sequence);
    return item;
  });
  if (next !== position.toString() || position > BigInt(last) || value.has_more !== (position < BigInt(last))
    || (value.has_more && events.length !== limit) || (!value.enabled && last !== "0")) invalid();
  return { schema_version: 1, project_ref: ref, task_id: id, enabled: value.enabled, task_status: value.task_status,
    attempt: value.attempt, events, next_cursor: next, last_sequence: last, retained_after: retained,
    has_more: value.has_more, replay_available: true };
}
function abortError(signal: AbortSignal): unknown { return signal.reason ?? new DOMException("Aborted", "AbortError"); }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
async function jsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES || chunks.length >= 32768) throw new TaskEventError(0, "TASK_OUTPUT_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createTaskEventClient(options: TaskEventClientOptions) {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^[a-zA-Z0-9_-]{1,20}$/.test(options.projectRef)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_CLIENT");
  const ref = options.projectRef;
  const basePath = base.pathname.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(id: string, query: string, input: TaskOutputAppend | undefined, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const stop = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => controller.abort(new TaskEventError(408, "TASK_OUTPUT_REQUEST_TIMEOUT")), 30_000);
    try {
      const headers = new Headers(await abortable(Promise.resolve().then(options.getHeaders), controller.signal));
      headers.set("accept", "application/json");
      if (input) headers.set("content-type", "application/json");
      const url = new URL(`${basePath}/v1/projects/${encodeURIComponent(ref)}/tasks/${id}/events${query}`, base.origin);
      const response = await abortable(fetchImpl(url, { method: input ? "POST" : "GET", headers,
        body: input ? JSON.stringify(input) : undefined, signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" }), controller.signal);
      const data = await jsonBody(response, controller.signal);
      if (!response.ok) throw new TaskEventError(response.status,
        record(data) && typeof data.code === "string" ? data.code : "TASK_OUTPUT_HTTP_ERROR", record(data) ? data : {});
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (error instanceof TaskEventError) throw error;
      throw new TaskEventError(0, "TASK_OUTPUT_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    }
  }

  async function list(id: string, settings: TaskEventListOptions = {}): Promise<TaskOutputPage> {
    id = taskId(id);
    const after = cursor(settings.after ?? "0"), limit = settings.limit ?? 50;
    if (!integer(limit, 1, 100)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_LIMIT");
    const query = `?${new URLSearchParams({ after, limit: String(limit) })}`;
    return page(await request(id, query, undefined, settings.signal), ref, id, after, limit);
  }

  /** Trusted server/executor only. Never automatically retry a write. */
  async function append(id: string, input: TaskOutputAppend, settings: { signal?: AbortSignal } = {}): Promise<TaskOutputEvent> {
    id = taskId(id);
    if (!record(input) || !integer(input.attempt, 1, 2147483647) || !UUID.test(input.event_id)
      || !OUTPUTS.has(input.type) || !record(input.payload)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_INPUT");
    let encoded: string;
    try { encoded = JSON.stringify({ attempt: input.attempt, event_id: input.event_id, type: input.type, payload: input.payload }); } catch { throw new TaskEventError(400, "TASK_OUTPUT_INVALID_INPUT"); }
    if (new TextEncoder().encode(encoded).byteLength > 20 * 1024) throw new TaskEventError(413, "TASK_OUTPUT_LIMIT");
    const snapshot = JSON.parse(encoded) as TaskOutputAppend;
    if (!record(snapshot.payload)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_INPUT");
    const output = event(await request(id, "", snapshot, settings.signal), ref, id);
    if (output.attempt !== snapshot.attempt || output.event_id !== snapshot.event_id.toLowerCase() || output.type !== snapshot.type) invalid();
    return output;
  }

  async function* watch(id: string, settings: TaskEventWatchOptions = {}): AsyncGenerator<TaskOutputEvent, void, void> {
    id = taskId(id);
    let after = cursor(settings.after ?? "0");
    const interval = settings.pollIntervalMs ?? 1000, maxRetries = settings.maxRetries ?? 5;
    if (!integer(interval, 10, 60_000) || !integer(maxRetries, 0, 20)) throw new TaskEventError(400, "TASK_OUTPUT_INVALID_INPUT");
    settings.signal?.throwIfAborted();
    let pending = false;
    let wakeWaiter: (() => void) | undefined;
    let unsubscribe: (() => void | Promise<void>) | undefined;
    let retries = 0;
    const wake = () => { pending = true; wakeWaiter?.(); };
    async function wait(ms: number, notifications: boolean): Promise<void> {
      settings.signal?.throwIfAborted();
      if (notifications && pending) { pending = false; return; }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { cleanup(); resolve(); };
        const stop = () => { cleanup(); reject(abortError(settings.signal!)); };
        const timeout = setTimeout(finish, ms);
        const cleanup = () => { clearTimeout(timeout); wakeWaiter = undefined; settings.signal?.removeEventListener("abort", stop); };
        if (notifications) wakeWaiter = finish;
        settings.signal?.addEventListener("abort", stop, { once: true });
      });
      if (notifications) pending = false;
    }
    try {
      unsubscribe = settings.subscribe?.(wake);
      for (;;) {
        settings.signal?.throwIfAborted();
        let current: TaskOutputPage;
        try { current = await list(id, { after, limit: settings.limit, signal: settings.signal }); retries = 0; }
        catch (error) {
          settings.signal?.throwIfAborted();
          const retryable = error instanceof TaskEventError &&
            ([408, 429, 502, 503, 504].includes(error.status) || error.code === "TASK_OUTPUT_NETWORK_ERROR");
          if (!retryable || retries++ >= maxRetries) throw error;
          await wait(Math.min(30_000, interval * 2 ** retries), false);
          continue;
        }
        for (const item of current.events) {
          settings.signal?.throwIfAborted();
          yield item;
          // Consumers finish handling a yielded event before requesting the next.
          // A thrown handler or generator.return() leaves this cursor unadvanced.
          await settings.onCursor?.(item.sequence);
          after = item.sequence;
        }
        if (current.has_more) continue;
        if (TERMINAL.has(current.task_status)) return;
        // Poll even when Realtime is connected: the last notification may be lost.
        await wait(interval, true);
      }
    } finally { await unsubscribe?.(); }
  }
  return { list, append, watch };
}
