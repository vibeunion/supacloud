import { Type } from "typebox";
import { projectTaskRowSchema } from "../db/contracts/task-row";
import { dateSchema } from "../utils/date-schema";

const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const nonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const taskStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("leased"), Type.Literal("running"),
  Type.Literal("retry_scheduled"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("dead_lettered"), Type.Literal("cancelled"),
]);

export const taskErrorSchema = Type.Object({
  message: text,
  code: text,
}, { additionalProperties: true });

const taskAttemptSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  task_id: Type.String({ minLength: 1 }),
  project_ref: Type.String({ minLength: 1 }),
  attempt_no: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  status: taskStatus,
  started_at: dateSchema,
  completed_at: Type.Union([dateSchema, Type.Null()]),
  duration_ms: Type.Union([nonNegativeInteger, Type.Null()]),
  error: nullableText,
  response_status: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  logs: Type.Union([Type.Array(Type.Object({
    timestamp: text,
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
    level: text,
    message: text,
  })), Type.Null()]),
  created_at: dateSchema,
  updated_at: dateSchema,
});

export const taskDetailSchema = Type.Intersect([
  projectTaskRowSchema,
  Type.Object({
    attempts: Type.Array(taskAttemptSchema),
    latest_logs: Type.Array(Type.Object({
      timestamp: text,
      stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
      level: text,
      message: text,
    })),
  }),
]);

export const taskStatsSchema = Type.Object({
  running: nonNegativeInteger,
  retryScheduled: nonNegativeInteger,
  deadLettered: nonNegativeInteger,
  failedLast24h: nonNegativeInteger,
  cancelledLast24h: nonNegativeInteger,
  topFailures: Type.Array(Type.Object({ message: text, count: nonNegativeInteger })),
  failedTrend: Type.Array(Type.Object({ bucket: text, failures: nonNegativeInteger })),
});

const taskParamsSchema = Type.Object({ ref: Type.String({ minLength: 1, maxLength: 128 }) });
const taskDetailParamsSchema = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: 128 }),
  taskId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** Canonical TypeBox contracts for the task read API. Keep route schemas here so
 * Elysia, OpenAPI and generated clients share one source of truth. */
export const taskApi = {
  params: taskParamsSchema,
  detailParams: taskDetailParamsSchema,
  listResponse: Type.Union([Type.Array(projectTaskRowSchema), taskErrorSchema]),
  statsResponse: Type.Union([taskStatsSchema, taskErrorSchema]),
  detailResponse: Type.Union([taskDetailSchema, taskErrorSchema]),
} as const;

export type TaskDetail = import("typebox").Static<typeof taskDetailSchema>;
export type TaskStats = import("typebox").Static<typeof taskStatsSchema>;
