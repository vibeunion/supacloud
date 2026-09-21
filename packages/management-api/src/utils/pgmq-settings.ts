import { pgmqInteger, PgmqInputError } from "./pgmq-input";

export interface QueueSettings {
  max_in_flight: number;
  default_visibility_timeout_sec: number;
  max_attempts: number;
  rate_limit_per_minute: number;
}

const defaults: Readonly<QueueSettings> = {
  max_in_flight: 10, default_visibility_timeout_sec: 330,
  max_attempts: 3, rate_limit_per_minute: 600,
};
const limits: Readonly<QueueSettings> = {
  max_in_flight: 100, default_visibility_timeout_sec: 1800,
  max_attempts: 10, rate_limit_per_minute: 60000,
};
const keys = ["max_in_flight", "default_visibility_timeout_sec", "max_attempts", "rate_limit_per_minute"] as const;

export class PgmqSettingsError extends Error {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Queue settings could not be validated");
    this.name = "PgmqSettingsError";
  }
}

export class PgmqSettingsConflictError extends Error {
  constructor() {
    super("Queue settings changed before the update could be applied");
    this.name = "PgmqSettingsConflictError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new PgmqSettingsError();
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !property || !("value" in property)) throw new PgmqSettingsError();
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}

export function pgmqSettingsPatch(value: unknown): Partial<QueueSettings> {
  try {
    const data = record(value);
    if (Object.keys(data).some(key => !keys.some(allowed => key === allowed))) throw new PgmqInputError();
    const patch: Partial<QueueSettings> = {};
    for (const key of keys) {
      if (Object.hasOwn(data, key)) patch[key] = pgmqInteger(data[key], 1, limits[key]);
    }
    return Object.freeze(patch);
  } catch {
    throw new PgmqInputError();
  }
}

export function pgmqSettingsProject(value: unknown, ref: string): {
  id: string; config: Record<string, unknown>; queues: Record<string, unknown>;
} {
  const project = record(value);
  if (project.ref !== ref || project.deleted_at !== null
    || typeof project.id !== "string" || project.id.length === 0) throw new PgmqSettingsError();
  const config = record(project.config);
  const queues = Object.hasOwn(config, "queue_settings") ? record(config.queue_settings) : {};
  return { id: project.id, config, queues };
}

export function readPgmqSettings(queues: Record<string, unknown>, name: string, complete = false): QueueSettings {
  const data = Object.hasOwn(queues, name) ? record(queues[name]) : {};
  const result = { ...defaults };
  try {
    for (const key of keys) {
      if (Object.hasOwn(data, key)) result[key] = pgmqInteger(data[key], 1, limits[key]);
      else if (complete) throw new PgmqSettingsError();
    }
  } catch {
    throw new PgmqSettingsError();
  }
  return result;
}

export function pgmqSettingsMatch(actual: QueueSettings, expected: QueueSettings): boolean {
  return keys.every(key => actual[key] === expected[key]);
}

export function pgmqSettingsWithUpdate(
  queues: Record<string, unknown>, name: string, settings: QueueSettings,
): Record<string, unknown> {
  const previous = Object.hasOwn(queues, name) ? record(queues[name]) : {};
  return { ...queues, [name]: { ...previous, ...settings } };
}
