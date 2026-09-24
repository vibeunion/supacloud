import type { PgSqlLike } from "@postgresx/noredis";

/**
 * Process-wide ceiling on concurrently held PostgreSQL work for the cache data
 * plane. Per-tenant Bun SQL pools cap how many connections a single tenant can
 * open (and open them lazily, so idle tenants stay near one); this budget caps
 * the aggregate so raising the per-tenant cap cannot exhaust the database.
 *
 * The budget wraps adapter operations, so a permit is held for the lifetime of
 * a transaction or a single statement. Permits are never acquired recursively:
 * transaction callbacks operate on the raw transaction handle.
 */
export interface DatabaseBudget {
  readonly limit: number;
  /** Resolves with a one-shot release function once a permit is available. */
  acquire(): Promise<() => void>;
  inFlight(): number;
}

export function createDatabaseBudget(limit: number): DatabaseBudget {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("database budget limit must be a positive integer");
  }
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  return {
    limit,
    inFlight: () => inFlight,
    async acquire() {
      if (inFlight >= limit) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        waiters.shift()?.();
      };
    },
  };
}

/** Wraps an adapter so every statement and transaction consumes one permit. */
export function createBudgetedAdapter(candidate: PgSqlLike, budget: DatabaseBudget): PgSqlLike {
  const runBudgeted = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await budget.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const adapter: PgSqlLike = {
    unsafe: <T = Record<string, unknown>>(query: string, params?: readonly unknown[]) =>
      runBudgeted(() => candidate.unsafe<T>(query, params)),
  };
  if (candidate.begin) {
    const begin = candidate.begin.bind(candidate);
    adapter.begin = <T>(operation: (transaction: PgSqlLike) => Promise<T>) =>
      runBudgeted(() => begin(operation));
  }
  return adapter;
}