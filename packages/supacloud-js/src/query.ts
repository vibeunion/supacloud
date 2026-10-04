import type {
  DataTag,
  DefaultError,
  MutationKey,
  MutationObserverOptions,
  QueryFunctionContext,
  QueryKey,
  QueryObserverOptions,
} from "@tanstack/query-core";

type Procedure<Kind extends "query" | "mutation"> = {
  readonly __supacloudProcedure: {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly kind: Kind;
    readonly idempotency: "none" | "required";
  };
  readonly __supacloudInput?: unknown;
};

type AnyProcedure = Procedure<"query" | "mutation">;

export type SupaCloudProcedureInput<TProcedure> = TProcedure extends {
  readonly __supacloudInput?: infer TInput;
} ? TInput : never;

export type SupaCloudProcedureResult<TProcedure> =
  TProcedure extends (...args: infer _Args) => Promise<infer TResult> ? TResult : unknown;

type ProcedureInput<TProcedure> = {} extends SupaCloudProcedureInput<TProcedure>
  ? SupaCloudProcedureInput<TProcedure> | undefined
  : SupaCloudProcedureInput<TProcedure>;

type QueryResult<TProcedure> = Exclude<SupaCloudProcedureResult<TProcedure>, undefined | void>
  | (undefined extends SupaCloudProcedureResult<TProcedure> ? null : never);

type TaggedQueryKey<TProcedure, TError = DefaultError> = DataTag<
  QueryKey,
  QueryResult<TProcedure>,
  TError
>;

export interface SupaCloudProcedureExecutionOptions {
  idempotencyKey?: string;
  /** Pass an existing CommandAttempt signal to bind a mutation to component lifetime. */
  signal?: AbortSignal;
}

export type SupaCloudMutationVariables<TProcedure extends Procedure<"mutation">> =
  ({} extends SupaCloudProcedureInput<TProcedure>
    ? { input?: SupaCloudProcedureInput<TProcedure> }
    : { input: SupaCloudProcedureInput<TProcedure> })
  & (TProcedure["__supacloudProcedure"]["idempotency"] extends "required"
    ? { execution: SupaCloudProcedureExecutionOptions & { idempotencyKey: string } }
    : { execution?: SupaCloudProcedureExecutionOptions });

export type SupaCloudQueryOptions<
  TProcedure extends Procedure<"query">,
  TError = DefaultError,
  TData = QueryResult<TProcedure>,
> = Omit<
  QueryObserverOptions<
    QueryResult<TProcedure>,
    TError,
    TData,
    QueryResult<TProcedure>,
    QueryKey
  >,
  "queryKey" | "queryFn" | "queryHash" | "queryKeyHashFn"
>;

export type SupaCloudMutationOptions<
  TProcedure extends Procedure<"mutation">,
  TError = DefaultError,
  TContext = unknown,
> = Omit<
  MutationObserverOptions<
    SupaCloudProcedureResult<TProcedure>,
    TError,
    SupaCloudMutationVariables<TProcedure>,
    TContext
  >,
  "mutationKey" | "mutationFn" | "retry"
>;

export type SupaCloudQueryOptionsResult<
  TProcedure extends Procedure<"query">,
  TError = DefaultError,
  TData = QueryResult<TProcedure>,
> = SupaCloudQueryOptions<TProcedure, TError, TData> & {
  queryKey: TaggedQueryKey<TProcedure, TError>;
  queryFn(context: QueryFunctionContext<QueryKey>): Promise<QueryResult<TProcedure>>;
};

export type SupaCloudMutationOptionsResult<
  TProcedure extends Procedure<"mutation">,
  TError = DefaultError,
  TContext = unknown,
> = SupaCloudMutationOptions<TProcedure, TError, TContext> & {
  mutationKey: MutationKey;
  mutationFn(variables: SupaCloudMutationVariables<TProcedure>): Promise<SupaCloudProcedureResult<TProcedure>>;
  retry: false;
};

export interface SupaCloudQueryAdapterOptions {
  /**
   * Include project, tenant and actor identity. Recreate the adapter when any
   * of those identities change so old cache entries cannot be reused.
   */
  keyPrefix: readonly [string, ...string[]];
}

