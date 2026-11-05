/**
 * Static application aspect contract.
 *
 * Aspects are explicit functions referenced by Module/Route/Command metadata.
 * The compiler resolves those references and emits a direct invocation chain.
 */
export type AspectKind = "route" | "command" | "job";

export interface AspectContext<Input = unknown, Services extends object = Record<string, unknown>> {
  readonly kind: AspectKind;
  readonly name: string;
  readonly input: Input;
  readonly request?: Request;
  readonly requestContext?: unknown;
  readonly scope?: Record<string, unknown>;
  readonly services?: Services;
  readonly metadata?: unknown;
}

export type AspectNext<TResult = unknown> = () => TResult | Promise<TResult>;

export type Aspect<TResult = unknown> = (
  context: AspectContext,
  next: AspectNext<TResult>,
) => TResult | Promise<TResult>;

export type RouteAspect = Aspect;
export type CommandAspect = Aspect;
export type JobAspect = Aspect;

export type ReadonlyAspectData<T> = T extends (...args: never[]) => unknown
  ? T : T extends object ? { readonly [K in keyof T]: ReadonlyAspectData<T[K]> } : T;

/** The typed callback receives only explicitly decoded data and selected capabilities. */
export interface OperationAspectContext<Input, Capabilities extends object> {
  readonly kind: AspectKind;
  readonly name: string;
  readonly input: ReadonlyAspectData<Input>;
  readonly capabilities: Readonly<Capabilities>;
}

export interface OperationAspectContract<Input, Result, Capabilities extends object> {
  readonly kind: AspectKind;
  readonly name: string;
  readonly input: (value: unknown) => Input;
  /** Validate without transforming or replacing the result. */
  readonly result: (value: unknown) => Result;
  /** Trusted selection boundary; never expose the entire service bag by default. */
  readonly capabilities: (context: AspectContext) => Capabilities;
}

export class AspectExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AspectExecutionError";
  }
}

/** Command results are data; mutable native objects belong at the transport boundary. */
export function freezeAspectData<T>(value: T, ancestors = new Set<object>()): ReadonlyAspectData<T> {
  if (typeof value === "function" || typeof value === "symbol") throw new AspectExecutionError("ASPECT_RESULT_NOT_DATA");
  if (value !== null && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) {
      throw new AspectExecutionError("ASPECT_RESULT_NOT_DATA");
    }
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) throw new AspectExecutionError("ASPECT_RESULT_NOT_DATA");
      if (descriptor && "value" in descriptor) freezeAspectData(descriptor.value as unknown, ancestors);
    }
    ancestors.delete(value);
    Object.freeze(value);
  }
  return value as ReadonlyAspectData<T>;
}

/** One invocation, including lifetime and command-result integrity checks. */
export async function invokeAspect<Context extends { readonly kind: AspectKind }, Result>(
  context: Context,
  aspect: (context: Context, next: () => Promise<Result>) => Result | Promise<Result>,
  handler: () => Result | Promise<Result>,
  // Transport adapters can validate native responses without relaxing result identity.
  validateResult: (value: Result) => void = freezeAspectData,
): Promise<Result> {
  const strict = context.kind === "command";
  let active = true, called = false, settled = false, failed = false;
  let failure: unknown, value: Result | undefined;
  let pending: Promise<Result> | undefined;
  let violation: AspectExecutionError | undefined;
  const next = (): Promise<Result> => {
    if (!active || called) {
      violation = new AspectExecutionError(active ? "ASPECT_CONTINUATION_REUSED" : "ASPECT_CONTINUATION_CLOSED");
      return Promise.reject(violation);
    }
    called = true;
    pending = Promise.resolve().then(handler).then(result => {
      if (strict) validateResult(result);
      value = result;
      return result;
    });
    void pending.then(() => { settled = true; }, error => { settled = true; failed = true; failure = error; });
    return pending;
  };
  try {
    const result = await aspect(Object.freeze({ ...context }), next);
    if (pending && !settled) throw new AspectExecutionError("ASPECT_CONTINUATION_UNAWAITED");
    if (strict) {
      if (violation) throw violation;
      if (!called) throw new AspectExecutionError("ASPECT_CONTINUATION_REQUIRED");
      if (failed) throw failure;
      if (!Object.is(result, value)) throw new AspectExecutionError("ASPECT_RESULT_REPLACED");
    }
    return result;
  } finally {
    active = false;
    if (pending) await pending.catch(() => {});
  }
}

/** Static factory, not a registry. Decoders make the type-erased aspect entry safe. */
export function defineOperationAspect<Input, Result, Capabilities extends object>(
  contract: OperationAspectContract<Input, Result, Capabilities>,
  run: (context: OperationAspectContext<Input, Capabilities>, next: () => Promise<ReadonlyAspectData<Result>>) =>
    ReadonlyAspectData<Result> | Promise<ReadonlyAspectData<Result>>,
): Aspect {
  const { kind, name, input, result, capabilities } = contract;
  return (context, next) => invokeAspect(context, async (_context, proceed) => {
    if (context.kind !== kind || context.name !== name) throw new AspectExecutionError("ASPECT_OPERATION_MISMATCH");
    const narrowed = Object.freeze({
      kind, name, input: freezeAspectData(structuredClone(input(context.input))),
      capabilities: Object.freeze({ ...capabilities(context) }),
    });
    return await run(narrowed, async () => {
      const raw = await proceed();
      const decoded = result(raw);
      if (!Object.is(raw, decoded)) throw new AspectExecutionError("ASPECT_RESULT_DECODER_TRANSFORMED");
      return freezeAspectData(decoded);
    });
  }, next);
}
