import { InvalidJsonResponse, requestValidatedJson } from "./validated-json";

export const taskStatuses = [
  "pending", "leased", "running", "retry_scheduled", "succeeded", "failed", "dead_lettered", "cancelled",
] as const;
export type TaskStatus = typeof taskStatuses[number];

export interface TaskLog {
  timestamp: string;
  stream: "stdout" | "stderr";
  level: string;
  message: string;
}
export interface AttemptRecord {
  id: string;
  task_id: string;
  project_ref: string;
  attempt_no: number;
  status: TaskStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
  response_status: number | null;
  logs: TaskLog[] | null;
}
export interface TaskRecord {
  id: string;
  project_ref: string;
  task_type: string;
  status: TaskStatus;
  error: string | null;
  function_slug: string | null;
  function_version: string | null;
  attempt: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  cancel_requested_at: string | null;
  cancellation_reason: string | null;
  lease_until: string | null;
  next_run_at: string | null;
  completed_at: string | null;
}
export interface TaskDetail extends TaskRecord {
  attempts: AttemptRecord[];
  latest_logs: TaskLog[];
}

export const backgroundSettingLimits = {
  concurrency: { min: 1, max: 30 },
  max_attempts: { min: 1, max: 10 },
  max_payload_bytes: { min: 1024, max: 1048576 },
  timeout_sec_default: { min: 1, max: 900 },
  timeout_sec_max: { min: 1, max: 1800 },
} as const;
export type BackgroundSettings = { [K in keyof typeof backgroundSettingLimits]: number };
export type BackgroundDraft = { [K in keyof BackgroundSettings]: number | undefined };

