import { stableSha256 } from "../utils/stable-json";

/**
 * Records CPU, storage, and function use for a later chargeback reader.
 * Quantities are additive and unpriced. This module does not invoice,
 * call a payment provider, or emit a charge.
 */

export const USAGE_DIMENSIONS = ["cpu", "storage", "function"] as const;

export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export const USAGE_UNITS = {
  cpu: "cpu_milliseconds",
  storage: "storage_bytes",
  function: "function_invocations",
} as const;

export type UsageUnit = (typeof USAGE_UNITS)[UsageDimension];

const USAGE_AGGREGATION = "sum" as const;
const MAX_USAGE_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const OBSERVATION_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const CLIENT_USAGE_CODES = new Set([
  "USAGE_PROJECT_INVALID",
  "USAGE_DIMENSION_INVALID",
  "USAGE_WINDOW_INVALID",
  "USAGE_LIMIT_INVALID",
]);
const CHARGE_FIELD_KEYS = new Set([
  "price",
  "prices",
  "currency",
  "invoice",
  "invoices",
  "amount",
  "amountdue",
  "amount_due",
  "charge",
  "charges",
  "stripe",
  "payment",
  "payments",
  "unitprice",
  "unit_price",
  "cost",
  "costs",
  "subtotal",
]);

export class UsageMeterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function isClientUsageError(error: UsageMeterError): boolean {
  return CLIENT_USAGE_CODES.has(error.code);
}

export interface UsageObservation {
  projectRef: string;
  dimension: UsageDimension;
  quantity: number;
  observationId: string;
  observedAt: string;
  subject?: string | null;
}

export interface PreparedUsageObservation {
  projectRef: string;
  dimension: UsageDimension;
  unit: UsageUnit;
  aggregation: typeof USAGE_AGGREGATION;
  quantity: number;
  observedAt: string;
  observationId: string;
  subject: string | null;
  receiptId: string;
  windowStart: string;
}

export interface UsageReceipt {
  schema: "supacloud.usage-receipt.v1";
  receiptId: string;
  projectRef: string;
  dimension: UsageDimension;
  unit: UsageUnit;
  aggregation: typeof USAGE_AGGREGATION;
  quantity: number;
  observedAt: string;
  recordedAt: string;
  observationId: string;
  subject: string | null;
}

export interface UsageCounter {
  schema: "supacloud.usage-counter.v1";
  projectRef: string;
  dimension: UsageDimension;
  unit: UsageUnit;
  aggregation: typeof USAGE_AGGREGATION;
  windowStart: string;
  windowEnd: string;
  quantity: number;
  receiptCount: number;
}

export interface UsageTotal {
  dimension: UsageDimension;
  unit: UsageUnit;
  aggregation: typeof USAGE_AGGREGATION;
  quantity: number;
  receiptCount: number;
}

export interface UsageReading {
  schema: "supacloud.usage-reading.v1";
  projectRef: string;
  windowStart: string;
  windowEnd: string;
  recorded: true;
  charged: false;
  lines: UsageTotal[];
}

export interface UsageRecordResult {
  receipt: UsageReceipt;
  replayed: boolean;
}

export interface UsageReceiptQuery {
  dimension?: UsageDimension;
  from?: string;
  to?: string;
  limit?: number;
}

export interface UsageCounterQuery {
  from?: string;
  to?: string;
  limit?: number;
}

export interface UsageMeterReader {
  reading(projectRef: string, windowStart: string, windowEnd: string): Promise<UsageReading>;
  receipts(projectRef: string, query: UsageReceiptQuery): Promise<UsageReceipt[]>;
  counters(projectRef: string, query: UsageCounterQuery): Promise<UsageCounter[]>;
}

interface StoredReceipt extends UsageReceipt {
  windowStart: string;
}

export function parseUsageInstant(value: unknown, code: string): Date {
  if (typeof value !== "string" || value.trim() === "") throw new UsageMeterError(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new UsageMeterError(code);
  return parsed;
}

export function usageWindowStart(observedAt: string): string {
  const parsed = parseUsageInstant(observedAt, "USAGE_OBSERVED_AT_INVALID");
  return new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
    parsed.getUTCHours(),
  )).toISOString();
}

export function usageWindowEnd(windowStart: string): string {
  const start = parseUsageInstant(windowStart, "USAGE_WINDOW_INVALID");
  return new Date(start.getTime() + 60 * 60 * 1000).toISOString();
}

