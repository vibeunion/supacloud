import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationError, createApplication, requireIdempotencyKey,
  type ApplicationOptions, type CommandGovernance, type CommandInvocation, type TrustedRequestIdentity,
} from "./index";
import { createMemoryPolicy, type MemoryPolicy } from "./memory_policy";

export interface HandleLike {
  handle(request: Request): Promise<Response> | Response;
}

export interface MemoryDatabase {
  get(table: string, key: string): unknown;
  set(table: string, key: string, value: unknown): void;
  delete(table: string, key: string): boolean;
  list(table: string): Array<{ key: string; value: unknown }>;
  clear(): void;
  transaction<T>(work: (tx: MemoryDatabase) => T | Promise<T>): Promise<T>;
}

export interface MemoryStorageObject {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType?: string;
  metadata: Record<string, string>;
}

export interface MemoryStorage {
  put(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): void;
  get(bucket: string, key: string): MemoryStorageObject | undefined;
  delete(bucket: string, key: string): boolean;
  list(bucket: string, prefix?: string): MemoryStorageObject[];
  clear(): void;
  failNext(error?: Error): void;
  setPolicy(policy?: (operation: "put" | "get" | "delete" | "list", bucket: string, key: string) => boolean): void;
}

export interface MemorySandboxOptions extends Omit<ApplicationOptions, "deps" | "requestContext"> {
  /** Stable identity used by every request unless overridden by requestContext. */
  identity?: TrustedRequestIdentity;
  /** Stable request id used when the request does not provide x-request-id. */
  requestId?: string;
  /** Extend the platform dependency bag without replacing memory dependencies. */
  deps?: Record<string, unknown>;
  /** Replace the default deterministic request context factory. */
  requestContext?: ApplicationOptions["requestContext"];
  /** Enable the test-only permission, receipt, transaction and audit adapters. */
  memoryGovernance?: boolean;
}

export interface MemorySandbox {
  app: HandleLike;
  db: MemoryDatabase;
  storage: MemoryStorage;
  policy: MemoryPolicy;
  audit: Array<{ command: string; outcome: "succeeded" | "failed" }>;
  identity: TrustedRequestIdentity;
  request(path: string, init?: RequestInit): Promise<Response>;
  reset(): void;
}

class DefaultMemoryDatabase implements MemoryDatabase {
  private readonly tables = new Map<string, Map<string, unknown>>();
  private version = 0;
  private readonly current = new AsyncLocalStorage<MemoryDatabase>();

  get(table: string, key: string): unknown {
    if (this.current.getStore()) return this.current.getStore()?.get(table, key);
    const value = this.tables.get(table)?.get(key);
    return value === undefined ? undefined : cloneValue(value);
  }

  set(table: string, key: string, value: unknown): void {
    const current = this.current.getStore();
    if (current) return current.set(table, key, value);
    const rows = this.tables.get(table) ?? new Map<string, unknown>();
    rows.set(key, cloneValue(value));
    this.tables.set(table, rows);
    this.version += 1;
  }

  delete(table: string, key: string): boolean {
    const current = this.current.getStore();
    if (current) return current.delete(table, key);
    const deleted = this.tables.get(table)?.delete(key) ?? false;
    if (deleted) this.version += 1;
    return deleted;
  }

