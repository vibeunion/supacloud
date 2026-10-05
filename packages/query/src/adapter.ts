import type {
  QueryAdapterOptions, QueryClientLike, QueryKey, QueryOptionsResult, MutationOptionsResult,
} from "./types.js";
import { invalidateByTags } from "./invalidation.js";

type Procedure<Kind extends "query" | "mutation"> = ((...args: never[]) => Promise<unknown>) & {
  readonly __supacloudProcedure: {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly kind: Kind;
    readonly idempotency: "none" | "required";
  };
  readonly __supacloudInput?: unknown;
};
export type ProcedureQueryLike = Procedure<"query">;
export type ProcedureMutateLike = Procedure<"mutation">;
type AnyProcedure = Procedure<"query" | "mutation">;
type ProcedureMap = Record<string, Record<string, { query: ProcedureQueryLike } | { mutate: ProcedureMutateLike }>>;
export type ProcedureSource = ProcedureMap | { procedureClient: ProcedureMap };
export type ProceduresOf<T> = T extends { procedureClient: infer P } ? P : T;
type Input<P> = P extends { readonly __supacloudInput?: infer I } ? I : never;
type Result<P> = P extends (...args: never[]) => Promise<infer R> ? R : never;
type QueryResult<P> = Exclude<Result<P>, undefined | void> | (undefined extends Result<P> ? null : never);
type Execution = { signal?: AbortSignal; idempotencyKey?: string };
type Variables<P extends ProcedureMutateLike> =
  ({} extends Input<P> ? { input?: Input<P> } : { input: Input<P> })
  & (P["__supacloudProcedure"]["idempotency"] extends "required"
    ? { execution: Execution & { idempotencyKey: string } }
    : { execution?: Execution });

export interface QueryProcedureAdapter<P extends ProcedureQueryLike> {
  queryKey(): QueryKey;
  queryKey(input: Input<P>): QueryOptionsResult<QueryResult<P>>["queryKey"];
  queryOptions(
    input: {} extends Input<P> ? Input<P> | undefined : Input<P>,
    options?: { meta?: Record<string, unknown>; tags?: readonly string[] },
  ): QueryOptionsResult<QueryResult<P>>;
}

export interface MutateProcedureAdapter<P extends ProcedureMutateLike> {
  mutationKey(): QueryKey;
  mutationOptions(options?: {
    invalidateTags?: readonly string[];
    queryClient?: QueryClientLike;
    meta?: Record<string, unknown>;
    onSuccess?: (data: Result<P>, variables: Variables<P>, context: unknown) => unknown | Promise<unknown>;
  }): MutationOptionsResult<Result<P>, Variables<P>>;
}

export type QueryAdapter<T> = {
  [C in keyof ProceduresOf<T>]: {
    [H in keyof ProceduresOf<T>[C]]: ProceduresOf<T>[C][H] extends { query: infer P extends ProcedureQueryLike }
      ? QueryProcedureAdapter<P>
      : ProceduresOf<T>[C][H] extends { mutate: infer P extends ProcedureMutateLike }
        ? MutateProcedureAdapter<P> : never;
  };
} & { invalidateByTags(tags: string | readonly string[], client?: QueryClientLike): Promise<void> };

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Input must be acyclic JSON data");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Input must be JSON data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors) ?? null));
    return Object.freeze(Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, snapshot(item, ancestors)])));
  } finally {
    ancestors.delete(value);
  }
}

function identityPrefix(prefix: readonly [string, ...string[]]): readonly string[] {
  if (!Array.isArray(prefix) || prefix.length === 0 || prefix.some((part) => typeof part !== "string" || !part.trim())) {
    throw new TypeError("keyPrefix must contain nonempty identity values");
  }
  return Object.freeze(["supacloud", ...prefix]);
}

export function createQueryKey(operationId: string, input: unknown, keyPrefix: readonly [string, ...string[]]): QueryKey {
  return Object.freeze([...identityPrefix(keyPrefix), operationId, snapshot(input)]);
}

export function createProcedureClient<T extends ProcedureSource>(client: T): ProceduresOf<T> {
  const candidate: unknown = Object.hasOwn(client, "procedureClient") ? client.procedureClient : undefined;
  return (candidate !== undefined ? candidate : client) as ProceduresOf<T>;
}