function metadataOf<TProcedure extends AnyProcedure>(
  procedure: TProcedure,
  kind: "query" | "mutation",
): TProcedure["__supacloudProcedure"] {
  const metadata = procedure.__supacloudProcedure;
  if (!metadata || metadata.kind !== kind || typeof metadata.method !== "string"
    || typeof metadata.path !== "string" || !["none", "required"].includes(metadata.idempotency)) {
    throw new TypeError(`Expected a generated ${kind} procedure; regenerate the application client`);
  }
  return metadata;
}

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined || value === null
    || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Procedure input must be acyclic JSON data");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Procedure input must be JSON data");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => snapshot(item, ancestors) ?? null));
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, snapshot(item, ancestors)]),
    ));
  } finally {
    ancestors.delete(value);
  }
}

function callProcedure<TProcedure extends AnyProcedure>(
  procedure: TProcedure,
  input: unknown,
  execution: SupaCloudProcedureExecutionOptions,
): Promise<SupaCloudProcedureResult<TProcedure>> {
  const call = procedure as unknown as (
    input?: unknown,
    execution?: SupaCloudProcedureExecutionOptions,
  ) => Promise<SupaCloudProcedureResult<TProcedure>>;
  const signal = execution.signal;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason ?? new DOMException("Procedure cancelled", "AbortError"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    // Consume late failures even when the transport ignores cancellation.
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return call(input, execution);
    }).then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

export function createSupaCloudQueryAdapter({
  keyPrefix,
}: SupaCloudQueryAdapterOptions) {
  if (!Array.isArray(keyPrefix) || keyPrefix.length === 0
    || keyPrefix.some((part) => typeof part !== "string" || !part.trim())) {
    throw new TypeError("keyPrefix must contain nonempty identity values");
  }
  const prefix = Object.freeze(["supacloud", ...keyPrefix]);

  function procedureKey(
    procedure: AnyProcedure,
    kind: "query" | "mutation",
  ): QueryKey {
    const metadata = metadataOf(procedure, kind);
    return Object.freeze([...prefix, kind, metadata.method, metadata.path]);
  }

  function queryKey<TProcedure extends Procedure<"query">>(procedure: TProcedure): QueryKey;
  function queryKey<TProcedure extends Procedure<"query">>(
    procedure: TProcedure, input: NoInfer<ProcedureInput<TProcedure>>,
  ): TaggedQueryKey<TProcedure>;
  function queryKey<TProcedure extends Procedure<"query">>(
    procedure: TProcedure, ...args: [ProcedureInput<TProcedure>?]
  ): QueryKey {
    if (args.length === 0) return procedureKey(procedure, "query");
    return Object.freeze([
      ...procedureKey(procedure, "query"),
      snapshot(args[0] ?? {}),
    ]);
  }

  function queryOptions<TProcedure extends Procedure<"query">, TError = DefaultError, TData = QueryResult<TProcedure>>(
    procedure: TProcedure,
    input: NoInfer<ProcedureInput<TProcedure>>,
    options?: SupaCloudQueryOptions<NoInfer<TProcedure>, TError, TData>,
  ): SupaCloudQueryOptionsResult<TProcedure, TError, TData> {
    const capturedInput = snapshot(input ?? {});
    return {
      ...options,
      queryKey: Object.freeze([
        ...procedureKey(procedure, "query"),
        capturedInput,
      ]) as TaggedQueryKey<TProcedure, TError>,
      queryFn: async ({ signal }: QueryFunctionContext<QueryKey>) => {
        const result = await callProcedure(procedure, capturedInput, { signal });
        return (result === undefined ? null : result) as QueryResult<TProcedure>;
      },
    };
  }

  function mutationOptions<TProcedure extends Procedure<"mutation">, TError = DefaultError, TContext = unknown>(
    procedure: TProcedure,
    options?: SupaCloudMutationOptions<NoInfer<TProcedure>, TError, TContext>,
  ): SupaCloudMutationOptionsResult<TProcedure, TError, TContext> {
    const metadata = metadataOf(procedure, "mutation");
    return {
      ...options,
      mutationKey: procedureKey(procedure, "mutation") as MutationKey,
      // A failed or uncertain write must never be replayed by Query defaults.
      retry: false as const,
      mutationFn: async (variables: SupaCloudMutationVariables<TProcedure>) => {
        const execution = variables.execution ?? {};
        const key = execution.idempotencyKey;
        if ((metadata.idempotency === "required" && key === undefined)
          || (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(key)))) {
          throw new TypeError("This mutation requires a valid idempotencyKey");
        }
        return callProcedure(procedure, variables.input, execution);
      },
    };
  }

  return {
    queryKey,
    queryOptions,
    mutationKey: (procedure: Procedure<"mutation">) => procedureKey(procedure, "mutation"),
    mutationOptions,
  };
}
