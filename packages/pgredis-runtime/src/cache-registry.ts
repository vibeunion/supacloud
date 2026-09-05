import { SQL } from "bun";
import { createPgListener, type PgListenerHandle } from "@postgresx/bun-listen";
import { createBunSqlAdapter } from "@postgresx/noredis/adapters/bun";
import { createPgKvCache, type PgKvCache } from "@postgresx/noredis/kv";
import type { PgSqlLike } from "@postgresx/noredis";
import {
  loadTenantDatabaseConfig,
  TenantConfigError,
  type TenantDatabaseConfig,
} from "./tenant-config";

export interface TenantCache {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(
    key: string,
    value: T,
    options?: { ttlMs?: number | null },
  ): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  ttl(key: string): Promise<number | null>;
  getset<T>(
    key: string,
    value: T,
    decode: (value: unknown) => T,
  ): Promise<T | null>;
  getdel<T = unknown>(key: string): Promise<T | null>;
  flush(): Promise<number>;
  cleanupExpired?(limit?: number): Promise<number>;
}

interface TenantCacheBackend {
  cache: TenantCache;
  close(): Promise<void>;
}

interface TenantCacheEntry extends TenantCacheBackend {
  ref: string;
  fingerprint: string;
  lastUsedAt: number;
  leases: number;
  retiring: boolean;
  closePromise: Promise<void> | null;
  resolveLeaseDrain: (() => void) | null;
}

export interface TenantCacheLease {
  cache: TenantCache;
  release(): void;
}

export interface TenantCacheRegistrySnapshot {
  activeTenants: number;
  maxTenants: number;
  connectionsPerTenant: number;
  l1: {
    enabled: true;
    maxEntries: number;
    ttlMs: number;
  };
  tenants: Array<{
    projectRef: string;
    leases: number;
    lastUsedAt: string;
  }>;
}

export interface TenantCacheProjectStatus {
  projectRef: string;
  configured: boolean;
  active: boolean;
  configurationCurrent: boolean;
  leases: number;
  lastUsedAt: string | null;
}

export class TenantCapacityError extends Error {
  readonly status = 503;

  constructor() {
    super("pgredis runtime tenant capacity is temporarily exhausted");
    this.name = "TenantCapacityError";
  }
}

class TenantGenerationChangedError extends Error {
  constructor() {
    super("pgredis tenant configuration changed during backend creation");
    this.name = "TenantGenerationChangedError";
  }
}

export interface TenantCacheRegistryOptions {
  tenantsDir: string;
  maxTenants: number;
  connectionsPerTenant: number;
  tenantIdleMs: number;
  l1MaxEntries: number;
  l1TtlMs: number;
  cleanupBatchSize?: number;
  now?: () => number;
  loadConfig?: (tenantsDir: string, ref: string) => Promise<TenantDatabaseConfig>;
  createBackend?: (
    ref: string,
    config: TenantDatabaseConfig,
    connectionsPerTenant: number,
    l1MaxEntries: number,
    l1TtlMs: number,
  ) => Promise<TenantCacheBackend>;
}

const CACHE_NAMESPACE = "supacloud-edge-runtime";
const CACHE_TABLE = "public.supacloud_pgredis_kv";
const NOTIFY_CHANNEL = "supacloud_pgredis_invalidate";

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "40001") return true;
  return "cause" in error && isSerializationFailure(error.cause);
}

function notification(op: "set" | "delete", key: string): string {
  return JSON.stringify({ namespace: CACHE_NAMESPACE, op, key });
}

function deserializeJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

interface TransactionCache {
  set<T = unknown>(key: string, value: T, options?: { ttlMs?: number | null }): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  getdel<T = unknown>(key: string): Promise<T | null>;
  clearNamespace(): Promise<number>;
}

interface LocalCache {
  get<T = unknown>(key: string): Promise<T | null>;
  ttl(key: string): Promise<number | null>;
  invalidate(key: string): void;
  invalidateAll(): void;
}