export function parseUsageWindow(windowStart: unknown, windowEnd: unknown): { windowStart: string; windowEnd: string } {
  const start = parseUsageInstant(windowStart, "USAGE_WINDOW_INVALID");
  const end = parseUsageInstant(windowEnd, "USAGE_WINDOW_INVALID");
  if (start.getTime() >= end.getTime() || end.getTime() - start.getTime() > MAX_USAGE_WINDOW_MS) {
    throw new UsageMeterError("USAGE_WINDOW_INVALID");
  }
  return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

export function parseUsageProjectRef(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_REF_PATTERN.test(value)) {
    throw new UsageMeterError("USAGE_PROJECT_INVALID");
  }
  return value;
}

export function parseUsageDimension(value: unknown): UsageDimension | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !USAGE_DIMENSIONS.includes(value as UsageDimension)) {
    throw new UsageMeterError("USAGE_DIMENSION_INVALID");
  }
  return value as UsageDimension;
}

export function parseUsageLimit(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new UsageMeterError("USAGE_LIMIT_INVALID");
  return parsed;
}

function positiveQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new UsageMeterError("USAGE_QUANTITY_INVALID");
  }
  return value;
}

export function readUsageQuantity(value: unknown, code = "USAGE_QUANTITY_INVALID"): number {
  if (typeof value === "bigint" || typeof value === "string") {
    if (typeof value === "bigint" && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new UsageMeterError(code);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageMeterError(code);
    return parsed;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new UsageMeterError(code);
  return value;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !OBSERVATION_PATTERN.test(value)) throw new UsageMeterError(code);
  return value;
}

export function parseUsageObservation(value: unknown): PreparedUsageObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageMeterError("USAGE_OBSERVATION_INVALID");
  const input = value as Partial<UsageObservation>;
  const projectRef = parseUsageProjectRef(input.projectRef);
  const dimension = parseUsageDimension(input.dimension);
  if (!dimension) throw new UsageMeterError("USAGE_DIMENSION_INVALID");
  const quantity = positiveQuantity(input.quantity);
  const observationId = identifier(input.observationId, "USAGE_OBSERVATION_INVALID");
  const observedAt = parseUsageInstant(input.observedAt, "USAGE_OBSERVED_AT_INVALID").toISOString();
  const subject = input.subject === undefined || input.subject === null
    ? null
    : identifier(input.subject, "USAGE_SUBJECT_INVALID");
  const prepared: PreparedUsageObservation = {
    projectRef,
    dimension,
    unit: USAGE_UNITS[dimension],
    aggregation: USAGE_AGGREGATION,
    quantity,
    observedAt,
    observationId,
    subject,
    receiptId: stableSha256({
      schema: "supacloud.usage-receipt.v1",
      projectRef,
      observationId,
    }),
    windowStart: usageWindowStart(observedAt),
  };
  assertUsagePayloadRecordsUsageOnly(prepared);
  return prepared;
}

/** CPU time to add, in milliseconds. */
export function cpuUsageObservation(input: {
  projectRef: string;
  cpuMilliseconds: number;
  observationId: string;
  observedAt: string;
  subject?: string | null;
}): UsageObservation {
  return {
    projectRef: input.projectRef,
    dimension: "cpu",
    quantity: input.cpuMilliseconds,
    observationId: input.observationId,
    observedAt: input.observedAt,
    subject: input.subject,
  };
}

/** Bytes to add. Pass a contribution for the window, not a repeated occupancy sample. */
export function storageUsageObservation(input: {
  projectRef: string;
  storageBytes: number;
  observationId: string;
  observedAt: string;
  subject?: string | null;
}): UsageObservation {
  return {
    projectRef: input.projectRef,
    dimension: "storage",
    quantity: input.storageBytes,
    observationId: input.observationId,
    observedAt: input.observedAt,
    subject: input.subject,
  };
}

/** Function invocations to add. Attribute CPU time with a cpu observation instead. */
export function functionUsageObservation(input: {
  projectRef: string;
  invocations: number;
  observationId: string;
  observedAt: string;
  subject?: string | null;
}): UsageObservation {
  return {
    projectRef: input.projectRef,
    dimension: "function",
    quantity: input.invocations,
    observationId: input.observationId,
    observedAt: input.observedAt,
    subject: input.subject,
  };
}

export function usageReceipt(prepared: PreparedUsageObservation, recordedAt: string): UsageReceipt {
  const receipt: UsageReceipt = {
    schema: "supacloud.usage-receipt.v1",
    receiptId: prepared.receiptId,
    projectRef: prepared.projectRef,
    dimension: prepared.dimension,
    unit: prepared.unit,
    aggregation: USAGE_AGGREGATION,
    quantity: prepared.quantity,
    observedAt: prepared.observedAt,
    recordedAt: parseUsageInstant(recordedAt, "USAGE_OBSERVED_AT_INVALID").toISOString(),
    observationId: prepared.observationId,
    subject: prepared.subject,
  };
  assertUsagePayloadRecordsUsageOnly(receipt);
  return receipt;
}

