import { SupaCloudProcedureError } from "./procedure-error.js";

export interface SupaCloudProcedureMetadata {
  readonly idempotency: "none" | "required";
}

export interface SupaCloudProcedureExecution {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,512}$/;

export function isValidSupaCloudIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && idempotencyKeyPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSupaCloudProcedureExecution(
  metadata: SupaCloudProcedureMetadata,
  execution?: unknown,
): void {
  if (execution !== undefined && !isRecord(execution)) {
    throw new SupaCloudProcedureError("Procedure execution must be an options object", {
      code: "SUPACLOUD_EXECUTION_ERROR",
    });
  }
  const signal = isRecord(execution) ? execution.signal : undefined;
  if (signal !== undefined
    && (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal))) {
    throw new SupaCloudProcedureError("Procedure signal must be an AbortSignal", {
      code: "SUPACLOUD_EXECUTION_ERROR",
    });
  }
  const key = isRecord(execution) ? execution.idempotencyKey : undefined;
  if ((metadata.idempotency === "required" && key === undefined)
    || (key !== undefined && !isValidSupaCloudIdempotencyKey(key))) {
    throw new SupaCloudProcedureError("This procedure requires a valid idempotencyKey", {
      code: "SUPACLOUD_EXECUTION_ERROR",
    });
  }
}
