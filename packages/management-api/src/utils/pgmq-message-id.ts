import { PgmqPayloadTooLargeError } from "./pgmq-input";

const MAX_ID = 9223372036854775807n;

export type PgmqJson = null | boolean | number | string | PgmqJson[] | { [key: string]: PgmqJson };

export interface PgmqJsonBudget {
  remainingNodes: number;
  remainingBytes: number;
}

export function readPgmqJson(value: unknown, budget?: PgmqJsonBudget): PgmqJson {
  const ancestors = new Set<object>();
  let nodes = 0;
  function chargeString(value: string): void {
    if (!budget) return;
    if (value.length > budget.remainingBytes) throw new PgmqPayloadTooLargeError();
    budget.remainingBytes -= Buffer.byteLength(value, "utf8");
    if (budget.remainingBytes < 0) throw new PgmqPayloadTooLargeError();
  }
  function read(input: unknown, depth: number): PgmqJson {
    if (budget && --budget.remainingNodes < 0) throw new PgmqPayloadTooLargeError();
    if (++nodes > 10000 || depth > 64) throw new Error("PGMQ message exceeds decoded value limit");
    if (typeof input === "string") chargeString(input);
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null || ancestors.has(input)) throw new Error("Invalid PGMQ JSON message");
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null) throw new Error("Invalid PGMQ JSON object");
    ancestors.add(input);
    try {
      const properties = Object.getOwnPropertyDescriptors(input);
      function property(key: string): PgmqJson {
        const descriptor = properties[key];
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid PGMQ JSON property");
        const item: unknown = descriptor.value;
        return read(item, depth + 1);
      }
      if (Object.getOwnPropertySymbols(input).length !== 0) throw new Error("Invalid PGMQ JSON symbol");
      if (Array.isArray(input)) {
        if (input.length > 10000 || Object.keys(input).length !== input.length) throw new Error("Invalid PGMQ JSON array");
        return Array.from({ length: input.length }, (_, index) => property(String(index)));
      }
      return Object.fromEntries(Object.keys(input).map(key => {
        chargeString(key);
        return [key, property(key)];
      }));
    } finally { ancestors.delete(input); }
  }
  return read(value, 0);
}

export function readPgmqTimestamp(value: unknown): string | Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))) return value;
  throw new Error("Invalid PGMQ message timestamp");
}

export function readPgmqMessageRows(value: unknown, maximum: number): Array<Record<string, unknown> & { msg_id: string }> {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid PGMQ message row count");
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (row === null || typeof row !== "object" || Array.isArray(row) || !("msg_id" in row)) {
      throw new Error("Invalid PGMQ message row");
    }
    const msg_id = parsePgmqMessageId(row.msg_id);
    if (ids.has(msg_id)) throw new Error("Duplicate PGMQ message row");
    ids.add(msg_id);
    return { ...Object.fromEntries(Object.entries(row)), msg_id };
  });
}

export function parsePgmqMessageId(value: unknown): string {
  if (typeof value === "bigint") {
    if (value > 0n && value <= MAX_ID) return value.toString();
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_ID) {
    return value;
  }
  throw new Error("Invalid PGMQ message ID");
}

export function readPgmqIdReceipts(value: unknown, expected: number): string[] {
  if (!Array.isArray(value) || value.length !== expected) throw new Error("Invalid PGMQ message ID receipt count");
  const ids = value.map((row: unknown) => {
    if (row === null || typeof row !== "object" || Array.isArray(row) || !("msg_id" in row)) {
      throw new Error("Invalid PGMQ message ID receipt");
    }
    return parsePgmqMessageId(row.msg_id);
  });
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate PGMQ message ID receipts");
  return ids;
}

export function readPgmqIdReceipt(value: unknown): string {
  const id = readPgmqIdReceipts(value, 1)[0];
  if (id === undefined) throw new Error("Missing PGMQ message ID receipt");
  return id;
}

export function readPgmqBooleanReceipt(value: unknown, field: string): boolean {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Invalid PGMQ boolean receipt count");
  const row: unknown = value[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid PGMQ boolean receipt");
  const result: unknown = Object.getOwnPropertyDescriptor(row, field)?.value;
  if (typeof result !== "boolean") throw new Error("Invalid PGMQ boolean receipt");
  return result;
}
