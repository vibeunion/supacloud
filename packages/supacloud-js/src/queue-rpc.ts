import { SupaCloudApiError } from "./api-error.js";

export type SupaCloudQueueJson = null | boolean | number | string
  | SupaCloudQueueJson[] | { [key: string]: SupaCloudQueueJson };
export type SupaCloudQueueMessage = {
  id: string;
  msg_id: string;
  read_ct?: number;
  enqueued_at?: string | null;
  vt?: string | null;
  message: SupaCloudQueueJson;
  payload: SupaCloudQueueJson;
  status?: string;
  queue_name?: string;
  task_type?: string;
};
export type SupaCloudQueueSendResult = {
  id: string;
  msg_id: string;
  queue_name: string;
  status: "pending";
  payload: SupaCloudQueueJson;
};
export type SupaCloudQueueMutationResult = {
  id: string;
  msg_id: string;
  queue_name: string;
  status: "archived" | "deleted" | "released";
  success: boolean;
};

export class SupaCloudQueueError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false, code = "QUEUE_CONTRACT_INVALID") {
    super("Queue input or response could not be validated", 0, {
      code, mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudQueueError";
  }
}
function invalid(): never { throw new SupaCloudQueueError(); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}

export function queueMessageId(value: unknown): string {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : invalid();
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)
    || BigInt(value) > 9223372036854775807n) return invalid();
  return value;
}

export function queueInteger(value: unknown, min: number, max = 2147483647): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : invalid();
}

export function queueSeconds(options: {
  sleepSeconds?: number; sleep_seconds?: number; delayMs?: number; visibilityTimeoutSec?: number;
}): number {
  record(options);
  const candidates: number[] = [];
  for (const value of [options.sleepSeconds, options.sleep_seconds, options.visibilityTimeoutSec]) {
    if (value !== undefined) candidates.push(queueInteger(value, 0));
  }
  if (options.delayMs !== undefined) {
    candidates.push(Math.floor(queueInteger(options.delayMs, 0, 2147483647 * 1000) / 1000));
  }
  const first = candidates[0] ?? 0;
  if (candidates.some(value => value !== first)) return invalid();
  return first;
}

export function queueReadCount(options: unknown, single = false): number {
  const data = record(options);
  const n = data.n === undefined ? undefined : queueInteger(data.n, 1, 10000);
  const count = data.count === undefined ? undefined : queueInteger(data.count, 1, 10000);
  if (n !== undefined && count !== undefined && n !== count) return invalid();
  const result = n ?? count ?? 1;
  return !single || result === 1 ? result : invalid();
}

export function queueJsonSnapshot(value: unknown): SupaCloudQueueJson {
  const ancestors = new Set<object>();
  let nodes = 0, characters = 0;
  function visit(input: unknown, depth: number): SupaCloudQueueJson {
    if (++nodes > 10000 || depth > 64) return invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid();
    if (typeof input === "string") {
      characters += input.length;
      return characters <= 1048576 ? input : invalid();
    }
    if (typeof input !== "object" || ancestors.has(input)) return invalid();
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null) return invalid();
    ancestors.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length !== 0) return invalid();
      const properties = Object.getOwnPropertyDescriptors(input);
      function property(key: string): SupaCloudQueueJson {
        const descriptor = properties[key];
        if (!descriptor || !("value" in descriptor)) return invalid();
        const item: unknown = descriptor.value;
        return visit(item, depth + 1);
      }
      if (Array.isArray(input)) {
        if (input.length > 10000 || Object.keys(input).length !== input.length) return invalid();
        return Array.from({ length: input.length }, (_, index) => property(String(index)));
      }
      return Object.fromEntries(Object.keys(input).map(key => {
        characters += key.length;
        if (characters > 1048576) return invalid();
        return [key, property(key)];
      }));
    } finally { ancestors.delete(input); }
  }
  return visit(value, 0);
}

export function queueRpcIds(value: unknown, expected: number): string[] {
  if (!Array.isArray(value) || value.length !== expected) return invalid();
  const ids = value.map((id: unknown) => queueMessageId(id));
  return new Set(ids).size === ids.length ? ids : invalid();
}
export function queueRpcId(value: unknown): string {
  const id = queueRpcIds(value, 1)[0];
  return id === undefined ? invalid() : id;
}
export function queueRpcBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}

function optionalText(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : invalid();
}
function jsonEqual(left: SupaCloudQueueJson, right: SupaCloudQueueJson): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length
      && left.every((item, index) => right[index] !== undefined && jsonEqual(item, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object"
    || Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length
    && entries.every(([key, value]) => Object.hasOwn(right, key)
      && right[key] !== undefined && jsonEqual(value, right[key]));
}

export function queueMessage(value: unknown, expected: {
  queueName?: string; messageId?: string; status?: string; rpc?: boolean;
} = {}): SupaCloudQueueMessage {
  const data = record(value);
  const id = queueMessageId(data.msg_id);
  if (expected.messageId !== undefined && expected.messageId !== id
    || data.id !== undefined && queueMessageId(data.id) !== id) return invalid();
  const hasMessage = Object.hasOwn(data, "message");
  const hasPayload = Object.hasOwn(data, "payload");
  if (!hasMessage && (!hasPayload || expected.rpc)) return invalid();
  const message = queueJsonSnapshot(hasMessage ? data.message : data.payload);
  if (hasMessage && hasPayload && !jsonEqual(message, queueJsonSnapshot(data.payload))) return invalid();
  const result: SupaCloudQueueMessage = { id, msg_id: id, message, payload: message };
  if (data.read_ct !== undefined || expected.rpc) result.read_ct = queueInteger(data.read_ct, 0);
  for (const field of ["enqueued_at", "vt"] as const) {
    if (data[field] === undefined && !expected.rpc) continue;
    const timestamp = data[field];
    if (timestamp === null && !expected.rpc) { result[field] = null; continue; }
    const text = optionalText(timestamp);
    if (!Number.isFinite(Date.parse(text))) return invalid();
    result[field] = text;
  }
  for (const field of ["status", "queue_name", "task_type"] as const) {
    if (data[field] !== undefined) result[field] = optionalText(data[field]);
  }
  if (expected.queueName !== undefined) {
    if (result.queue_name !== undefined && result.queue_name !== expected.queueName
      || result.task_type !== undefined && result.task_type !== `queue:${expected.queueName}`) return invalid();
    result.queue_name = expected.queueName;
    result.task_type = `queue:${expected.queueName}`;
  }
  if (expected.status !== undefined) {
    if (result.status !== undefined && result.status !== expected.status) return invalid();
    result.status = expected.status;
  }
  return result;
}

export function queueRpcMessages(queueName: string, value: unknown, max: number, status: string): SupaCloudQueueMessage[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  const result = value.map((row: unknown) => queueMessage(row, { queueName, status, rpc: true }));
  return new Set(result.map(row => row.id)).size === result.length ? result : invalid();
}
