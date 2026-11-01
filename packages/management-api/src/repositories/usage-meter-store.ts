import type { SQL } from "bun";
import { sql } from "../db";
import {
  parseUsageDimension,
  parseUsageInstant,
  parseUsageLimit,
  parseUsageObservation,
  parseUsageProjectRef,
  parseUsageWindow,
  readUsageQuantity,
  USAGE_UNITS,
  usageReading,
  usageWindowEnd,
  usageWindowStart,
  UsageMeterError,
  type UsageCounter,
  type UsageCounterQuery,
  type UsageDimension,
  type UsageMeterReader,
  type UsageReading,
  type UsageReceipt,
  type UsageReceiptQuery,
  type UsageRecordResult,
} from "../services/usage-meter";

const USAGE_ERROR_CODES = [
  "USAGE_PROJECT_INVALID",
  "USAGE_DIMENSION_INVALID",
  "USAGE_UNIT_INVALID",
  "USAGE_QUANTITY_INVALID",
  "USAGE_OBSERVATION_INVALID",
  "USAGE_SUBJECT_INVALID",
  "USAGE_RECEIPT_INVALID",
  "USAGE_WINDOW_INVALID",
  "USAGE_OBSERVATION_CONFLICT",
  "USAGE_COUNTER_OVERFLOW",
  "USAGE_RECORD_MISSING",
] as const;

function rethrowUsageError(error: unknown): never {
  if (error instanceof UsageMeterError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("usage_counters_safe_quantity")) throw new UsageMeterError("USAGE_COUNTER_OVERFLOW");
  const code = USAGE_ERROR_CODES.find(candidate => message.includes(candidate));
  if (code === "USAGE_RECORD_MISSING") throw new Error(code);
  if (code) throw new UsageMeterError(code);
  throw error;
}

function rowInstant(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new UsageMeterError("USAGE_OBSERVED_AT_INVALID");
  return parsed.toISOString();
}

function dimensionOf(value: unknown): UsageDimension {
  const dimension = parseUsageDimension(value);
  if (!dimension) throw new UsageMeterError("USAGE_DIMENSION_INVALID");
  return dimension;
}

function unitOf(dimension: UsageDimension, value: unknown) {
  if (value !== USAGE_UNITS[dimension]) throw new UsageMeterError("USAGE_UNIT_INVALID");
  return USAGE_UNITS[dimension];
}

function receiptFromRow(row: Record<string, unknown>): UsageReceipt {
  const dimension = dimensionOf(row["dimension"]);
  const receipt: UsageReceipt = {
    schema: "supacloud.usage-receipt.v1",
    receiptId: String(row["receipt_id"] ?? "").trim(),
    projectRef: parseUsageProjectRef(row["project_ref"]),
    dimension,
    unit: unitOf(dimension, row["unit"]),
    aggregation: "sum",
    quantity: readUsageQuantity(row["quantity"]),
    observedAt: rowInstant(row["observed_at"]),
    recordedAt: rowInstant(row["recorded_at"]),
    observationId: String(row["observation_id"] ?? ""),
    subject: row["subject"] === null || row["subject"] === undefined ? null : String(row["subject"]),
  };
  if (!/^[a-f0-9]{64}$/.test(receipt.receiptId)) throw new UsageMeterError("USAGE_RECEIPT_INVALID");
  return receipt;
}

function receiptQuery(query: UsageReceiptQuery) {
  return {
    dimension: parseUsageDimension(query.dimension) ?? null,
    from: query.from === undefined ? null : parseUsageInstant(query.from, "USAGE_WINDOW_INVALID").toISOString(),
    to: query.to === undefined ? null : parseUsageInstant(query.to, "USAGE_WINDOW_INVALID").toISOString(),
    limit: parseUsageLimit(query.limit),
  };
}

function counterQuery(query: UsageCounterQuery) {
  return {
    from: query.from === undefined ? null : parseUsageInstant(query.from, "USAGE_WINDOW_INVALID").toISOString(),
    to: query.to === undefined ? null : parseUsageInstant(query.to, "USAGE_WINDOW_INVALID").toISOString(),
    limit: parseUsageLimit(query.limit),
  };
}

/** Persists the usage ledger in the control-plane database. */
export class UsageMeterStore implements UsageMeterReader {
  private readonly database: SQL;

  constructor(database: SQL = sql) {
    this.database = database;
  }

