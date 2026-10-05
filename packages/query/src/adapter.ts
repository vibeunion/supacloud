import type {
  QueryAdapterOptions,
  QueryClientLike,
  QueryKey,
  QueryOptionsResult,
  MutationOptionsResult,
} from "./types";
import { invalidateByTags } from "./invalidation";

function sortObjectKeys(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortObjectKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Creates a deterministic, sorted QueryKey for an operation.
 */
export function createQueryKey(
  operationId: string,
  input?: unknown,
  keyPrefix?: readonly unknown[],
): QueryKey {
  const prefix = keyPrefix ?? [];
  if (input === undefined || input === null) {
    return [...prefix, operationId];
  }
  return [...prefix, operationId, sortObjectKeys(input)];
}

export interface ProcedureQueryLike<Input = unknown, Result = unknown> {
  (input?: Input, options?: unknown): Promise<Result>;
  query?: (input?: Input, options?: unknown) => Promise<Result>;
  readonly operationId: string;
  readonly kind: "query";
  readonly tags: readonly string[];
}

export interface ProcedureMutateLike<Input = unknown, Result = unknown> {
  (input?: Input, options?: unknown): Promise<Result>;
  mutate?: (input?: Input, options?: unknown) => Promise<Result>;
  readonly operationId: string;
  readonly kind: "command";
  readonly tags: readonly string[];
  readonly commandName?: string;
  readonly idempotency?: "required" | "none";
}

export interface QueryProcedureAdapter<Input, Result> {
  queryKey(input?: Input): QueryKey;
  queryOptions(
    input?: Input,
    options?: { meta?: Record<string, unknown> },
  ): QueryOptionsResult<Result>;
}

export interface MutateProcedureAdapter<Input, Result> {
  mutationKey(): QueryKey;
  mutationOptions(options?: {
    invalidateTags?: readonly string[];
    queryClient?: QueryClientLike;
    meta?: Record<string, unknown>;
    onSuccess?: (
      data: Result,
      variables: { input?: Input; options?: unknown },
      context: unknown,
    ) => unknown | Promise<unknown>;
  }): MutationOptionsResult<Result, { input?: Input; options?: unknown }>;
}

export function createQueryAdapter<
  TClient extends { procedures: Record<string, Record<string, any>> } | Record<string, Record<string, any>>,
>(
  client: TClient,
  adapterOptions?: QueryAdapterOptions,
): any {
  const procedures = ((client as any)?.procedures ?? client) as Record<string, Record<string, any>>;
  const result: Record<string, Record<string, any>> = {};

  for (const [controllerKey, handlers] of Object.entries(procedures)) {
    result[controllerKey] = {};
    for (const [handlerKey, proc] of Object.entries(handlers)) {
      if (proc.kind === "query") {
        result[controllerKey][handlerKey] = {
          queryKey: (input?: any) => createQueryKey(proc.operationId, input, adapterOptions?.keyPrefix),
          queryOptions: (input?: any, opts?: any) => ({
            queryKey: createQueryKey(proc.operationId, input, adapterOptions?.keyPrefix),
            queryFn: ({ signal }: { signal?: AbortSignal }) => (proc.query ?? proc)(input, { signal }),
            meta: {
              operationId: proc.operationId,
              tags: proc.tags,
              ...opts?.meta,
            },
            ...opts,
          }),
        };
      } else {
        result[controllerKey][handlerKey] = {
          mutationKey: () => [...(adapterOptions?.keyPrefix ?? []), proc.operationId],
          mutationOptions: (opts?: any) => ({
            mutationKey: [...(adapterOptions?.keyPrefix ?? []), proc.operationId],
            mutationFn: (variables: { input?: any; options?: any } | any) => {
              const input = variables && typeof variables === "object" && "input" in variables ? variables.input : variables;
              const options = variables && typeof variables === "object" && "options" in variables ? variables.options : undefined;
              return (proc.mutate ?? proc)(input, options);
            },
            meta: {
              operationId: proc.operationId,
              tags: proc.tags,
              invalidateTags: opts?.invalidateTags,
              ...opts?.meta,
            },
            onSuccess: async (data: any, vars: any, ctx: any) => {
              const targetClient = opts?.queryClient ?? adapterOptions?.queryClient;
              if (targetClient && opts?.invalidateTags?.length) {
                await invalidateByTags(targetClient, opts.invalidateTags);
              }
              return opts?.onSuccess?.(data, vars, ctx);
            },
            ...opts,
          }),
        };
      }
    }
  }

  return {
    ...result,
    invalidateByTags: (tags: string | readonly string[], qc?: QueryClientLike) => {
      const target = qc ?? adapterOptions?.queryClient;
      if (!target) throw new Error("No QueryClient provided for invalidateByTags");
      return invalidateByTags(target, tags);
    },
  };
}
