import { AsyncLocalStorage } from "node:async_hooks";

export interface PgredisRuntimeEndpointConfig {
  baseUrl: string;
  signingSecret: string;
  timeoutMs: number;
  capabilityTtlMs: number;
}

export interface PgredisRuntimeBindingConfig {
  baseUrl: string;
  capabilityToken: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PgredisCacheBinding {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlMs?: number | null): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  ttl(key: string): Promise<number | null>;
  getset<T = unknown>(key: string, value: T): Promise<T | null>;
  getdel<T = unknown>(key: string): Promise<T | null>;
}

export class PgredisBindingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PgredisBindingError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ActiveContext extends PgredisRuntimeBindingConfig {
  active: boolean;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export class PgredisBindingController {
  readonly facade: PgredisCacheBinding;
  private readonly contexts = new AsyncLocalStorage<ActiveContext>();

  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.facade = Object.freeze({
      get: <T = unknown>(key: string) =>
        this.call<{ value: T | null }>({ op: "get", key }).then((result) => result.value),
      set: <T = unknown>(key: string, value: T, ttlMs?: number | null) =>
        this.call<{ written: boolean }>({ op: "set", key, value, ttlMs }).then((result) => result.written),
      delete: (key: string) => this.call<{ deleted: boolean }>({ op: "delete", key }).then((result) => result.deleted),
      ttl: (key: string) => this.call<{ ttlMs: number | null }>({ op: "ttl", key }).then((result) => result.ttlMs),
      getset: <T = unknown>(key: string, value: T) =>
        this.call<{ value: T | null }>({ op: "getset", key, value }).then((result) => result.value),
      getdel: <T = unknown>(key: string) =>
        this.call<{ value: T | null }>({ op: "getdel", key }).then((result) => result.value),
    });
  }

  async run<T>(config: PgredisRuntimeBindingConfig | undefined, operation: () => Promise<T>): Promise<T> {
    if (!config) return operation();
    const context: ActiveContext = {
      ...config,
      baseUrl: normalizeBaseUrl(config.baseUrl),
      active: true,
    };
    return this.contexts.run(context, async () => {
      try {
        return await operation();
      } finally {
        context.active = false;
      }
    });
  }

  private async call<T>(payload: Record<string, unknown>): Promise<T> {
    const context = this.contexts.getStore();
    if (!context?.active) {
      throw new PgredisBindingError("pgredis binding is unavailable outside a request");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${context.baseUrl}/internal/v1/cache`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${context.capabilityToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: context.signal
            ? AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)])
            : AbortSignal.timeout(context.timeoutMs),
        },
      );
    } catch {
      throw new PgredisBindingError("pgredis runtime request failed");
    }
    if (!response.ok) {
      throw new PgredisBindingError("pgredis runtime request failed", response.status);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new PgredisBindingError("pgredis runtime returned an invalid response");
    }
  }
}

export const pgredisBindingController = new PgredisBindingController();

const globalRuntime = globalThis as typeof globalThis & {
  SupaCloud?: { pgredis: PgredisCacheBinding };
};

if (!globalRuntime.SupaCloud) {
  Object.defineProperty(globalRuntime, "SupaCloud", {
    configurable: false,
    enumerable: true,
    value: Object.freeze({ pgredis: pgredisBindingController.facade }),
    writable: false,
  });
}

export function runWithPgredisBinding<T>(
  config: PgredisRuntimeBindingConfig | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return pgredisBindingController.run(config, operation);
}