function call<P extends AnyProcedure>(procedure: P, input: unknown, execution: Execution): Promise<Result<P>> {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) throw new TypeError("Invalid execution options");
  const { signal, idempotencyKey } = execution;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid AbortSignal");
  if ((procedure.__supacloudProcedure.idempotency === "required" && idempotencyKey === undefined)
    || (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(idempotencyKey)))) {
    throw new TypeError("A valid idempotencyKey is required");
  }
  const captured = Object.freeze({ ...execution });
  // Public types retain each generated tuple; this bridges the shared invocation.
  const invoke = procedure as unknown as (input: unknown, execution: Execution) => Promise<Result<P>>;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Procedure cancelled", "AbortError"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return invoke(input, captured); })
      .then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

export function createQueryAdapter<T extends ProcedureSource>(client: T, options: QueryAdapterOptions): QueryAdapter<T> {
  const prefix = identityPrefix(options.keyPrefix);
  const source = createProcedureClient(client) as ProcedureMap;
  const result: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [controller, handlers] of Object.entries(source)) {
    if (controller === "invalidateByTags") throw new TypeError("Reserved controller name: invalidateByTags");
    const mapped: Record<string, unknown> = Object.create(null);
    result[controller] = mapped;
    for (const [name, member] of Object.entries(handlers)) {
      const procedure = "query" in member ? member.query : member.mutate;
      if (procedure === undefined) throw new TypeError("Expected a generated procedure");
      const metadata = procedure.__supacloudProcedure;
      if (typeof procedure !== "function" || !metadata || metadata.kind !== ("query" in member ? "query" : "mutation")
        || typeof metadata.key !== "string" || typeof metadata.method !== "string"
        || typeof metadata.path !== "string" || !["none", "required"].includes(metadata.idempotency)) {
        throw new TypeError("Expected a generated procedure");
      }
      const key = Object.freeze([...prefix, metadata.kind, metadata.method, metadata.path]);
      if ("query" in member) {
        const proc = member.query;
        mapped[name] = {
          queryKey: (...args: unknown[]) => args.length ? Object.freeze([...key, snapshot(args[0] ?? {})]) : key,
          queryOptions: (input: Input<typeof proc>, opts?: { meta?: Record<string, unknown>; tags?: readonly string[] }) => {
            const captured = snapshot(input ?? {});
            return {
              queryKey: Object.freeze([...key, captured]) as QueryOptionsResult<QueryResult<typeof proc>>["queryKey"],
              queryFn: async ({ signal }: { signal?: AbortSignal }) => (await call(proc, captured, { signal })) ?? null,
              meta: { ...opts?.meta, tags: Object.freeze([...(opts?.tags ?? [])]) },
            };
          },
        };
      } else {
        const proc = member.mutate;
        if (proc === undefined) throw new TypeError("Expected a generated mutation");
        mapped[name] = {
          mutationKey: () => key,
          mutationOptions: (opts?: {
            invalidateTags?: readonly string[];
            queryClient?: QueryClientLike;
            meta?: Record<string, unknown>;
            onSuccess?: (data: Result<typeof proc>, variables: Variables<typeof proc>, context: unknown) => unknown | Promise<unknown>;
          }) => ({
            mutationKey: key,
            retry: false,
            mutationFn: async (variables: Variables<typeof proc>) => call(proc, variables.input, variables.execution === undefined ? {} : variables.execution),
            meta: { ...opts?.meta },
            onSuccess: async (data: Result<typeof proc>, variables: Variables<typeof proc>, context: unknown) => {
              const target = opts?.queryClient ?? options.queryClient;
              if (opts?.invalidateTags?.length && target === undefined) throw new Error("No QueryClient provided for invalidation");
              if (target !== undefined && opts?.invalidateTags?.length) await invalidateByTags(target, opts.invalidateTags, prefix);
              return opts?.onSuccess?.(data, variables, context);
            },
          }),
        };
      }
    }
  }
  return Object.assign(result, {
    invalidateByTags: (tags: string | readonly string[], clientForInvalidation?: QueryClientLike) => {
      const target = clientForInvalidation ?? options.queryClient;
      if (target === undefined) throw new Error("No QueryClient provided for invalidateByTags");
      return invalidateByTags(target, tags, prefix);
    },
  }) as QueryAdapter<T>;
}
