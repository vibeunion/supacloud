import { isCancelledError, QueryObserver, type QueryClient } from "@tanstack/query-core";
import type { QueryOptionsResult } from "./types.js";

export interface FetchQueryResultOptions<Raw, Result> {
  decode: (value: Raw) => Result | Promise<Result>;
  signal?: AbortSignal;
  /** Freshness of shared raw data, not a bypass for the caller's decoder. */
  staleTime?: number;
  /** Sensitive responses can bypass both cache reads and cache writes. */
  cache?: "shared" | "none";
  /** Cancel the previous same-key fetch and request a fresh snapshot. */
  refresh?: boolean;
}

/**
 * Share transport and raw cache data, never a caller's decoded result.
 * Each pending caller owns a native observer so cancellation remains local
 * until the last observer leaves.
 */
export async function fetchQueryResult<Raw, Result>(
  client: QueryClient,
  query: QueryOptionsResult<Raw>,
  options: FetchQueryResultOptions<NoInfer<Raw>, Result>,
): Promise<Result> {
  const { decode, signal, staleTime = 0, cache = "shared", refresh = false } = options;
  signal?.throwIfAborted();
  if (typeof decode !== "function") throw new TypeError("A query result decoder is required");
  if (typeof staleTime !== "number" || staleTime < 0 || Number.isNaN(staleTime)) throw new TypeError("Invalid staleTime");
  if (cache !== "shared" && cache !== "none") throw new TypeError("Invalid cache policy");

  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(isCancelledError(cause) ? new DOMException("Query cancelled", "AbortError") : cause);
    };
    const abort = () => fail(signal?.reason ?? new DOMException("Query cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    const run = async () => {
      let raw: Raw;
      if (cache === "none") {
        raw = await query.queryFn({ signal });
      } else {
        if (refresh) {
          await client.cancelQueries({ queryKey: query.queryKey, exact: true });
          if (settled) return;
          await client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
          if (settled) return;
        }
        const fetchOptions = {
          queryKey: query.queryKey,
          // Consume the native signal even when the transport ignores it:
          // TanStack must discard a late response after the last caller leaves.
          queryFn: ({ signal: transportSignal }: { signal: AbortSignal }) => query.queryFn({ signal: transportSignal }),
          meta: query.meta,
          staleTime,
          retry: false as const,
        };
        const observer = new QueryObserver(client, { ...fetchOptions, enabled: false });
        unsubscribe = observer.subscribe(() => {});
        if (settled) {
          unsubscribe();
          return;
        }
        raw = await client.fetchQuery(fetchOptions);
      }
      if (settled) return;
      const result = await decode(raw);
      if (settled) return;
      signal?.throwIfAborted();
      settled = true;
      cleanup();
      resolve(result);
    };
    void run().catch(fail);
  });
}