export function usageReading(input: {
  projectRef: string;
  windowStart: string;
  windowEnd: string;
  totals: readonly UsageTotal[];
}): UsageReading {
  const window = parseUsageWindow(input.windowStart, input.windowEnd);
  const projectRef = parseUsageProjectRef(input.projectRef);
  const totals = new Map<UsageDimension, UsageTotal>();
  for (const total of input.totals) {
    const dimension = parseUsageDimension(total.dimension);
    if (!dimension || totals.has(dimension)) throw new UsageMeterError("USAGE_DIMENSION_INVALID");
    if (total.unit !== USAGE_UNITS[dimension] || total.aggregation !== USAGE_AGGREGATION) {
      throw new UsageMeterError("USAGE_UNIT_INVALID");
    }
    totals.set(dimension, {
      dimension,
      unit: USAGE_UNITS[dimension],
      aggregation: USAGE_AGGREGATION,
      quantity: readUsageQuantity(total.quantity),
      receiptCount: readUsageQuantity(total.receiptCount),
    });
  }
  const reading: UsageReading = {
    schema: "supacloud.usage-reading.v1",
    projectRef,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    recorded: true,
    charged: false,
    lines: USAGE_DIMENSIONS.map(dimension => totals.get(dimension) ?? {
      dimension,
      unit: USAGE_UNITS[dimension],
      aggregation: USAGE_AGGREGATION,
      quantity: 0,
      receiptCount: 0,
    }),
  };
  assertUsagePayloadRecordsUsageOnly(reading);
  return reading;
}

export function assertUsagePayloadRecordsUsageOnly(value: unknown): void {
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      if (CHARGE_FIELD_KEYS.has(key.toLowerCase())) throw new UsageMeterError("USAGE_CHARGE_FIELD_FORBIDDEN");
      if (key === "charged" && entry !== false) throw new UsageMeterError("USAGE_CHARGE_FIELD_FORBIDDEN");
      visit(entry);
    }
  };
  visit(value);
}

function sameObservation(existing: UsageReceipt, prepared: PreparedUsageObservation): boolean {
  return existing.dimension === prepared.dimension
    && existing.unit === prepared.unit
    && existing.quantity === prepared.quantity
    && existing.observedAt === prepared.observedAt
    && existing.subject === prepared.subject
    && existing.receiptId === prepared.receiptId
    && existing.projectRef === prepared.projectRef
    && existing.observationId === prepared.observationId;
}

function counterKey(projectRef: string, dimension: UsageDimension, windowStart: string): string {
  return `${projectRef}\u0000${dimension}\u0000${windowStart}`;
}

function observationKey(projectRef: string, observationId: string): string {
  return `${projectRef}\u0000${observationId}`;
}

/** In-process ledger. The control-plane store persists the same contract. */
export class UsageMeter {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly counters = new Map<string, UsageCounter>();

  record(value: unknown, recordedAt = new Date().toISOString()): UsageRecordResult {
    const prepared = parseUsageObservation(value);
    const key = observationKey(prepared.projectRef, prepared.observationId);
    const existing = this.receipts.get(key);
    if (existing) {
      if (!sameObservation(existing, prepared)) throw new UsageMeterError("USAGE_OBSERVATION_CONFLICT");
      return { receipt: usageReceipt(prepared, existing.recordedAt), replayed: true };
    }
    const counterId = counterKey(prepared.projectRef, prepared.dimension, prepared.windowStart);
    const current = this.counters.get(counterId);
    if (current && (
      current.quantity > Number.MAX_SAFE_INTEGER - prepared.quantity
      || current.receiptCount >= Number.MAX_SAFE_INTEGER
    )) {
      throw new UsageMeterError("USAGE_COUNTER_OVERFLOW");
    }
    const receipt = usageReceipt(prepared, recordedAt);
    const counter: UsageCounter = {
      schema: "supacloud.usage-counter.v1",
      projectRef: prepared.projectRef,
      dimension: prepared.dimension,
      unit: prepared.unit,
      aggregation: USAGE_AGGREGATION,
      windowStart: prepared.windowStart,
      windowEnd: usageWindowEnd(prepared.windowStart),
      quantity: (current?.quantity ?? 0) + prepared.quantity,
      receiptCount: (current?.receiptCount ?? 0) + 1,
    };
    assertUsagePayloadRecordsUsageOnly(counter);
    this.receipts.set(key, { ...receipt, windowStart: prepared.windowStart });
    this.counters.set(counterId, counter);
    return { receipt, replayed: false };
  }

