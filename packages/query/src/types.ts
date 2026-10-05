export type QueryKey = readonly unknown[];

export interface QueryOptionsResult<TData = unknown> {
  queryKey: QueryKey;
  queryFn: (context: { signal?: AbortSignal }) => Promise<TData>;
  meta?: Record<string, unknown>;
}

export interface MutationOptionsResult<TData = unknown, TVariables = unknown> {
  mutationKey: QueryKey;
  mutationFn: (variables: TVariables) => Promise<TData>;
  meta?: Record<string, unknown>;
  onSuccess?: (data: TData, variables: TVariables, context: unknown) => unknown | Promise<unknown>;
}

export interface QueryClientLike {
  invalidateQueries(filters: {
    predicate?: (query: { queryKey: readonly unknown[]; meta?: Record<string, unknown> }) => boolean;
  }): Promise<void>;
}

export interface QueryAdapterOptions {
  /** Optional custom base key prefix, e.g. ["my-app"] */
  keyPrefix?: readonly unknown[];
  /** Optional TanStack QueryClient instance to bind for automatic tag invalidation */
  queryClient?: QueryClientLike;
}
