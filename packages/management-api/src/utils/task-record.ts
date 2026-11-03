import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ProjectTaskAttempt } from "../db";
import { InvalidTaskRecordError, decodeTaskJson } from "../db/contracts/task-row";
import { isRecord } from "./project-config";
import { dateSchema } from "./date-schema";

export {
  InvalidTaskRecordError, copyTaskJson, decodeProjectTask, parseTaskJsonObject,
  decodeProjectTask as parseTaskRecord,
  type ProjectTask,
} from "../db/contracts/task-row";

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
  started_at: dateSchema, completed_at: nullableDate,
  duration_ms: Type.Union([counter, Type.Null()]), error: nullableText,
  response_status: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  logs: Type.Union([attemptLogsSchema, Type.Null()]),
  created_at: dateSchema, updated_at: dateSchema,
});

export function parseTaskAttemptRecord(value: unknown): ProjectTaskAttempt {
  if (!isRecord(value)) throw new InvalidTaskRecordError();
  const record = { ...value, logs: decodeTaskJson(value["logs"]) };
  if (!Value.Check(attemptSchema, record)) throw new InvalidTaskRecordError();
  if (record.logs?.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) throw new InvalidTaskRecordError();
  return structuredClone(record);
}

export function parseTaskAttemptLogs(value: unknown) {
  const logs = decodeTaskJson(value);
  if (!Value.Check(attemptLogsSchema, logs)
    || logs.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) throw new InvalidTaskRecordError();
  return logs;
}