  receiptsFor(projectRef: string, query: UsageReceiptQuery = {}): UsageReceipt[] {
    const ref = parseUsageProjectRef(projectRef);
    const dimension = parseUsageDimension(query.dimension);
    const from = query.from === undefined ? undefined : parseUsageInstant(query.from, "USAGE_WINDOW_INVALID").toISOString();
    const to = query.to === undefined ? undefined : parseUsageInstant(query.to, "USAGE_WINDOW_INVALID").toISOString();
    if (from && to && from >= to) throw new UsageMeterError("USAGE_WINDOW_INVALID");
    const limit = parseUsageLimit(query.limit);
    return [...this.receipts.values()]
      .filter(receipt => receipt.projectRef === ref)
      .filter(receipt => dimension === undefined || receipt.dimension === dimension)
      .filter(receipt => from === undefined || receipt.observedAt >= from)
      .filter(receipt => to === undefined || receipt.observedAt < to)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt)
        || right.observationId.localeCompare(left.observationId))
      .slice(0, limit)
      .map(({ windowStart: _windowStart, ...receipt }) => receipt);
  }

  countersFor(projectRef: string, query: UsageCounterQuery = {}): UsageCounter[] {
    const ref = parseUsageProjectRef(projectRef);
    const from = query.from === undefined ? undefined : parseUsageInstant(query.from, "USAGE_WINDOW_INVALID").toISOString();
    const to = query.to === undefined ? undefined : parseUsageInstant(query.to, "USAGE_WINDOW_INVALID").toISOString();
    if (from && to && from >= to) throw new UsageMeterError("USAGE_WINDOW_INVALID");
    const limit = parseUsageLimit(query.limit);
    return [...this.counters.values()]
      .filter(counter => counter.projectRef === ref)
      .filter(counter => from === undefined || counter.windowEnd > from)
      .filter(counter => to === undefined || counter.windowStart < to)
      .sort((left, right) => right.windowStart.localeCompare(left.windowStart)
        || left.dimension.localeCompare(right.dimension))
      .slice(0, limit);
  }

  reading(projectRef: string, windowStart: string, windowEnd: string): UsageReading {
    const window = parseUsageWindow(windowStart, windowEnd);
    const ref = parseUsageProjectRef(projectRef);
    const totals = new Map<UsageDimension, UsageTotal>();
    for (const receipt of this.receipts.values()) {
      if (receipt.projectRef !== ref || receipt.observedAt < window.windowStart || receipt.observedAt >= window.windowEnd) continue;
      const current = totals.get(receipt.dimension) ?? {
        dimension: receipt.dimension,
        unit: receipt.unit,
        aggregation: USAGE_AGGREGATION,
        quantity: 0,
        receiptCount: 0,
      };
      if (current.quantity > Number.MAX_SAFE_INTEGER - receipt.quantity || current.receiptCount >= Number.MAX_SAFE_INTEGER) {
        throw new UsageMeterError("USAGE_COUNTER_OVERFLOW");
      }
      totals.set(receipt.dimension, {
        ...current,
        quantity: current.quantity + receipt.quantity,
        receiptCount: current.receiptCount + 1,
      });
    }
    return usageReading({
      projectRef: ref,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      totals: [...totals.values()],
    });
  }
}

export function usageErrorText(code: string): string {
  switch (code) {
    case "USAGE_PROJECT_INVALID":
      return "Project ref is invalid";
    case "USAGE_DIMENSION_INVALID":
      return "Usage dimension is invalid";
    case "USAGE_WINDOW_INVALID":
      return "Usage window is invalid";
    case "USAGE_LIMIT_INVALID":
      return "Usage limit is invalid";
    case "USAGE_QUANTITY_INVALID":
      return "Usage quantity is invalid";
    case "USAGE_OBSERVATION_INVALID":
      return "Usage observation is invalid";
    case "USAGE_SUBJECT_INVALID":
      return "Usage subject is invalid";
    case "USAGE_OBSERVED_AT_INVALID":
      return "Usage observation time is invalid";
    case "USAGE_OBSERVATION_CONFLICT":
      return "Usage observation does not match the recorded receipt";
    case "USAGE_COUNTER_OVERFLOW":
      return "Usage counter exceeded the safe integer range";
    case "USAGE_UNIT_INVALID":
      return "Usage unit does not match the dimension";
    default:
      return "Usage meter rejected the request";
  }
}
