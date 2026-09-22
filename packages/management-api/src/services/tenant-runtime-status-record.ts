import { parsePostgrestDesiredState } from "./tenant-runtime-desired-state";
import type { PostgrestRuntimeStatus } from "./tenant-runtime.service";

export class InvalidPostgrestRuntimeTargetError extends Error {
  constructor() {
    super("Invalid PostgREST runtime target");
    this.name = "InvalidPostgrestRuntimeTargetError";
  }
}

export function parsePostgrestRuntimeTarget(port: unknown, unit: unknown, projectRef: string): { port: number; unit: string } {
  if (typeof projectRef !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(projectRef)
    || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof unit !== "string" || unit !== `supacloud-pgrst@${projectRef}`) {
    throw new InvalidPostgrestRuntimeTargetError();
  }
  return { port, unit };
}

export class PostgrestObservationConflictError extends Error {
  constructor() {
    super("Project changed while observing PostgREST runtime");
    this.name = "PostgrestObservationConflictError";
  }
}

export class InvalidPostgrestObservationReceiptError extends Error {
  constructor() {
    super("Invalid persisted PostgREST observation receipt");
    this.name = "InvalidPostgrestObservationReceiptError";
  }
}

export type PostgrestObservationWriteReceipt = {
  updatedAt: string;
  lastReconciledAt: string | null;
};

export function parsePostgrestObservationReceipt(
  value: unknown,
  projectRef: string,
  expected: Pick<PostgrestRuntimeStatus, "desired" | "actual" | "health" | "port" | "last_error">,
): PostgrestObservationWriteReceipt {
  try {
    const stored = parsePostgrestStatusRecord(value, projectRef);
    if (!value || typeof value !== "object") throw new InvalidPostgrestObservationReceiptError();
    const observation = parsePostgrestObservation({
      actual: ownValue(value, "postgrest_actual"),
      health: ownValue(value, "postgrest_health"),
      last_error: ownValue(value, "postgrest_last_error"),
    });
    const port = ownValue(value, "postgrest_port");
    const updatedAt = timestamp(ownValue(value, "postgrest_updated_at"));
    if (ownValue(value, "deleted_at") !== null || ownValue(value, "observation_time_matches") !== true
      || stored.desired !== expected.desired || observation.actual !== expected.actual
      || observation.health !== expected.health || observation.last_error !== expected.last_error
      || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
      || port !== expected.port || updatedAt === null) throw new InvalidPostgrestObservationReceiptError();
    return { updatedAt, lastReconciledAt: stored.lastReconciledAt };
  } catch {
    throw new InvalidPostgrestObservationReceiptError();
  }
}

export class InvalidPostgrestObservationError extends Error {
  constructor() {
    super("Invalid PostgREST runtime observation");
    this.name = "InvalidPostgrestObservationError";
  }
}

export function parsePostgrestObservation(value: unknown): Pick<PostgrestRuntimeStatus, "actual" | "health" | "last_error"> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new InvalidPostgrestObservationError();
    }
    const actual = ownValue(value, "actual");
    const health = ownValue(value, "health");
    const last_error = ownValue(value, "last_error");
    if ((actual !== "running" && actual !== "stopped" && actual !== "starting" && actual !== "error")
      || (health !== "healthy" && health !== "unhealthy" && health !== "unknown")
      || (last_error !== null && typeof last_error !== "string")
      || (health === "healthy" && (actual !== "running" || last_error !== null))
      || (actual === "stopped" && (health !== "unknown" || last_error !== null))) {
      throw new InvalidPostgrestObservationError();
    }
    return { actual, health, last_error };
  } catch {
    throw new InvalidPostgrestObservationError();
  }
}

export class InvalidPostgrestStatusRecordError extends Error {
  constructor() {
    super("Invalid persisted PostgREST status record");
    this.name = "InvalidPostgrestStatusRecordError";
  }
}

function ownValue(record: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(record, key);
  if (!property) return undefined;
  if (!("value" in property)) throw new InvalidPostgrestStatusRecordError();
  return property.value;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return new Date(Date.prototype.getTime.call(value)).toISOString();
  if (typeof value === "string" && new Date(value).toISOString() === value) return value;
  throw new InvalidPostgrestStatusRecordError();
}

export function parsePostgrestStatusRecord(value: unknown, projectRef: string) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || ownValue(value, "ref") !== projectRef) throw new InvalidPostgrestStatusRecordError();
    const desired = parsePostgrestDesiredState(value);
    const revision = ownValue(value, "postgrest_row_revision");
    if (typeof revision !== "string" || !/^(?:0|[1-9]\d{0,9})$/.test(revision)
      || Number(revision) > 4294967295) throw new InvalidPostgrestStatusRecordError();
    const lastError = ownValue(value, "postgrest_last_error");
    if (lastError !== undefined && lastError !== null && typeof lastError !== "string") {
      throw new InvalidPostgrestStatusRecordError();
    }
    const updatedAt = timestamp(ownValue(value, "postgrest_updated_at"));
    const legacyUpdatedAt = timestamp(ownValue(value, "updated_at"));
    const lastReconciledAt = timestamp(ownValue(value, "postgrest_last_reconciled_at"));
    return { desired, revision, lastError: lastError ?? null, updatedAt: updatedAt ?? legacyUpdatedAt, lastReconciledAt };
  } catch {
    throw new InvalidPostgrestStatusRecordError();
  }
}
