/**
 * The only production Effect interpreter.
 *
 * Application code returns an Effect program. This adapter owns timeout,
 * the transient-failure allow-list, and the Exit-to-HTTP mapping. It does not
 * replace command receipts, idempotency or durable job retry.
 */
import { Cause, Duration, Effect, Exit, ManagedRuntime } from "effect";
import type * as Layer from "effect/Layer";

export interface CompiledEffectError {
  readonly tag: string;
  readonly status: number;
  readonly code: string;
  readonly message?: string;
  readonly codeFromError?: boolean;
  readonly messageFromError?: boolean;
  readonly statusFromError?: boolean;
  /** Framework may retry this declared 5xx failure. Outcome-unknown failures must not set this. */
  readonly retryable?: boolean;
  /** The write may already have happened. Never retried, even when retry is explicit. */
  readonly outcomeUnknown?: boolean;
}

/** An omitted retry policy means no retry; it never enables explicit retry. */
export const DEFAULT_EFFECT_RETRY = "none" as const;

export interface CompiledEffectDescriptor {
  readonly required: true;
  readonly errors?: readonly CompiledEffectError[];
  readonly dependencies?: readonly string[];
  readonly retry?: "none" | "explicit";
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

export interface SupaCloudEffectRuntime {
  run(program: Effect.Effect<unknown, unknown, unknown>): Promise<Exit.Exit<unknown, unknown>>;
  dispose?(): Promise<void>;
}

export class EffectApplicationError extends Error {
  readonly expose = true as const;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EffectApplicationError";
  }
}

export function createDefaultEffectRuntime(): SupaCloudEffectRuntime {
  return {
    run(program) {
      return Effect.runPromiseExit(program as Effect.Effect<unknown, unknown, never>);
    },
  };
}

export function createEffectRuntimeFromLayer<Services>(
  layer: Layer.Layer<Services, never, never>,
): SupaCloudEffectRuntime {
  const managedRuntime = ManagedRuntime.make(layer);
  return {
    run(program) {
      return managedRuntime.runPromiseExit(
        program as Effect.Effect<unknown, unknown, Services>,
      );
    },
    dispose: () => managedRuntime.dispose(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function effectErrorTag(error: unknown): string | undefined {
  if (isRecord(error)) {
    for (const key of ["_tag", "tag", "code", "name"]) {
      const value = error[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  if (error instanceof Error && error.constructor.name) return error.constructor.name;
  return undefined;
}

/** Instance values are opt-in and bounded so a failure cannot bypass the declared contract. */
function boundedString(value: unknown, key: "code" | "message", maxLength: number): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maxLength);
}

function boundedStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value["status"];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : undefined;
}

/**
 * In-process retry is an allow-list, not a blanket schedule.
 * Only a declared 5xx tag that is not outcome-unknown qualifies. 4xx, unmapped
 * failures, defects and unknown write outcomes stay failed so the caller can
 * use the receipt or read-back protocol instead of repeating a write.
 */
function isFrameworkRetryable(error: unknown, descriptor: CompiledEffectDescriptor): boolean {
  const tag = effectErrorTag(error);
  if (!tag) return false;
  const mapping = descriptor.errors?.find((entry) => entry.tag === tag);
  return mapping?.retryable === true
    && mapping.outcomeUnknown !== true
    && mapping.statusFromError !== true
    && mapping.status >= 500
    && mapping.status <= 599;
}

function mapEffectFailure(
  error: unknown,
  descriptor: CompiledEffectDescriptor | undefined,
): EffectApplicationError {
  const tag = effectErrorTag(error);
  const mapping = tag && descriptor?.errors?.find((entry) => entry.tag === tag);
  if (mapping) {
    const instanceCode = mapping.codeFromError ? boundedString(error, "code", 120) : undefined;
    const instanceMessage = mapping.messageFromError ? boundedString(error, "message", 500) : undefined;
    const instanceStatus = mapping.statusFromError ? boundedStatus(error) : undefined;
    return new EffectApplicationError(
      instanceMessage ?? mapping.message ?? mapping.code,
      instanceStatus ?? mapping.status,
      instanceCode ?? mapping.code,
      isRecord(error) && "details" in error ? error.details : undefined,
    );
  }
  if (tag === "TimeoutException" || tag === "TimeoutError") {
    return new EffectApplicationError("Effect execution timed out", 504, "EFFECT_TIMEOUT");
  }
  return new EffectApplicationError(
    "Effect execution failed",
    500,
    descriptor?.required ? "EFFECT_UNMAPPED_ERROR" : "EFFECT_RUNTIME_ERROR",
  );
}

export async function runCompiledEffect(
  value: unknown,
  descriptor?: CompiledEffectDescriptor,
  runtime: SupaCloudEffectRuntime = createDefaultEffectRuntime(),
): Promise<unknown> {
  if (!Effect.isEffect(value)) {
    if (descriptor?.required) {
      throw new EffectApplicationError(
        "Route declared an Effect contract but returned a non-Effect value",
        500,
        "EFFECT_PROGRAM_REQUIRED",
      );
    }
    return value;
  }

  let program = value;
  if (descriptor?.timeoutMs !== undefined) {
    program = Effect.timeout(program, Duration.millis(descriptor.timeoutMs));
  }
  const retry = descriptor?.retry ?? DEFAULT_EFFECT_RETRY;
  const maxAttempts = descriptor?.maxAttempts;
  if (retry === "explicit" && maxAttempts !== undefined && maxAttempts > 1 && descriptor) {
    program = Effect.retry(program, {
      times: maxAttempts - 1,
      while: (error) => isFrameworkRetryable(error, descriptor),
    });
  }
  const exit = await runtime.run(program);
  if (Exit.isSuccess(exit)) return exit.value;
  throw mapEffectFailure(Cause.squash(exit.cause), descriptor);
}
