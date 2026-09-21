export class PgmqInputError extends Error {
  constructor() {
    super("Invalid PGMQ operation input");
    this.name = "PgmqInputError";
  }
}

export class PgmqPayloadTooLargeError extends PgmqInputError {
  constructor() {
    super();
    this.name = "PgmqPayloadTooLargeError";
  }
}

export function pgmqInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PgmqInputError();
  }
  return value;
}

export function pgmqSeconds(value: unknown): number {
  return pgmqInteger(value, 0, 2147483647);
}

function options(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new PgmqInputError();
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new PgmqInputError();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property)) throw new PgmqInputError();
    result[key] = property.value;
  }
  return result;
}

function optionalBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new PgmqInputError();
  return value;
}

export function pgmqCreateOptions(value: unknown): Readonly<{ unlogged: boolean }> {
  const data = options(value, ["unlogged"]);
  return Object.freeze({ unlogged: optionalBoolean(data.unlogged) });
}

export function pgmqListOptions(value: unknown): Readonly<{ archived: boolean; limit: number }> {
  const data = options(value, ["archived", "limit"]);
  return Object.freeze({
    archived: optionalBoolean(data.archived),
    limit: data.limit === undefined ? 50 : pgmqInteger(data.limit, 1, 500),
  });
}