export function createTransactionalTenantCache(
  adapter: PgSqlLike,
  cache: LocalCache,
  createTransactionCache: (tx: PgSqlLike) => TransactionCache,
  cleanupExpired?: (limit?: number) => Promise<number>,
): TenantCache {
  const transaction = async <T>(
    operation: (tx: PgSqlLike, txCache: TransactionCache) => Promise<T>,
    serializable = false,
  ): Promise<T> => {
    if (!adapter.begin) throw new Error("pgredis runtime requires transaction-capable PostgreSQL adapter");
    for (let attempt: number = 0; attempt < 3; attempt += 1) {
      try {
        return await adapter.begin(async (tx) => {
          if (serializable) await tx.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
          return operation(tx, createTransactionCache(tx));
        });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === 2) throw error;
      }
    }
    throw new Error("pgredis transaction retry exhausted");
  };

  return {
    get: <T = unknown>(key: string) => cache.get<T>(key),
    ttl: (key) => cache.ttl(key),
    async set(key, value, options) {
      const writeAccepted = await transaction((_tx, txCache) => txCache.set(key, value, options));
      cache.invalidate(key);
      return writeAccepted;
    },
    async delete(key) {
      const deleted = await transaction((_tx, txCache) => txCache.delete(key));
      cache.invalidate(key);
      return deleted;
    },
    async getset<T>(key: string, value: T, decode: (value: unknown) => T) {
      const serialized = JSON.stringify(value);
      const previousValue = await transaction<unknown | null>(async (tx) => {
        const rows = await tx.unsafe<{ value: unknown }>(
          `SELECT value
           FROM ${CACHE_TABLE}
           WHERE namespace = $1
             AND key = $2
             AND (expires_at IS NULL OR expires_at > NOW())
           FOR UPDATE`,
          [CACHE_NAMESPACE, key],
        );
        await tx.unsafe(
          `INSERT INTO ${CACHE_TABLE} (namespace, key, value, expires_at, updated_at)
           VALUES ($1, $2, $3::jsonb, NULL, NOW())
           ON CONFLICT (namespace, key) DO UPDATE
           SET value = EXCLUDED.value,
               expires_at = NULL,
               updated_at = NOW()`,
          [CACHE_NAMESPACE, key, serialized],
        );
        await tx.unsafe("SELECT pg_notify($1, $2)", [
          NOTIFY_CHANNEL,
          notification("set", key),
        ]);
        return rows[0] ? deserializeJsonValue(rows[0].value) : null;
      }, true);
      cache.invalidate(key);
      return previousValue === null ? null : decode(previousValue);
    },
    async getdel<T = unknown>(key: string) {
      const deletedValue = await transaction((_tx, txCache) => txCache.getdel<T>(key));
      cache.invalidate(key);
      return deletedValue;
    },
    async flush() {
      const deleted = await transaction((_tx, txCache) => txCache.clearNamespace());
      cache.invalidateAll();
      return deleted;
    },
    cleanupExpired: cleanupExpired
      ? (limit = 500) => cleanupExpired(Math.max(1, Math.min(Math.trunc(limit), 10_000)))
      : undefined,
  };
}

function waitForListener(listener: PgListenerHandle, timeoutMs = 5_000): Promise<void> {
  const health = listener.getHealth();
  if (health.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled: boolean = false;
    const timer = setTimeout(() => finish(new Error("pgredis LISTEN connection timed out")), timeoutMs);
    const offConnected = listener.on("connected", () => finish());
    const offError = listener.on("error", (error) => finish(error));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offConnected();
      offError();
      if (error) reject(error);
      else resolve();
    };
  });
}

export function clearL1AfterListenerConnect(
  listener: { on(event: "connected", handler: () => void): () => void },
  cache: Pick<PgKvCache, "invalidateAll">,
): () => void {
  return listener.on("connected", () => cache.invalidateAll());
}

