import type { TSchema, Static } from "typebox";
import { Value } from "typebox/value";
import { isRecord } from "../utils/project-config";
import {
  parseTaskRecord,
  parseTaskAttemptRecord,
  taskSchema,
  attemptSchema,
  InvalidTaskRecordError,
} from "../utils/task-record";

export class DatabaseRecordDecodeError extends Error {
  constructor(message = "Database record failed schema validation") {
    super(message);
    this.name = "DatabaseRecordDecodeError";
  }
}

/**
 * Decode and strictly validate a single database row against its authoritative schema.
 * Reuses domain record decoders for core entities (taskSchema, attemptSchema).
 */
export function decodeRow<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (value == null) throw new DatabaseRecordDecodeError("Row is null or undefined");
  if ((schema as unknown) === taskSchema) {
    return parseTaskRecord(value) as Static<T>;
  }
  if ((schema as unknown) === attemptSchema) {
    return parseTaskAttemptRecord(value) as Static<T>;
  }
  if (!isRecord(value) || !Value.Check(schema, value)) {
    throw new DatabaseRecordDecodeError();
  }
  return value as Static<T>;
}

/**
 * Decode and strictly validate an array of database rows against their authoritative schema.
 */
export function decodeRows<T extends TSchema>(schema: T, values: unknown): Static<T>[] {
  if (!Array.isArray(values)) throw new DatabaseRecordDecodeError("Expected an array of rows");
  return values.map((row) => decodeRow(schema, row));
}