  list(table: string): Array<{ key: string; value: unknown }> {
    const current = this.current.getStore();
    if (current) return current.list(table);
    return [...(this.tables.get(table)?.entries() ?? [])]
      .map(([key, value]) => ({ key, value: cloneValue(value) }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  clear(): void {
    const current = this.current.getStore();
    if (current) return current.clear();
    this.tables.clear();
    this.version += 1;
  }

  async transaction<T>(work: (tx: MemoryDatabase) => T | Promise<T>): Promise<T> {
    if (this.current.getStore()) throw new Error("Nested memory transactions are not supported");
    const baseVersion = this.version;
    const snapshot = cloneTables(this.tables);
    const transaction = new SnapshotMemoryDatabase(snapshot);
    try {
      const result = await this.current.run(transaction, () => work(transaction));
      if (this.version !== baseVersion) {
        throw new Error("Memory transaction conflict: state changed during transaction");
      }
      const committed = cloneTables(transaction.tables);
      this.tables.clear();
      for (const [table, rows] of committed) this.tables.set(table, rows);
      this.version += 1;
      return result;
    } finally {
      transaction.close();
    }
  }
}

class SnapshotMemoryDatabase implements MemoryDatabase {
  private closed = false;
  constructor(readonly tables: Map<string, Map<string, unknown>>) {}
  close(): void { this.closed = true; }
  private assertOpen(): void {
    if (this.closed) throw new Error("Memory transaction is closed");
  }

  get(table: string, key: string): unknown {
    this.assertOpen();
    const value = this.tables.get(table)?.get(key);
    return value === undefined ? undefined : cloneValue(value);
  }

  set(table: string, key: string, value: unknown): void {
    this.assertOpen();
    const rows = this.tables.get(table) ?? new Map<string, unknown>();
    rows.set(key, cloneValue(value));
    this.tables.set(table, rows);
  }

  delete(table: string, key: string): boolean {
    this.assertOpen();
    return this.tables.get(table)?.delete(key) ?? false;
  }

  list(table: string): Array<{ key: string; value: unknown }> {
    this.assertOpen();
    return [...(this.tables.get(table)?.entries() ?? [])]
      .map(([key, value]) => ({ key, value: cloneValue(value) }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  clear(): void {
    this.assertOpen();
    this.tables.clear();
  }

  transaction<T>(): Promise<T> {
    return Promise.reject(new Error("Nested memory transactions are not supported"));
  }
}

class DefaultMemoryStorage implements MemoryStorage {
  private readonly objects = new Map<string, MemoryStorageObject>();
  private pendingFailure?: Error;
  private policy?: Parameters<MemoryStorage["setPolicy"]>[0];

  put(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    options: { contentType?: string; metadata?: Record<string, string> } = {},
  ): void {
    this.check("put", bucket, key);
    this.objects.set(storageKey(bucket, key), {
      bucket,
      key,
      body: typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body),
      contentType: options.contentType,
      metadata: { ...(options.metadata ?? {}) },
    });
  }

  get(bucket: string, key: string): MemoryStorageObject | undefined {
    this.check("get", bucket, key);
    const object = this.objects.get(storageKey(bucket, key));
    return object ? cloneObject(object) : undefined;
  }

  delete(bucket: string, key: string): boolean {
    this.check("delete", bucket, key);
    return this.objects.delete(storageKey(bucket, key));
  }

  list(bucket: string, prefix = ""): MemoryStorageObject[] {
    this.check("list", bucket, prefix);
    return [...this.objects.values()]
      .filter((object) => object.bucket === bucket && object.key.startsWith(prefix))
      .filter((object) => !this.policy || this.policy("get", object.bucket, object.key))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneObject);
  }

  clear(): void {
    this.objects.clear();
    this.pendingFailure = undefined;
  }

  failNext(error = new Error("Memory storage failure")): void { this.pendingFailure = error; }
  setPolicy(policy?: Parameters<MemoryStorage["setPolicy"]>[0]): void { this.policy = policy; }

  private check(operation: "put" | "get" | "delete" | "list", bucket: string, key: string): void {
    if (this.pendingFailure) {
      const error = this.pendingFailure;
      this.pendingFailure = undefined;
      throw error;
    }
    if (this.policy && !this.policy(operation, bucket, key)) {
      throw new ApplicationError("Memory storage access denied", { status: 403, code: "MEMORY_STORAGE_DENIED" });
    }
  }
}

/**
 * Creates a deterministic in-process application harness.
 *
 * The database and storage are intentionally small adapter contracts, not
 * PostgreSQL or S3 emulators. They are sufficient for fast command and HTTP
 * behavior tests while keeping production adapters replaceable.
 */
export function createMemorySandbox(options: MemorySandboxOptions = {}): MemorySandbox {
  const db = new DefaultMemoryDatabase();
  const storage = new DefaultMemoryStorage();
  const policy = createMemoryPolicy();
  const audit: MemorySandbox["audit"] = [];
  const governance: CommandGovernance = {
    authorize(invocation) {
      const subject = policy.subject(invocation.requestContext);
      if (!invocation.command.permission || !policy.can(subject, invocation.command.permission)) {
        throw new ApplicationError("Memory permission denied", { status: 403, code: "MEMORY_PERMISSION_DENIED" });
      }
    },
    idempotency(invocation, next) {
      return policy.runOnce(
        policy.subject(invocation.requestContext), invocation.command.name,
        requireIdempotencyKey(invocation), memoryCommandInput(invocation), next,
      );
    },
    transaction(_invocation, next) {
      const count = audit.length;
      return db.transaction(() => next()).catch((error) => {
        audit.splice(count);
        throw error;
      });
    },
    audit: {
      succeeded(invocation) { audit.push({ command: invocation.command.name, outcome: "succeeded" }); },
      failed(invocation) { audit.push({ command: invocation.command.name, outcome: "failed" }); },
    },
  };
  const identity = options.identity ?? { authenticated: false };
  const requestId = options.requestId ?? "memory-request";
  const configuredContext = options.requestContext;
  const app = createApplication({
    ...options,
    commandGovernance: options.commandGovernance ?? (options.memoryGovernance ? governance : undefined),
    deps: {
      ...(options.deps ?? {}),
      dbClient: db,
      memoryDb: db,
      storage,
      memoryStorage: storage,
      memoryPolicy: policy,
    },
    requestContext: configuredContext ?? ((request) => ({
      requestId: request.headers.get("x-request-id") ?? requestId,
      request,
      identity,
    })),
  });

  return {
    app,
    db,
    storage,
    policy,
    audit,
    identity,
    request(path, init = {}) {
      const url = path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `http://memory.local${path.startsWith("/") ? path : `/${path}`}`;
      return app.handle(new Request(url, init));
    },
    reset() {
      db.clear();
      storage.clear();
      policy.clear();
      audit.length = 0;
    },
  };
}

function memoryCommandInput(invocation: CommandInvocation): unknown {
  const input = invocation.input;
  if (typeof input !== "object" || input === null) return input;
  // Runtime scopes contain mutable services and must never enter a receipt key.
  // Keep business input and headers, but exclude identity and tracing transport.
  const ignoredHeaders = new Set(["authorization", "idempotency-key", "x-request-id", "traceparent", "tracestate"]);
  const headers = Object.fromEntries([...invocation.request.headers.entries()]
    .filter(([name]) => !ignoredHeaders.has(name)));
  return {
    method: invocation.request.method,
    path: new URL(invocation.request.url).pathname,
    body: "body" in input ? input.body : undefined,
    params: "params" in input ? input.params : undefined,
    query: "query" in input ? input.query : undefined,
    headers,
  };
}

function storageKey(bucket: string, key: string): string {
  return JSON.stringify([bucket, key]);
}

function cloneObject(object: MemoryStorageObject): MemoryStorageObject {
  return {
    ...object,
    body: new Uint8Array(object.body),
    metadata: { ...object.metadata },
  };
}

function cloneTables(
  tables: Map<string, Map<string, unknown>>,
): Map<string, Map<string, unknown>> {
  return new Map(
    [...tables.entries()].map(([table, rows]) => [
      table,
      new Map([...rows.entries()].map(([key, value]) => [key, cloneValue(value)])),
    ]),
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