async function createPostgresBackend(
  _ref: string,
  config: TenantDatabaseConfig,
  connectionsPerTenant: number,
  l1MaxEntries: number,
  l1TtlMs: number,
): Promise<TenantCacheBackend> {
  const sql = new SQL({
    url: config.databaseUrl,
    max: connectionsPerTenant,
    idleTimeout: 30,
    maxLifetime: 3_600,
    connectionTimeout: 10,
  });
  const adapter = createBunSqlAdapter(sql);
  let listener: PgListenerHandle | null = null;
  let connectedUnsubscribe: (() => void) | null = null;
  const unsubscribeConnected = () => connectedUnsubscribe?.();
  let cache: PgKvCache;
  cache = createPgKvCache({
    sql: adapter,
    namespace: CACHE_NAMESPACE,
    tableName: CACHE_TABLE,
    l1: { max: l1MaxEntries, ttlMs: l1TtlMs },
    notify: {
      channel: NOTIFY_CHANNEL,
      clearL1OnReconnect: true,
      listener: ({ channels, onNotify }) => {
        listener = createPgListener(config.databaseUrl, channels, onNotify, { logger: false });
        return listener;
      },
    },
  });

  try {
    if (!listener) throw new Error("pgredis invalidation listener was not created");
    connectedUnsubscribe = clearL1AfterListenerConnect(listener, cache);
    await waitForListener(listener);
    await cache.ensureSchema({ unlogged: true });
  } catch (error) {
    unsubscribeConnected();
    cache.stopInvalidationListener();
    await sql.close({ timeout: 0 });
    throw error;
  }

  const transactionalCache = createTransactionalTenantCache(
    adapter,
    cache,
    (tx) => createPgKvCache({
      sql: tx,
      namespace: CACHE_NAMESPACE,
      tableName: CACHE_TABLE,
      l1: false,
      notify: { channel: NOTIFY_CHANNEL },
    }),
    cache.cleanupExpired.bind(cache),
  );

  return {
    cache: transactionalCache,
    async close() {
      unsubscribeConnected();
      cache.stopInvalidationListener();
      await sql.close({ timeout: 5 });
    },
  };
}

export class TenantCacheRegistry {
  private readonly entries = new Map<string, TenantCacheEntry>();
  private readonly tenantLocks = new Map<string, Promise<void>>();
  private readonly retired = new Set<TenantCacheEntry>();
  private creating = 0;
  private shuttingDown = false;
  private readonly now: () => number;
  private readonly loadConfig: NonNullable<TenantCacheRegistryOptions["loadConfig"]>;
  private readonly createBackend: NonNullable<TenantCacheRegistryOptions["createBackend"]>;

  constructor(private readonly options: TenantCacheRegistryOptions) {
    this.now = options.now || Date.now;
    this.loadConfig = options.loadConfig || loadTenantDatabaseConfig;
    this.createBackend = options.createBackend || createPostgresBackend;
  }

