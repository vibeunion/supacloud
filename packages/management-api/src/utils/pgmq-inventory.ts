import { readPgmqTimestamp } from "./pgmq-message-id";

export interface PgmqQueueInfo {
  queue_name: string;
  created_at: string | Date | null;
  is_partitioned: boolean;
  is_unlogged: boolean;
}

export interface PgmqQueueMetrics {
  queue_name: string;
  queue_length: number;
  newest_msg_age_sec: number | null;
  oldest_msg_age_sec: number | null;
  total_messages: number;
  scrape_time: string | Date;
}

export class PgmqInventoryError extends Error {
  constructor(readonly mutationMayHaveApplied = false) {
    super("PGMQ inventory or receipt could not be validated");
    this.name = "PgmqInventoryError";
  }
}

function invalid(): never { throw new PgmqInventoryError(); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function row(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}
function rows(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
function flag(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function timestamp(value: unknown): string | Date {
  try { return readPgmqTimestamp(value); } catch { return invalid(); }
}

export function pgmqQueueName(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value) ? value : invalid();
}
export function isPublicPgmqQueueName(value: string): boolean {
  return !value.trim().toLowerCase().startsWith("supacloud_internal_");
}
export function assertPublicPgmqQueueName(value: unknown): asserts value is string {
  const name = pgmqQueueName(value);
  if (!isPublicPgmqQueueName(name)) return invalid();
}

export function pgmqSafeCount(value: unknown): number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : invalid();
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : invalid();
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return invalid();
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : invalid();
}

function age(value: unknown): number | null {
  // Clock skew can produce negative ages; do not misclassify those as missing.
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^-?(0|[1-9][0-9]{0,15})$/.test(value)
    && value !== "-0" && Number.isSafeInteger(Number(value))) return Number(value);
  return invalid();
}

function metric(value: unknown): PgmqQueueMetrics {
  const data = row(value);
  return {
    queue_name: pgmqQueueName(data.queue_name),
    queue_length: pgmqSafeCount(data.queue_length),
    total_messages: pgmqSafeCount(data.total_messages),
    newest_msg_age_sec: age(data.newest_msg_age_sec),
    oldest_msg_age_sec: age(data.oldest_msg_age_sec),
    scrape_time: timestamp(data.scrape_time),
  };
}

function publicRows<T extends { queue_name: string }>(value: unknown, decode: (value: unknown) => T): T[] {
  const names = new Set<string>();
  const result: T[] = [];
  for (const valueRow of rows(value, 10000)) {
    const data = row(valueRow);
    const name = pgmqQueueName(data.queue_name);
    if (names.has(name)) return invalid();
    names.add(name);
    // Reserved queues are deliberately excluded, not interpreted as user queues.
    if (!isPublicPgmqQueueName(name)) continue;
    result.push(decode(data));
  }
  return result;
}

export function readPgmqQueueInfo(value: unknown): PgmqQueueInfo[] {
  return publicRows(value, valueRow => {
    const data = row(valueRow);
    return {
      queue_name: pgmqQueueName(data.queue_name),
      created_at: data.created_at === null ? null : timestamp(data.created_at),
      is_partitioned: flag(data.is_partitioned),
      is_unlogged: flag(data.is_unlogged),
    };
  });
}
export function readPgmqMetrics(value: unknown, queueName: string): PgmqQueueMetrics | null {
  assertPublicPgmqQueueName(queueName);
  const result = rows(value, 1);
  if (result.length === 0) return null;
  const decoded = metric(result[0]);
  return decoded.queue_name === queueName ? decoded : invalid();
}
export function readPgmqMetricsAll(value: unknown): PgmqQueueMetrics[] {
  return publicRows(value, metric);
}
export function readPgmqPurgeReceipt(value: unknown): number {
  const result = rows(value, 1);
  if (result.length !== 1) return invalid();
  return pgmqSafeCount(row(result[0]).purged);
}
export function readPgmqDropReceipt(value: unknown): boolean {
  const result = rows(value, 1);
  if (result.length !== 1) return invalid();
  return flag(row(result[0]).dropped);
}
