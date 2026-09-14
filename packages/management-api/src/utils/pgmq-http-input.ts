import { pgmqInteger, PgmqInputError } from "./pgmq-input";

const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;

function matching<T>(values: readonly (T | undefined)[]): T | undefined {
  const supplied = values.filter(value => value !== undefined);
  const first = supplied[0];
  if (supplied.some(value => value !== first)) throw new PgmqInputError();
  return first;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  return value === undefined ? undefined : pgmqInteger(value, min, max);
}

export function pgmqHttpDelay(input: {
  sleepSeconds?: unknown; sleep_seconds?: unknown; delayMs?: unknown;
}): number {
  const milliseconds = optionalInteger(input.delayMs, 0, MAX_DELAY_SECONDS * 1000);
  return matching([
    optionalInteger(input.sleepSeconds, 0, MAX_DELAY_SECONDS),
    optionalInteger(input.sleep_seconds, 0, MAX_DELAY_SECONDS),
    milliseconds === undefined ? undefined : Math.floor(milliseconds / 1000),
  ]) ?? 0;
}

export function pgmqHttpReceive(input: {
  sleep_seconds?: unknown; visibilityTimeoutSec?: unknown; n?: unknown; count?: unknown;
}) {
  return {
    seconds: matching([
      optionalInteger(input.sleep_seconds, 1, 1800),
      optionalInteger(input.visibilityTimeoutSec, 1, 1800),
    ]),
    count: matching([
      optionalInteger(input.n, 1, 10000),
      optionalInteger(input.count, 1, 10000),
    ]),
  };
}

export function pgmqHttpReceiveSettings(value: unknown): {
  maxCount: number; defaultSeconds: number;
} {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || !("max_in_flight" in value) || !("default_visibility_timeout_sec" in value)) throw new Error();
    return {
      maxCount: pgmqInteger(value.max_in_flight, 1, 100),
      defaultSeconds: pgmqInteger(value.default_visibility_timeout_sec, 1, 1800),
    };
  } catch {
    // Invalid server configuration is not a client input error.
    throw new Error("Invalid PGMQ receive settings");
  }
}

function queryBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new PgmqInputError();
}

export function pgmqHttpList(input: { archived?: unknown; dlq?: unknown; limit?: unknown }) {
  const limit = input.limit;
  if (limit !== undefined && (typeof limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(limit))) {
    throw new PgmqInputError();
  }
  return {
    archived: matching([queryBoolean(input.archived), queryBoolean(input.dlq)]) ?? false,
    limit: limit === undefined ? 50 : pgmqInteger(Number(limit), 1, 500),
  };
}