  async acquire(ref: string): Promise<TenantCacheLease> {
    if (this.shuttingDown) throw new Error("pgredis runtime is shutting down");
    const entry = await this.acquireEntry(ref);
    if (this.shuttingDown) {
      this.releaseEntry(entry);
      throw new Error("pgredis runtime is shutting down");
    }
    let released: boolean = false;
    return {
      cache: entry.cache,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(entry);
      },
    };
  }

  async sweepIdle(): Promise<number> {
    const cutoff = this.now() - this.options.tenantIdleMs;
    const stale = [...this.entries.values()]
      .filter((entry) => entry.leases === 0 && entry.lastUsedAt <= cutoff);
    for (const entry of stale) this.retireEntry(entry);
    await Promise.all(stale.map((entry) => entry.closePromise));
    return stale.length;
  }

  async sweepExpired(): Promise<number> {
    const limit = this.options.cleanupBatchSize ?? 500;
    let deleted: number = 0;
    for (const entry of this.entries.values()) {
      if (entry.retiring || !entry.cache.cleanupExpired) continue;
      entry.leases += 1;
      try {
        deleted += await entry.cache.cleanupExpired(limit);
      } catch {
        // Cleanup is best effort; the next interval retries the batch.
      } finally {
        this.releaseEntry(entry);
      }
    }
    return deleted;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.tenantLocks.values()]);
    const allEntries = new Set([...this.entries.values(), ...this.retired.values()]);
    for (const entry of allEntries) this.retireEntry(entry);
    await Promise.all([...allEntries].map((entry) => entry.closePromise));
  }

  size(): number {
    return this.entries.size;
  }

  snapshot(): TenantCacheRegistrySnapshot {
    return {
      activeTenants: this.entries.size,
      maxTenants: this.options.maxTenants,
      connectionsPerTenant: this.options.connectionsPerTenant,
      l1: {
        enabled: true,
        maxEntries: this.options.l1MaxEntries,
        ttlMs: this.options.l1TtlMs,
      },
      tenants: [...this.entries.values()]
        .sort((left, right) => left.ref.localeCompare(right.ref))
        .map((entry) => ({
          projectRef: entry.ref,
          leases: entry.leases,
          lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
        })),
    };
  }

  async projectStatus(ref: string): Promise<TenantCacheProjectStatus> {
    let config: TenantDatabaseConfig;
    try {
      config = await this.loadConfig(this.options.tenantsDir, ref);
    } catch (error) {
      if (error instanceof TenantConfigError && error.status === 404) {
        return {
          projectRef: ref,
          configured: false,
          active: false,
          configurationCurrent: false,
          leases: 0,
          lastUsedAt: null,
        };
      }
      throw error;
    }

    const entry = this.entries.get(ref);
    return {
      projectRef: ref,
      configured: true,
      active: Boolean(entry),
      configurationCurrent: !entry || entry.fingerprint === config.fingerprint,
      leases: entry?.leases ?? 0,
      lastUsedAt: entry ? new Date(entry.lastUsedAt).toISOString() : null,
    };
  }

  private async acquireEntry(ref: string): Promise<TenantCacheEntry> {
    return this.withTenantLock(ref, async () => {
      if (this.shuttingDown) throw new Error("pgredis runtime is shutting down");
      await this.sweepIdle();
      const config = await this.loadConfig(this.options.tenantsDir, ref);
      if (this.shuttingDown) throw new Error("pgredis runtime is shutting down");
      const existing = this.entries.get(ref);
      const entry = existing?.fingerprint === config.fingerprint && !existing.retiring
        ? existing
        : await this.replaceEntry(ref, config);
      entry.leases += 1;
      entry.lastUsedAt = this.now();
      return entry;
    });
  }

  private async replaceEntry(ref: string, config: TenantDatabaseConfig): Promise<TenantCacheEntry> {
    const existing = this.entries.get(ref);
    if (existing) {
      this.retireEntry(existing);
      if (existing.leases === 0) await existing.closePromise;
    }
    this.creating += 1;
    let reservationActive: boolean = true;
    try {
      await this.evictForCapacity();
      const backend = await this.createBackend(
        ref,
        config,
        this.options.connectionsPerTenant,
        this.options.l1MaxEntries,
        this.options.l1TtlMs,
      );
      const entry = this.createEntry(ref, config.fingerprint, backend);
      let latestConfig: TenantDatabaseConfig;
      try {
        latestConfig = await this.loadConfig(this.options.tenantsDir, ref);
      } catch (error) {
        this.creating -= 1;
        reservationActive = false;
        this.retireEntry(entry);
        await entry.closePromise;
        throw error;
      }
      if (latestConfig.fingerprint !== config.fingerprint || this.shuttingDown) {
        this.creating -= 1;
        reservationActive = false;
        this.retireEntry(entry);
        await entry.closePromise;
        if (this.shuttingDown) throw new Error("pgredis runtime is shutting down");
        throw new TenantGenerationChangedError();
      }
      this.creating -= 1;
      reservationActive = false;
      this.entries.set(ref, entry);
      return entry;
    } finally {
      if (reservationActive) this.creating -= 1;
    }
  }

  private async evictForCapacity(): Promise<void> {
    while (this.entries.size + this.retired.size + this.creating > this.options.maxTenants) {
      const oldest = [...this.entries.values()]
        .filter((entry) => entry.leases === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldest) throw new TenantCapacityError();
      this.retireEntry(oldest);
      await oldest.closePromise;
    }
  }

  private retireEntry(entry: TenantCacheEntry): void {
    if (entry.retiring) return;
    entry.retiring = true;
    if (this.entries.get(entry.ref) === entry) this.entries.delete(entry.ref);
    this.retired.add(entry);
    entry.closePromise = new Promise<void>((resolve) => {
      if (entry.leases === 0) resolve();
      else entry.resolveLeaseDrain = resolve;
    }).then(async () => {
      await entry.close();
      this.retired.delete(entry);
    });
  }

  private createEntry(
    ref: string,
    fingerprint: string,
    backend: TenantCacheBackend,
  ): TenantCacheEntry {
    return {
      ...backend,
      ref,
      fingerprint,
      lastUsedAt: this.now(),
      leases: 0,
      retiring: false,
      closePromise: null,
      resolveLeaseDrain: null,
    };
  }

  private releaseEntry(entry: TenantCacheEntry): void {
    entry.leases -= 1;
    entry.lastUsedAt = this.now();
    if (entry.retiring && entry.leases === 0) {
      entry.resolveLeaseDrain?.();
      entry.resolveLeaseDrain = null;
    }
  }

  private async withTenantLock<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tenantLocks.get(ref) || Promise.resolve();
    let releaseLock: () => void = () => {};
    const current = new Promise<void>((resolve) => { releaseLock = resolve; });
    this.tenantLocks.set(ref, current);
    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (this.tenantLocks.get(ref) === current) this.tenantLocks.delete(ref);
    }
  }
}
