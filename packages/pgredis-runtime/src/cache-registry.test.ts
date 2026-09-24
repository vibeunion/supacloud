import { describe, expect, test } from "bun:test";
import type { PgSqlLike } from "@postgresx/noredis";
import {
  clearL1AfterListenerConnect,
  createLocalInvalidationTransport,
  createNotifyInvalidationTransport,
  createTransactionalTenantCache,
  TenantCacheRegistry,
  type TenantCache,
} from "./cache-registry";
import { renderPgredisMetrics, resetPgredisMetrics } from "./metrics";

function fakeCache(): TenantCache & { clearNamespace(): Promise<number> } {
  return {
    async get() { return null; },
    async mget() { return new Map<string, unknown>(); },
    async set() { return true; },
    async mset() {},
    async delete() { return true; },
    async ttl() { return null; },
    async getset() { return null; },
    async getdel() { return null; },
    async flush() { return 0; },
    async clearNamespace() { return 0; },
  };
}

describe("TenantCacheRegistry", () => {
  test("deduplicates creation and drains the old generation before closing it", async () => {
    let fingerprint = "one";
    let createCalls = 0;
    let closeCalls = 0;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 2,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint,
      }),
      createBackend: async () => {
        createCalls++;
        return {
          cache: fakeCache(),
          async close() { closeCalls++; },
        };
      },
    });

    const [first, concurrent] = await Promise.all([
      registry.acquire("tenant-a"),
      registry.acquire("tenant-a"),
    ]);
    expect(createCalls).toBe(1);
    concurrent.release();

    fingerprint = "two";
    const replacement = await registry.acquire("tenant-a");
    expect(createCalls).toBe(2);
    expect(closeCalls).toBe(0);
    first.release();
    await Bun.sleep(0);
    expect(closeCalls).toBe(1);
    replacement.release();
    await registry.shutdown();
    expect(closeCalls).toBe(2);
  });

  test("evicts the least recently used idle tenant at capacity", async () => {
    let now = 1;
    const closed: string[] = [];
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 2,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      now: () => now,
      loadConfig: async (_directory, ref) => ({
        databaseUrl: `postgresql://role_${ref}:secret@postgres/db`,
        fingerprint: ref,
      }),
      createBackend: async (ref) => ({
        cache: fakeCache(),
        async close() { closed.push(ref); },
      }),
    });

    const tenantA = await registry.acquire("tenant-a");
    tenantA.release();
    now++;
    const tenantB = await registry.acquire("tenant-b");
    tenantB.release();
    now++;
    const tenantC = await registry.acquire("tenant-c");
    tenantC.release();
    expect(closed).toEqual(["tenant-a"]);
    expect(registry.size()).toBe(2);
    await registry.shutdown();
  });

  test("reports bounded runtime and project status without exposing credentials", async () => {
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 4,
      connectionsPerTenant: 2,
      tenantIdleMs: 10_000,
      l1MaxEntries: 250,
      l1TtlMs: 2_000,
      now: () => Date.parse("2026-07-27T00:00:00.000Z"),
      loadConfig: async (_directory, ref) => ({
        databaseUrl: `postgresql://role_${ref}:secret@postgres/db`,
        fingerprint: ref,
      }),
      createBackend: async () => ({ cache: fakeCache(), async close() {} }),
    });
    const lease = await registry.acquire("tenant-a");
    lease.release();

    expect(registry.snapshot()).toEqual({
      activeTenants: 1,
      maxTenants: 4,
      connectionsPerTenant: 2,
      l1: { enabled: true, maxEntries: 250, ttlMs: 2_000, hits: 0, misses: 0 },
      tenants: [{
        projectRef: "tenant-a",
        leases: 0,
        lastUsedAt: "2026-07-27T00:00:00.000Z",
      }],
    });
    expect(await registry.projectStatus("tenant-a")).toMatchObject({
      projectRef: "tenant-a",
      configured: true,
      active: true,
      configurationCurrent: true,
    });
    await registry.shutdown();
  });

  test("sweeps expired rows without racing active request leases", async () => {
    let cleanupCalls = 0;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 1,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 10,
      l1TtlMs: 1_000,
      cleanupBatchSize: 25,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint: "one",
      }),
      createBackend: async () => ({
        cache: {
          ...fakeCache(),
          async cleanupExpired(limit?: number) {
            expect(limit).toBe(25);
            cleanupCalls++;
            return 3;
          },
        },
        async close() {},
      }),
    });
    const lease = await registry.acquire("tenant-a");
    lease.release();
    expect(await registry.sweepExpired()).toBe(3);
    expect(cleanupCalls).toBe(1);
    await registry.shutdown();
  });

  test("does not publish a backend when credentials rotate during creation", async () => {
    let fingerprint = "one";
    let releaseFirst: (() => void) | undefined;
    const firstCreation = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 2,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint,
      }),
      createBackend: async (_ref, config) => {
        if (config.fingerprint === "one") await firstCreation;
        return {
          cache: {
            ...fakeCache(),
            async get<T = unknown>() { return config.fingerprint as T; },
          },
          async close() {},
        };
      },
    });

    const firstAcquire = registry.acquire("tenant-a");
    await Bun.sleep(0);
    fingerprint = "two";
    const rotatedAcquire = registry.acquire("tenant-a");
    releaseFirst?.();

    await expect(firstAcquire).rejects.toThrow("configuration changed during backend creation");
    const rotated = await rotatedAcquire;
    expect(await rotated.cache.get<string>("key")).toBe("two");
    rotated.release();
    await registry.shutdown();
  });

  test("serializes same-tenant config reads so an old generation cannot replace a new one", async () => {
    let releaseFirstRead: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let readCalls = 0;
    const created: string[] = [];
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 2,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async () => {
        readCalls += 1;
        if (readCalls === 1) await firstRead;
        const fingerprint = readCalls <= 2 ? "old" : "new";
        return {
          databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
          fingerprint,
        };
      },
      createBackend: async (_ref, config) => {
        created.push(config.fingerprint);
        return {
          cache: {
            ...fakeCache(),
            async get<T = unknown>() { return config.fingerprint as T; },
          },
          async close() {},
        };
      },
    });

    const oldAcquire = registry.acquire("tenant-a");
    await Bun.sleep(0);
    const newAcquire = registry.acquire("tenant-a");
    releaseFirstRead?.();
    const oldLease = await oldAcquire;
    const newLease = await newAcquire;
    expect(created).toEqual(["old", "new"]);
    expect(await oldLease.cache.get<string>("key")).toBe("old");
    expect(await newLease.cache.get<string>("key")).toBe("new");
    oldLease.release();
    newLease.release();
    await registry.shutdown();
  });

  test("waits for active request leases before closing on shutdown", async () => {
    let closed = false;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 1,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint: "one",
      }),
      createBackend: async () => ({
        cache: fakeCache(),
        async close() { closed = true; },
      }),
    });
    const lease = await registry.acquire("tenant-a");
    const shutdown = registry.shutdown();
    await Bun.sleep(0);
    expect(closed).toBeFalse();
    lease.release();
    await shutdown;
    expect(closed).toBeTrue();
  });

  test("rejects a new tenant when every backend slot is leased", async () => {
    let createCalls = 0;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 1,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async (_directory, ref) => ({
        databaseUrl: `postgresql://role_${ref}:secret@postgres/db`,
        fingerprint: ref,
      }),
      createBackend: async () => {
        createCalls += 1;
        return { cache: fakeCache(), async close() {} };
      },
    });
    const first = await registry.acquire("tenant-a");
    await expect(registry.acquire("tenant-b")).rejects.toThrow("capacity is temporarily exhausted");
    expect(createCalls).toBe(1);
    first.release();
    await registry.shutdown();
  });

  test("does not create a replacement backend while the old generation is leased at capacity", async () => {
    let fingerprint = "one";
    let createCalls = 0;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 1,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint,
      }),
      createBackend: async () => {
        createCalls += 1;
        return { cache: fakeCache(), async close() {} };
      },
    });
    const first = await registry.acquire("tenant-a");
    fingerprint = "two";
    await expect(registry.acquire("tenant-a")).rejects.toThrow("capacity is temporarily exhausted");
    expect(createCalls).toBe(1);
    first.release();
    await registry.shutdown();
  });

  test("keeps a backend that failed to close counted against capacity", async () => {
    let createCalls = 0;
    const registry = new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 1,
      connectionsPerTenant: 1,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      loadConfig: async (_directory, ref) => ({
        databaseUrl: `postgresql://role_${ref}:secret@postgres/db`,
        fingerprint: ref,
      }),
      createBackend: async () => {
        createCalls += 1;
        return {
          cache: fakeCache(),
          async close() { throw new Error("close failed"); },
        };
      },
    });
    const first = await registry.acquire("tenant-a");
    first.release();
    await expect(registry.acquire("tenant-b")).rejects.toThrow("close failed");
    await expect(registry.acquire("tenant-b")).rejects.toThrow("capacity is temporarily exhausted");
    expect(createCalls).toBe(1);
    await expect(registry.shutdown()).rejects.toThrow("close failed");
  });
});

