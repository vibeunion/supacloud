interface ExecutableSqlQuery<T> {
  execute(): PromiseLike<T>;
}

interface ActiveSqlQuery {
  query: ExecutableSqlQuery<unknown>;
  cancel: () => Promise<boolean>;
  startedAt: number;
  cancellationRequest?: Promise<boolean>;
}

export interface RegisteredSqlQuery<T> {
  projectRef: string;
  queryId: string;
  query: ExecutableSqlQuery<T>;
  cancel: () => Promise<boolean>;
  startedAt: number;
}

export interface SqlQueryCancellation {
  cancelled: boolean;
  durationMs: number;
}

export class SqlQueryAlreadyRunningError extends Error {
  readonly code = "QUERY_ID_ALREADY_ACTIVE";

  constructor() {
    super("A SQL query with this query_id is already running");
    this.name = "SqlQueryAlreadyRunningError";
  }
}

export class ConfirmedSqlQueryCancellationError extends Error {
  readonly code = "QUERY_CANCELLED";

  constructor(cause: unknown) {
    super("Query cancelled", { cause });
    this.name = "ConfirmedSqlQueryCancellationError";
  }
}

const activeSqlQueries = new Map<string, ActiveSqlQuery>();

function activeQueryKey(projectRef: string, queryId: string): string {
  return `${projectRef}\0${queryId}`;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function registerActiveSqlQuery(registration: RegisteredSqlQuery<unknown>): void {
  const { projectRef, queryId, query, cancel, startedAt } = registration;
  const key = activeQueryKey(projectRef, queryId);
  if (activeSqlQueries.has(key)) throw new SqlQueryAlreadyRunningError();
  activeSqlQueries.set(key, { query, cancel, startedAt });
}

function unregisterActiveSqlQuery(projectRef: string, queryId: string, query: ExecutableSqlQuery<unknown>): void {
  const key = activeQueryKey(projectRef, queryId);
  if (activeSqlQueries.get(key)?.query === query) activeSqlQueries.delete(key);
}

export async function runRegisteredSqlQuery<T>(registration: RegisteredSqlQuery<T>): Promise<T> {
  const { projectRef, queryId, query } = registration;
  const key = activeQueryKey(projectRef, queryId);
  registerActiveSqlQuery(registration);
  try {
    return await query.execute();
  } catch (error) {
    const activeQuery = activeSqlQueries.get(key);
    const cancellationConfirmed = activeQuery?.query === query && activeQuery.cancellationRequest
      ? await activeQuery.cancellationRequest.then((cancelled) => cancelled, () => false)
      : false;
    if (cancellationConfirmed) throw new ConfirmedSqlQueryCancellationError(error);
    throw error;
  } finally {
    const activeQuery = activeSqlQueries.get(key);
    if (activeQuery?.query === query && activeQuery.cancellationRequest) {
      await Promise.allSettled([activeQuery.cancellationRequest]);
    }
    unregisterActiveSqlQuery(projectRef, queryId, query);
  }
}

export async function cancelActiveSqlQuery(
  projectRef: string,
  queryId: string,
): Promise<SqlQueryCancellation | null> {
  const activeQuery = activeSqlQueries.get(activeQueryKey(projectRef, queryId));
  if (!activeQuery) return null;
  const cancellationRequest = activeQuery.cancellationRequest ?? activeQuery.cancel();
  activeQuery.cancellationRequest = cancellationRequest;
  try {
    const cancelled = await cancellationRequest;
    if (!cancelled && activeQuery.cancellationRequest === cancellationRequest) {
      activeQuery.cancellationRequest = undefined;
    }
    return {
      cancelled,
      durationMs: elapsedMilliseconds(activeQuery.startedAt),
    };
  } catch (error) {
    if (activeQuery.cancellationRequest === cancellationRequest) {
      activeQuery.cancellationRequest = undefined;
    }
    throw error;
  }
}

export function clearActiveSqlQueriesForTests(): void {
  activeSqlQueries.clear();
}
