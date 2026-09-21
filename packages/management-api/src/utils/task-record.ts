import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ProjectTask, ProjectTaskAttempt } from "../db";
import { isRecord } from "./project-config";

const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableDate = Type.Union([Type.Date(), Type.Null()]);
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const taskStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("leased"), Type.Literal("running"),
  Type.Literal("retry_scheduled"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("dead_lettered"), Type.Literal("cancelled"),
]);
const taskSchema = Type.Object({
  id: Type.String({ minLength: 1 }), project_ref: Type.String({ minLength: 1 }),
  task_type: Type.String({ minLength: 1 }),
  status: taskStatus,
  payload: jsonObject, result: Type.Union([jsonObject, Type.Null()]),
  error: nullableText, retries: counter, attempt: counter,
  max_attempts: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  next_run_at: nullableDate, lease_until: nullableDate, started_at: nullableDate, completed_at: nullableDate,
  timeout_sec: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  idempotency_key: nullableText, trace_id: nullableText,
  cancel_requested_at: nullableDate, cancellation_reason: nullableText,
  correlation_id: nullableText, business_task_id: nullableText, invoker_user_id: nullableText,
  auth_authority_ref: Type.String({ minLength: 1 }),
  metadata: Type.Union([jsonObject, Type.Null()]),
  function_slug: nullableText, function_version: nullableText,
  created_at: Type.Date(), updated_at: Type.Date(),
});
const attemptLogsSchema = Type.Array(Type.Object({
  timestamp: Type.String({ minLength: 1 }),
  stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
  level: text, message: text,
}));
const attemptSchema = Type.Object({
  id: Type.String({ minLength: 1 }), task_id: Type.String({ minLength: 1 }),
  project_ref: Type.String({ minLength: 1 }),
  attempt_no: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  status: taskStatus,
  started_at: Type.Date(), completed_at: nullableDate,
  duration_ms: Type.Union([counter, Type.Null()]), error: nullableText,
  response_status: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  logs: Type.Union([attemptLogsSchema, Type.Null()]),
  created_at: Type.Date(), updated_at: Type.Date(),
});

export class InvalidTaskRecordError extends Error {
  constructor() {
    super("Invalid persisted task record");
    this.name = "InvalidTaskRecordError";
  }
}

// Legacy JSONB writers stored JSON text. Decode one layer, but never replace
// damaged data with empty values that look like a valid task or receipt.
export function copyTaskJson(value: unknown): unknown {
  let budget = 100_000;
  const ancestors = new Set<object>();
  function copy(input: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 32) throw new InvalidTaskRecordError();
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null || ancestors.has(input)) throw new InvalidTaskRecordError();
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new InvalidTaskRecordError();
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > budget) throw new InvalidTaskRecordError();
        const output: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const entry = Object.getOwnPropertyDescriptor(input, index);
          if (!entry || !("value" in entry)) throw new InvalidTaskRecordError();
          output.push(copy(entry.value, depth + 1));
        }
        return output;
      }
      const entries: Array<[string, unknown]> = [];
      for (const key of Object.keys(input)) {
        const entry = Object.getOwnPropertyDescriptor(input, key);
        if (!entry || !("value" in entry)) throw new InvalidTaskRecordError();
        entries.push([key, copy(entry.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    } finally { ancestors.delete(input); }
  }
  return copy(value, 0);
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return copyTaskJson(value);
  if (Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024) throw new InvalidTaskRecordError();
  try {
    const decoded: unknown = JSON.parse(value);
    return copyTaskJson(decoded);
  } catch { throw new InvalidTaskRecordError(); }
}

export function parseTaskJsonObject(value: unknown): Record<string, unknown> {
  const decoded = decodeJson(value);
  if (!isRecord(decoded)) throw new InvalidTaskRecordError();
  return decoded;
}

export function parseTaskRecord(value: unknown): ProjectTask {
  if (!isRecord(value)) throw new InvalidTaskRecordError();
  const record = {
    ...value,
    payload: parseTaskJsonObject(value.payload),
    result: value.result === null ? null : parseTaskJsonObject(value.result),
    metadata: value.metadata === null ? null : parseTaskJsonObject(value.metadata),
  };
  if (!Value.Check(taskSchema, record)) throw new InvalidTaskRecordError();
  return structuredClone(record);
}

export function parseTaskAttemptRecord(value: unknown): ProjectTaskAttempt {
  if (!isRecord(value)) throw new InvalidTaskRecordError();
  const record = { ...value, logs: decodeJson(value.logs) };
  if (!Value.Check(attemptSchema, record)) throw new InvalidTaskRecordError();
  if (record.logs?.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) throw new InvalidTaskRecordError();
  return structuredClone(record);
}

export function parseTaskAttemptLogs(value: unknown) {
  const logs = decodeJson(value);
  if (!Value.Check(attemptLogsSchema, logs)
    || logs.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) throw new InvalidTaskRecordError();
  return logs;
}