describe("listener invalidation", () => {
  test("clears L1 after every successful LISTEN subscription", () => {
    let connected: (() => void) | undefined;
    let invalidations = 0;
    const unsubscribe = clearL1AfterListenerConnect(
      {
        on(event, handler) {
          expect(event).toBe("connected");
          connected = handler as () => void;
          return () => { connected = undefined; };
        },
      },
      { invalidateAll() { invalidations += 1; } },
    );
    connected?.();
    connected?.();
    expect(invalidations).toBe(2);
    unsubscribe();
    expect(connected).toBeUndefined();
  });
});

describe("createTransactionalTenantCache", () => {
  test("commits GETSET value and invalidation notification in one serializable transaction", async () => {
    const calls: string[] = [];
    const invalidated: string[] = [];
    const tx: PgSqlLike = {
      async unsafe<T>(query: string): Promise<T[]> {
        calls.push(query.replace(/\s+/g, " ").trim());
        if (query.includes("SELECT value")) return [{ value: { previous: true } }] as T[];
        return [];
      },
    };
    const adapter: PgSqlLike = {
      async unsafe<T>(): Promise<T[]> { return []; },
      async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
        calls.push("BEGIN");
        const result = await operation(tx);
        calls.push("COMMIT");
        return result;
      },
    };
    const cache = createTransactionalTenantCache(
      adapter,
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate(key) { invalidated.push(key); },
        invalidateAll() {},
      },
      () => fakeCache(),
    );

    expect(await cache.getset<{ previous?: boolean; next?: boolean }>("shared", { next: true }, (value) => value as { previous?: boolean; next?: boolean }))
      .toEqual({ previous: true });
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toBe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(calls[2]).toContain("FOR UPDATE");
    expect(calls[3]).toContain("INSERT INTO public.supacloud_pgredis_kv");
    expect(calls[4]).toBe("SELECT pg_notify($1, $2)");
    expect(calls[5]).toBe("COMMIT");
    expect(invalidated).toEqual(["shared"]);
  });

  test("does not update local L1 when transactional notification fails", async () => {
    let invalidated = false;
    const tx: PgSqlLike = {
      async unsafe<T>(query: string): Promise<T[]> {
        if (query.includes("pg_notify")) throw new Error("notify failed");
        return [];
      },
    };
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        begin: (operation) => operation(tx),
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() { invalidated = true; },
        invalidateAll() { invalidated = true; },
      },
      () => fakeCache(),
    );

    await expect(cache.getset("shared", "next", (value) => value as string)).rejects.toThrow("notify failed");
    expect(invalidated).toBeFalse();
  });

  test("commits namespace flush before clearing the local L1", async () => {
    const calls: string[] = [];
    const tx: PgSqlLike = {
      async unsafe<T>(): Promise<T[]> { return []; },
    };
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
          calls.push("BEGIN");
          const result = await operation(tx);
          calls.push("COMMIT");
          return result;
        },
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() { calls.push("INVALIDATE_ALL"); },
      },
      () => ({
        ...fakeCache(),
        async clearNamespace() {
          calls.push("CLEAR_NAMESPACE_AND_NOTIFY");
          return 4;
        },
      }),
    );

    expect(await cache.flush()).toBe(4);
    expect(calls).toEqual([
      "BEGIN",
      "CLEAR_NAMESPACE_AND_NOTIFY",
      "COMMIT",
      "INVALIDATE_ALL",
    ]);
  });

  test("delegates expired-row cleanup to the upstream PgKvCache", async () => {
    let cleanupLimit = 0;
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
          return operation({ async unsafe<U>(): Promise<U[]> { return []; } });
        },
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
      },
      () => fakeCache(),
      async (limit) => {
        cleanupLimit = limit || 0;
        return 1;
      },
    );

    expect(await cache.cleanupExpired?.(20_000)).toBe(1);
    expect(cleanupLimit).toBe(10_000);
  });

  test("delegates batch reads to the upstream PgKvCache without opening a transaction", async () => {
    const requested: string[][] = [];
    let beginCount = 0;
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
          beginCount += 1;
          return operation({ async unsafe<U>(): Promise<U[]> { return []; } });
        },
      },
      {
        async get() { return null; },
        async mget(keys: readonly string[]) {
          requested.push([...keys]);
          return new Map<string, unknown>(keys.map((key) => [key, `value:${key}`] as const));
        },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
      },
      () => fakeCache(),
    );

    const values = await cache.mget(["a", "b"]);
    expect(values.get("a")).toBe("value:a");
    expect(beginCount).toBe(0);
    expect(requested).toEqual([["a", "b"]]);
  });

  test("commits MSET in one transaction and invalidates every key locally", async () => {
    const calls: string[] = [];
    const invalidated: string[] = [];
    const msetOptions: unknown[] = [];
    const tx: PgSqlLike = { async unsafe<T>(): Promise<T[]> { return []; } };
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
          calls.push("BEGIN");
          const result = await operation(tx);
          calls.push("COMMIT");
          return result;
        },
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate(key) { invalidated.push(key); },
        invalidateAll() {},
      },
      () => ({
        ...fakeCache(),
        async mset(_entries, options) {
          calls.push("MSET");
          msetOptions.push(options);
        },
      }),
    );

    await cache.mset([["a", 1], ["b", 2]], { ttlMs: 500 });
    expect(calls).toEqual(["BEGIN", "MSET", "COMMIT"]);
    expect(invalidated).toEqual(["a", "b"]);
    expect(msetOptions).toEqual([{ ttlMs: 500 }]);
  });

  test("uses the injected invalidation publisher instead of the default pg_notify", async () => {
    const published: Array<[string, string]> = [];
    const tx: PgSqlLike = {
      async unsafe<T>(query: string): Promise<T[]> {
        if (query.includes("SELECT value")) return [{ value: { previous: true } }] as T[];
        if (query.includes("pg_notify")) throw new Error("default publisher must not run");
        return [];
      },
    };
    const cache = createTransactionalTenantCache(
      { async unsafe<T>(): Promise<T[]> { return []; }, begin: (operation) => operation(tx) },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
      },
      () => fakeCache(),
      undefined,
      async (_tx, op, key) => {
        published.push([op, key]);
      },
    );

    await cache.getset("shared", { next: true }, (value) => value);
    expect(published).toEqual([["set", "shared"]]);
  });

  test("counts serialization retries for the metrics endpoint", async () => {
    resetPgredisMetrics();
    let attempts = 0;
    const tx: PgSqlLike = { async unsafe<T>(): Promise<T[]> { return []; } };
    const adapter: PgSqlLike = {
      async unsafe<T>(): Promise<T[]> { return []; },
      async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("serialization failure") as Error & { code: string };
          error.code = "40001";
          throw error;
        }
        return operation(tx);
      },
    };
    const cache = createTransactionalTenantCache(
      adapter,
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
      },
      () => fakeCache(),
    );

    await cache.set("a", 1);
    const text = renderPgredisMetrics({
      activeTenants: 0,
      tenantCapacity: 1,
      l1MaxEntries: 1,
      l1Hits: 0,
      l1Misses: 0,
      crossInstanceInvalidation: true,
      databaseInFlight: 0,
      databaseLimit: 0,
    });
    expect(text).toContain("supacloud_pgredis_transaction_retries_total 1");
    expect(text).toContain("supacloud_pgredis_transaction_retry_exhausted_total 0");
  });

  test("exposes upstream L1 stats when the local cache provides them", async () => {
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        begin: (operation) => operation({ async unsafe<U>(): Promise<U[]> { return []; } }),
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
        stats: () => ({ namespace: "n", tableName: "t", l1Size: 2, l1Max: 10, l1Hits: 7, l1Misses: 1 }),
      },
      () => fakeCache(),
    );
    expect(cache.stats?.()).toMatchObject({ l1Hits: 7, l1Misses: 1 });
  });

  test("omits stats when the local cache has none", async () => {
    const cache = createTransactionalTenantCache(
      {
        async unsafe<T>(): Promise<T[]> { return []; },
        begin: (operation) => operation({ async unsafe<U>(): Promise<U[]> { return []; } }),
      },
      {
        async get() { return null; },
        async mget() { return new Map<string, unknown>(); },
        async ttl() { return null; },
        invalidate() {},
        invalidateAll() {},
      },
      () => fakeCache(),
    );
    expect(cache.stats).toBeUndefined();
  });
});

