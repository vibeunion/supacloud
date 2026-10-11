import { Cause, Duration, Effect, Exit, ManagedRuntime, Schedule } from "effect";
import type * as Layer from "effect/Layer";

export interface CompiledEffectError {
  readonly tag: string;
  readonly status: number;
  readonly code: string;
  readonly message?: string;
}

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

function mapEffectFailure(
  error: unknown,
  descriptor: CompiledEffectDescriptor | undefined,
): EffectApplicationError {
  const tag = effectErrorTag(error);
  const mapping = tag && descriptor?.errors?.find((entry) => entry.tag === tag);
  if (mapping) {
    return new EffectApplicationError(
      mapping.message ?? mapping.code,
      mapping.status,
      mapping.code,
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
  if (descriptor?.retry === "explicit" && descriptor.maxAttempts !== undefined && descriptor.maxAttempts > 1) {
    program = Effect.retry(program, Schedule.recurs(descriptor.maxAttempts - 1));
  }
  const exit = await runtime.run(program);
  if (Exit.isSuccess(exit)) return exit.value;
  throw mapEffectFailure(Cause.squash(exit.cause), descriptor);
}