  async record(value: unknown): Promise<UsageRecordResult> {
    const prepared = parseUsageObservation(value);
    try {
      const rows = await this.database`
        SELECT receipt_id, project_ref, dimension, unit, quantity, observed_at, recorded_at,
          observation_id, subject, replayed
        FROM record_project_usage(
          ${prepared.projectRef}::varchar,
          ${prepared.dimension}::text,
          ${prepared.unit}::text,
          ${prepared.quantity}::bigint,
          ${prepared.observedAt}::timestamptz,
          ${prepared.observationId}::text,
          ${prepared.subject}::text,
          ${prepared.receiptId}::text,
          ${prepared.windowStart}::timestamptz
        )
      ` as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row || typeof row["replayed"] !== "boolean") throw new Error("USAGE_RECORD_MISSING");
      return { receipt: receiptFromRow(row), replayed: row["replayed"] };
    } catch (error) {
      rethrowUsageError(error);
    }
  }

  async reading(projectRef: string, windowStart: string, windowEnd: string): Promise<UsageReading> {
    const ref = parseUsageProjectRef(projectRef);
    const window = parseUsageWindow(windowStart, windowEnd);
    try {
      const rows = await this.database`
        SELECT dimension, unit, SUM(quantity) AS quantity, COUNT(*) AS receipt_count
        FROM usage_receipts
        WHERE project_ref = ${ref}
          AND observed_at >= ${window.windowStart}::timestamptz
          AND observed_at < ${window.windowEnd}::timestamptz
        GROUP BY dimension, unit
      ` as Array<Record<string, unknown>>;
      return usageReading({
        projectRef: ref,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        totals: rows.map(row => {
          const dimension = dimensionOf(row["dimension"]);
          return {
            dimension,
            unit: unitOf(dimension, row["unit"]),
            aggregation: "sum" as const,
            quantity: readUsageQuantity(row["quantity"]),
            receiptCount: readUsageQuantity(row["receipt_count"]),
          };
        }),
      });
    } catch (error) {
      rethrowUsageError(error);
    }
  }

  async receipts(projectRef: string, query: UsageReceiptQuery = {}): Promise<UsageReceipt[]> {
    const ref = parseUsageProjectRef(projectRef);
    const parsed = receiptQuery(query);
    if (parsed.from && parsed.to && parsed.from >= parsed.to) throw new UsageMeterError("USAGE_WINDOW_INVALID");
    try {
      const rows = await this.database`
        SELECT receipt_id, project_ref, dimension, unit, quantity, observed_at, recorded_at,
          observation_id, subject
        FROM usage_receipts
        WHERE project_ref = ${ref}
          AND (${parsed.dimension}::text IS NULL OR dimension = ${parsed.dimension})
          AND (${parsed.from}::timestamptz IS NULL OR observed_at >= ${parsed.from})
          AND (${parsed.to}::timestamptz IS NULL OR observed_at < ${parsed.to})
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT ${parsed.limit}
      ` as Array<Record<string, unknown>>;
      return rows.map(receiptFromRow);
    } catch (error) {
      rethrowUsageError(error);
    }
  }

  async counters(projectRef: string, query: UsageCounterQuery = {}): Promise<UsageCounter[]> {
    const ref = parseUsageProjectRef(projectRef);
    const parsed = counterQuery(query);
    if (parsed.from && parsed.to && parsed.from >= parsed.to) throw new UsageMeterError("USAGE_WINDOW_INVALID");
    try {
      const rows = await this.database`
        SELECT project_ref, dimension, unit, window_start, quantity, receipt_count
        FROM usage_counters
        WHERE project_ref = ${ref}
          AND (${parsed.from}::timestamptz IS NULL OR window_start + interval '1 hour' > ${parsed.from}::timestamptz)
          AND (${parsed.to}::timestamptz IS NULL OR window_start < ${parsed.to}::timestamptz)
        ORDER BY window_start DESC, dimension ASC
        LIMIT ${parsed.limit}
      ` as Array<Record<string, unknown>>;
      return rows.map(row => {
        const dimension = dimensionOf(row["dimension"]);
        const windowStart = rowInstant(row["window_start"]);
        if (usageWindowStart(windowStart) !== windowStart) throw new UsageMeterError("USAGE_WINDOW_INVALID");
        return {
          schema: "supacloud.usage-counter.v1" as const,
          projectRef: parseUsageProjectRef(row["project_ref"]),
          dimension,
          unit: unitOf(dimension, row["unit"]),
          aggregation: "sum" as const,
          windowStart,
          windowEnd: usageWindowEnd(windowStart),
          quantity: readUsageQuantity(row["quantity"]),
          receiptCount: readUsageQuantity(row["receipt_count"]),
        };
      });
    } catch (error) {
      rethrowUsageError(error);
    }
  }
}