describe("InvalidationTransport", () => {
  test("notify transport wires one channel for listen and publish", async () => {
    const transport = createNotifyInvalidationTransport("channel-a");
    expect(transport.crossInstance).toBeTrue();
    expect(transport.ownerNotifyOptions((() => ({})) as never)).toMatchObject({
      channel: "channel-a",
      clearL1OnReconnect: true,
    });
    expect(transport.transactionNotifyOptions()).toEqual({ channel: "channel-a" });

    const calls: Array<{ query: string; params?: readonly unknown[] }> = [];
    await transport.publish({
      async unsafe<T>(query: string, params?: readonly unknown[]): Promise<T[]> {
        calls.push({ query, params });
        return [];
      },
    }, "set", "a");
    expect(calls[0]?.query).toBe("SELECT pg_notify($1, $2)");
    expect(calls[0]?.params).toEqual([
      "channel-a",
      JSON.stringify({ namespace: "supacloud-edge-runtime", op: "set", key: "a" }),
    ]);
  });

  test("local transport disables cross-instance publish and listen", async () => {
    const transport = createLocalInvalidationTransport();
    expect(transport.crossInstance).toBeFalse();
    expect(transport.ownerNotifyOptions((() => ({})) as never)).toBeFalse();
    expect(transport.transactionNotifyOptions()).toBeFalse();

    let queries = 0;
    await transport.publish({
      async unsafe<T>(): Promise<T[]> {
        queries += 1;
        return [];
      },
    }, "delete", "a");
    expect(queries).toBe(0);
  });
});

describe("connection budget", () => {
  function registryWithBudget(maxTotalConnections?: number): TenantCacheRegistry {
    return new TenantCacheRegistry({
      tenantsDir: "/unused",
      maxTenants: 2,
      connectionsPerTenant: 2,
      tenantIdleMs: 10_000,
      l1MaxEntries: 100,
      l1TtlMs: 1_000,
      maxTotalConnections,
      loadConfig: async () => ({
        databaseUrl: "postgresql://role_tenant-a:secret@postgres/db",
        fingerprint: "one",
      }),
      createBackend: async () => ({ cache: fakeCache(), async close() {} }),
    });
  }

  test("exposes the aggregate database budget when configured", () => {
    expect(registryWithBudget(3).databaseBudgetStats()).toEqual({ inFlight: 0, limit: 3 });
  });

  test("reports no budget when unconfigured", () => {
    expect(registryWithBudget().databaseBudgetStats()).toBeUndefined();
  });
});