export class InvalidTaskCenterResponse extends Error {
  constructor() { super("Invalid task center response"); }
}
function invalid(): never { throw new InvalidTaskCenterResponse(); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function nonempty(value: unknown): string { return typeof value === "string" && value.trim() ? value : invalid(); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid();
  return value;
}
function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function status(value: unknown): TaskStatus {
  for (const candidate of taskStatuses) if (candidate === value) return candidate;
  return invalid();
}
export function validTaskProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function uuid(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value : invalid();
}
function array<T>(value: unknown, decode: (item: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(decode);
}
function logs(value: unknown): TaskLog[] {
  return array(value, (entry) => {
    const log = record(entry);
    if ((log.stream !== "stdout" && log.stream !== "stderr")
      || typeof log.timestamp !== "string" || !Number.isFinite(Date.parse(log.timestamp))) return invalid();
    return { timestamp: log.timestamp, stream: log.stream, level: text(log.level), message: text(log.message) };
  }, 100_000);
}

export function parseTaskRecord(value: unknown, projectRef: string, taskId?: string): TaskRecord {
  const row = record(value);
  if (!validTaskProjectRef(projectRef) || row.project_ref !== projectRef || (taskId !== undefined && row.id !== taskId)) {
    return invalid();
  }
  return {
    id: uuid(row.id), project_ref: projectRef, task_type: nonempty(row.task_type), status: status(row.status),
    error: nullableText(row.error), function_slug: nullableText(row.function_slug),
    function_version: nullableText(row.function_version), attempt: integer(row.attempt),
    max_attempts: integer(row.max_attempts, 1), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    cancel_requested_at: nullableTimestamp(row.cancel_requested_at), cancellation_reason: nullableText(row.cancellation_reason),
    lease_until: nullableTimestamp(row.lease_until), next_run_at: nullableTimestamp(row.next_run_at),
    completed_at: nullableTimestamp(row.completed_at),
  };
}

export function parseTaskList(value: unknown, projectRef: string, deadLetters = false): TaskRecord[] {
  const seen = new Set<string>();
  return array(value, (entry) => {
    const task = parseTaskRecord(entry, projectRef);
    if (seen.has(task.id) || (deadLetters && task.status !== "dead_lettered")) return invalid();
    seen.add(task.id);
    return task;
  }, 500);
}

export function parseTaskDetail(value: unknown, projectRef: string, taskId: string): TaskDetail {
  const row = record(value);
  const task = parseTaskRecord(row, projectRef, taskId);
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const attempts = array(row.attempts, (entry): AttemptRecord => {
    const attempt = record(entry);
    const id = uuid(attempt.id);
    const attempt_no = integer(attempt.attempt_no, 1);
    if (attempt.task_id !== taskId || attempt.project_ref !== projectRef || ids.has(id) || numbers.has(attempt_no)) {
      return invalid();
    }
    ids.add(id);
    numbers.add(attempt_no);
    return {
      id, task_id: taskId, project_ref: projectRef, attempt_no, status: status(attempt.status),
      started_at: timestamp(attempt.started_at), completed_at: nullableTimestamp(attempt.completed_at),
      duration_ms: attempt.duration_ms === null ? null : integer(attempt.duration_ms),
      error: nullableText(attempt.error),
      response_status: attempt.response_status === null ? null : integer(attempt.response_status, 100, 599),
      logs: attempt.logs === null ? null : logs(attempt.logs),
    };
  }, 10_000);
  return { ...task, attempts, latest_logs: logs(row.latest_logs) };
}

export function parseBackgroundSettings(value: unknown): BackgroundSettings {
  const fields = record(value);
  const read = (key: keyof BackgroundSettings) =>
    integer(fields[key], backgroundSettingLimits[key].min, backgroundSettingLimits[key].max);
  const settings = {
    concurrency: read("concurrency"), max_attempts: read("max_attempts"),
    max_payload_bytes: read("max_payload_bytes"), timeout_sec_default: read("timeout_sec_default"),
    timeout_sec_max: read("timeout_sec_max"),
  };
  if (settings.timeout_sec_default > settings.timeout_sec_max) return invalid();
  return settings;
}
export function equalBackgroundSettings(left: BackgroundDraft, right: BackgroundDraft): boolean {
  return left.concurrency === right.concurrency && left.max_attempts === right.max_attempts
    && left.max_payload_bytes === right.max_payload_bytes && left.timeout_sec_default === right.timeout_sec_default
    && left.timeout_sec_max === right.timeout_sec_max;
}
export function parseBackgroundReceipt(value: unknown, submitted: BackgroundSettings): BackgroundSettings {
  const settings = parseBackgroundSettings(value);
  if (!equalBackgroundSettings(settings, submitted)) return invalid();
  return settings;
}
export function canRetryTask(task: TaskRecord): boolean {
  return task.status === "failed" || task.status === "dead_lettered" || task.status === "cancelled";
}
export function canCancelTask(task: TaskRecord): boolean {
  return task.cancel_requested_at === null
    && (task.status === "pending" || task.status === "leased" || task.status === "running" || task.status === "retry_scheduled");
}
export function parseTaskMutation(value: unknown, projectRef: string, taskId: string, action: "retry" | "cancel"): TaskRecord {
  const task = parseTaskRecord(value, projectRef, taskId);
  if (action === "retry") {
    if (task.status !== "pending" || task.error !== null || task.lease_until !== null || task.next_run_at === null
      || task.completed_at !== null || task.cancel_requested_at !== null || task.cancellation_reason !== null) return invalid();
  } else if (task.status !== "cancelled" && task.cancel_requested_at === null) return invalid();
  return task;
}

export function parseTaskNotification(value: unknown, projectRef: string): { taskId: string } | null {
  if (typeof value !== "string" || value.length > 32 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const event = record(parsed);
    if (event.type !== "task_update" || !validTaskProjectRef(projectRef) || event.projectRef !== projectRef) return null;
    status(event.status);
    timestamp(event.timestamp);
    nonempty(event.taskType);
    if (event.error !== undefined) nullableText(event.error);
    if (event.progress !== undefined) {
      if (typeof event.progress !== "number" || !Number.isFinite(event.progress)) return null;
    }
    return { taskId: uuid(event.taskId) };
  } catch { return null; }
}

export async function requestTaskCenter<T>(
  url: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  decode: (value: unknown) => T,
  options: RequestInit = {},
): Promise<T> {
  try {
    return await requestValidatedJson(url, request, decode, options);
  } catch (error) {
    if (error instanceof InvalidJsonResponse) throw new InvalidTaskCenterResponse();
    throw error;
  }
}
