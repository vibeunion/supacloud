export interface QueryEvent {
  readonly operation: string;
  readonly fingerprint?: string;
  readonly phase: "started" | "succeeded" | "failed";
  readonly durationMs?: number;
  readonly slow?: boolean;
}
export type QueryObserver = (event: Readonly<QueryEvent>) => void | Promise<void>;

export interface ReadQueryDefinition<Input, Result, Identity> {
  name: string;
  /** Parser-derived SQL fingerprint or a generated operation hash; never raw SQL. */
  fingerprint?: string;
  input(value: unknown): Input;
  result(value: unknown): Result;
  authorize(identity: Identity, input: NoInfer<Input>): "allow" | "deny" | Promise<"allow" | "deny">;
  execute(input: NoInfer<Input>, identity: Identity, signal?: AbortSignal): Promise<unknown>;
  observe?: QueryObserver;
  slowMs?: number;
  policy?: { execute<Value>(run: (signal: AbortSignal) => Promise<Value>, parent?: AbortSignal): Promise<Value> };
}

export class QueryBoundaryError extends Error {
  constructor(readonly code: "QUERY_INPUT_INVALID" | "QUERY_REJECTED" | "QUERY_AUTHORIZATION_FAILED" | "QUERY_RESULT_INVALID" | "QUERY_ABORTED" | "QUERY_TRANSPORT_FAILED") {
    super(code);
    this.name = "QueryBoundaryError";
  }
}

/** Explicit composition shared by SQL, pg_graphql and PostgREST. No DI, caching or SQL rewriting. */
export function defineReadQuery<Input, Result, Identity>(definition: ReadQueryDefinition<Input, Result, Identity>) {
  const contract = { ...definition };
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(contract.name)
    || (contract.fingerprint !== undefined && !/^[a-f0-9]{16,64}$/.test(contract.fingerprint))
    || (contract.slowMs !== undefined && (!Number.isFinite(contract.slowMs) || contract.slowMs < 0))) {
    throw new TypeError("Invalid query observation metadata");
  }
  const emit = (event: QueryEvent) => {
    try { Promise.resolve(contract.observe?.(Object.freeze(event))).catch(() => {}); } catch {}
  };
  const executeUnknown = async (identity: Identity, raw: unknown, signal?: AbortSignal): Promise<Result> => {
    if (signal?.aborted) throw new QueryBoundaryError("QUERY_ABORTED");
    let input: Input;
    try { input = contract.input(raw); } catch { throw new QueryBoundaryError("QUERY_INPUT_INVALID"); }
    let decision: unknown;
    try { decision = await contract.authorize(identity, input); }
    catch { throw new QueryBoundaryError("QUERY_AUTHORIZATION_FAILED"); }
    if (decision === "deny") throw new QueryBoundaryError("QUERY_REJECTED");
    if (decision !== "allow") throw new QueryBoundaryError("QUERY_AUTHORIZATION_FAILED");
    if (signal?.aborted) throw new QueryBoundaryError("QUERY_ABORTED");
    const started = performance.now();
    const metadata = { operation: contract.name, ...(contract.fingerprint ? { fingerprint: contract.fingerprint } : {}) };
    emit({ ...metadata, phase: "started" });
    try {
      const value = await contract.execute(input, identity, signal);
      if (signal?.aborted) throw new QueryBoundaryError("QUERY_ABORTED");
      let result: Result;
      try { result = contract.result(value); } catch { throw new QueryBoundaryError("QUERY_RESULT_INVALID"); }
      const durationMs = performance.now() - started;
      emit({ ...metadata, phase: "succeeded", durationMs, slow: durationMs >= (contract.slowMs ?? 500) });
      return result;
    } catch (error) {
      const durationMs = performance.now() - started;
      emit({ ...metadata, phase: "failed", durationMs, slow: durationMs >= (contract.slowMs ?? 500) });
      throw error;
    }
  };
  const execute = (identity: Identity, input: unknown, signal?: AbortSignal) => contract.policy
    ? contract.policy.execute((signal) => executeUnknown(identity, input, signal), signal)
    : executeUnknown(identity, input, signal);
  return Object.freeze({
    execute: (identity: Identity, input: Input, signal?: AbortSignal) => execute(identity, input, signal),
    executeUnknown: execute,
  });
}

/** Preserve the official client's selected/embedded result type; validate before returning it. */
export async function decodePostgrestQuery<Query extends PromiseLike<{ data: unknown; error: unknown }>>(
  query: Query,
  decode: (value: unknown) => NoInfer<Awaited<Query>["data"]>,
): Promise<Awaited<Query>["data"]> {
  const response = await query;
  if (response.error !== null) throw new QueryBoundaryError("QUERY_TRANSPORT_FAILED");
  try { return decode(response.data); } catch { throw new QueryBoundaryError("QUERY_RESULT_INVALID"); }
}
