import { sql } from "../db";
import { TaskOutputError, type AppendTaskOutput } from "../utils/task-output";

const errors: Record<string, { status: number; message: string }> = {
  TASK_OUTPUT_NOT_FOUND: { status: 404, message: "Task output not found" },
  TASK_OUTPUT_INVALID_INPUT: { status: 400, message: "Invalid task output input" },
  TASK_OUTPUT_CURSOR_AHEAD: { status: 400, message: "Cursor is ahead of the committed task history" },
  TASK_OUTPUT_IDEMPOTENCY_CONFLICT: { status: 409, message: "Event ID already identifies different output" },
  TASK_OUTPUT_STALE_ATTEMPT: { status: 409, message: "The execution attempt is no longer writable" },
  TASK_OUTPUT_LIMIT: { status: 413, message: "Task output exceeds its event or lifetime limit" },
  TASK_OUTPUT_PROJECT_RATE_LIMIT: { status: 429, message: "Project output rate limit exceeded" },
  TASK_OUTPUT_PROJECT_STORAGE_LIMIT: { status: 413, message: "Project retained output limit exceeded" },
};

function result(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task output database response");
  const record = value as Record<string, unknown>;
  if (record._error !== undefined) {
    const entry = typeof record.code === "string" ? errors[record.code] : undefined;
    if (!entry || record._error !== entry.status) throw new Error("Unknown task output database error");
    throw new TaskOutputError(entry.status, String(record.code), entry.message);
  }
  return record;
}

/** No request-path DDL. Bound lock waits; never retry an uncertain write here. */
export const taskOutputService = {
  async read(projectRef: string, taskId: string, after: string, limit: number, invokerUserId: string | null) {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const [row] = await tx`
        SELECT public.supacloud_read_task_output(
          ${projectRef}::text, ${taskId}::uuid, ${after}::bigint, ${limit}::integer, ${invokerUserId}::uuid
        ) AS output
      `;
      return result(row?.output);
    });
  },
  async append(projectRef: string, taskId: string, input: AppendTaskOutput) {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const [row] = await tx`
        SELECT public.supacloud_append_task_output_governed(
          ${projectRef}::text, ${taskId}::uuid, ${input.attempt}::integer,
          ${input.event_id}::uuid, ${input.type}::text, ${JSON.stringify(input.payload)}::text::jsonb
        ) AS output
      `;
      return result(row?.output);
    });
  },
};
