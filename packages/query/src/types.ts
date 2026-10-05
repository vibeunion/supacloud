import type { DataTag } from "@tanstack/query-core";

export type QueryKey = readonly unknown[];

export interface QueryOptionsResult<TData = unknown> {
  queryKey: DataTag<QueryKey, TData>;
  queryFn: (context: { signal?: AbortSignal }) => Promise<TData>;
  meta: Record<string, unknown>;
}

export interface MutationOptionsResult<TData = unknown, TVariables = unknown> {
  mutationKey: QueryKey;
  mutationFn: (variables: TVariables) => Promise<TData>;
  retry: false;
  meta: Record<string, unknown>;
  onSuccess: (data: TData, variables: TVariables, context: unknown) => unknown | Promise<unknown>;
}

export interface QueryClientLike {
  invalidateQueries(filters: {
    queryKey?: QueryKey;
    predicate?: (query: { queryKey: QueryKey; meta?: Record<string, unknown> }) => boolean;
  }): Promise<void>;
}

export interface QueryAdapterOptions {
  /** Include project, tenant and actor identity; recreate after an identity change. */
  keyPrefix: readonly [string, ...string[]];
  queryClient?: QueryClientLike;
}
