import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { dateSchema } from "../../utils/date-schema";
import { isRecord } from "../../utils/project-config";

export const TaskStatus = {
  PENDING: "pending",
  LEASED: "leased",
  RUNNING: "running",
  RETRY_SCHEDULED: "retry_scheduled",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DEAD_LETTERED: "dead_lettered",
  CANCELLED: "cancelled",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableDate = Type.Union([dateSchema, Type.Null()]);
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const taskStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("leased"), Type.Literal("running"),
  Type.Literal("retry_scheduled"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("dead_lettered"), Type.Literal("cancelled"),
]);

/**
 * Canonical control-plane row contract for `project_tasks`.
 *
 * Keep the SQL column list, TypeBox schema and decoded domain type together so
 * a column change has one contract to update. The decoder remains the runtime
 * authority for legacy JSON text, dates and domain constraints.
 */
export const projectTaskRowSchema = Type.Object({
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
  created_at: dateSchema, updated_at: dateSchema,
});
export type ProjectTask = Static<typeof projectTaskRowSchema>;

const TASK_COLUMN_NAMES = [
  "id", "project_ref", "task_type", "status", "payload", "result", "error", "retries", "attempt",
  "max_attempts", "next_run_at", "lease_until", "started_at", "completed_at", "timeout_sec",
  "idempotency_key", "trace_id", "cancel_requested_at", "cancellation_reason", "correlation_id",
  "business_task_id", "invoker_user_id", "auth_authority_ref", "metadata", "function_slug",
  "function_version", "created_at", "updated_at",
] as const;
const ATTEMPT_COLUMN_NAMES = [
  "id", "task_id", "project_ref", "attempt_no", "status", "started_at", "completed_at", "duration_ms",
  "error", "response_status", "logs", "created_at", "updated_at",
] as const;

function columns(names: readonly string[], alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return names.map((name) => `${prefix}${name}`).join(", ");
}

/** Explicit task columns for SQL that must stay aligned with the row contract. */
export function projectTaskColumns(alias = ""): string {
  return columns(TASK_COLUMN_NAMES, alias);
}
export const PROJECT_TASK_COLUMNS = projectTaskColumns();
export const PROJECT_TASK_ATTEMPT_COLUMNS = columns(ATTEMPT_COLUMN_NAMES);

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
    if (typeof input !== "object" || ancestors.has(input)) throw new InvalidTaskRecordError();
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

export function decodeTaskJson(value: unknown): unknown {
  if (typeof value !== "string") return copyTaskJson(value);
  if (Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024) throw new InvalidTaskRecordError();
  try {
    const decoded: unknown = JSON.parse(value);
    return copyTaskJson(decoded);
  } catch { throw new InvalidTaskRecordError(); }
}

export function parseTaskJsonObject(value: unknown): Record<string, unknown> {
  const decoded = decodeTaskJson(value);
  if (!isRecord(decoded)) throw new InvalidTaskRecordError();
  return decoded;
}

/** Decode one persisted task row. This is the only control-plane task row contract. */
export function decodeProjectTask(value: unknown): ProjectTask {
  if (!isRecord(value)) throw new InvalidTaskRecordError();
  const record = {
    ...value,
    payload: parseTaskJsonObject(value["payload"]),
    result: value["result"] === null ? null : parseTaskJsonObject(value["result"]),
    metadata: value["metadata"] === null ? null : parseTaskJsonObject(value["metadata"]),
  };
  if (!Value.Check(projectTaskRowSchema, record)) throw new InvalidTaskRecordError();
  return structuredClone(record) as ProjectTask;
}

/** @deprecated Use decodeProjectTask; retained for consumers outside this package. */
export const parseTaskRecord = decodeProjectTask;
