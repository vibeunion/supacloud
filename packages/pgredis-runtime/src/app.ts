import { timingSafeEqual } from "node:crypto";
import { Elysia, t, type Static } from "elysia";
import { TenantCapacityError, type TenantCache, type TenantCacheRegistry } from "./cache-registry";
import { InvalidCapabilityError, verifyPgredisCapability } from "./capability";
import { pgredisExtensionPolicy } from "./extension-policy";
import { recordCacheOperation, renderPgredisMetrics } from "./metrics";
import { PROJECT_REF_PATTERN, TenantConfigError } from "./tenant-config";

type CacheOperation = "get" | "set" | "delete" | "ttl" | "getset" | "getdel" | "mget" | "mset";

const CACHE_KEY_SCHEMA = t.String({ minLength: 1, maxLength: 512 });
// Outer schema bound; the effective limit is PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST.
const MAX_BATCH_KEYS = 512;
const DEFAULT_MAX_KEYS_PER_REQUEST = 100;

export interface PgredisRuntimeAppOptions {
  signingSecret: string;
  adminToken?: string;
  capabilityMaxTtlMs: number;
  maxValueBytes: number;
  maxTtlMs: number;
  maxKeysPerRequest?: number;
  crossInstanceInvalidation?: boolean;
  registry: Pick<TenantCacheRegistry, "acquire" | "size" | "snapshot" | "projectStatus"> & {
    /** Optional aggregate database operation budget, when configured. */
    databaseBudgetStats?(): { inFlight: number; limit: number } | undefined;
  };
}

function jsonSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return Number.POSITIVE_INFINITY;
  return new TextEncoder().encode(serialized).byteLength;
}

async function executeCacheOperation(
  cache: TenantCache,
  body: CacheRequest,
  maxValueBytes: number,
  maxTtlMs: number,
  maxKeysPerRequest: number,
): Promise<Record<string, unknown>> {
  switch (body.op) {
    case "get":
      return { value: await cache.get(body.key) };
    case "set": {
      if (!("value" in body) || jsonSize(body.value) > maxValueBytes) {
        throw new ClientRequestError("Cache value is missing or too large");
      }
      if (body.ttlMs !== undefined && body.ttlMs !== null && body.ttlMs > maxTtlMs) {
        throw new ClientRequestError("Cache TTL exceeds the configured maximum");
      }
      return {
        written: await cache.set(body.key, body.value, { ttlMs: body.ttlMs }),
      };
    }
    case "mget": {
      if (body.keys.length > maxKeysPerRequest) {
        throw new ClientRequestError("Cache batch exceeds the configured key limit");
      }
      const values = await cache.mget(body.keys);
      return { values: body.keys.map((key) => values.get(key) ?? null) };
    }
    case "mset": {
      if (body.entries.length > maxKeysPerRequest) {
        throw new ClientRequestError("Cache batch exceeds the configured key limit");
      }
      if (body.ttlMs !== undefined && body.ttlMs !== null && body.ttlMs > maxTtlMs) {
        throw new ClientRequestError("Cache TTL exceeds the configured maximum");
      }
      for (const entry of body.entries) {
        if (jsonSize(entry.value) > maxValueBytes) {
          throw new ClientRequestError("Cache value is missing or too large");
        }
      }
      await cache.mset(
        body.entries.map((entry) => [entry.key, entry.value] as const),
        { ttlMs: body.ttlMs },
      );
      return { written: body.entries.length };
    }
    case "delete":
      return { deleted: await cache.delete(body.key) };
    case "ttl":
      return { ttlMs: await cache.ttl(body.key) };
    case "getset": {
      if (!("value" in body) || jsonSize(body.value) > maxValueBytes) {
        throw new ClientRequestError("Cache value is missing or too large");
      }
      return { value: await cache.getset(body.key, body.value, (value) => value) };
    }
    case "getdel":
      return { value: await cache.getdel(body.key) };
  }
}

async function executeMeasuredCacheOperation(
  cache: TenantCache,
  body: CacheRequest,
  maxValueBytes: number,
  maxTtlMs: number,
  maxKeysPerRequest: number,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  try {
    const result = await executeCacheOperation(cache, body, maxValueBytes, maxTtlMs, maxKeysPerRequest);
    recordCacheOperation(body.op, "ok", performance.now() - startedAt);
    return result;
  } catch (error) {
    recordCacheOperation(body.op, "error", performance.now() - startedAt);
    throw error;
  }
}

class ClientRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRequestError";
  }
}

class InvalidInternalTokenError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "InvalidInternalTokenError";
  }
}

function requireInternalToken(request: Request, expectedToken: string): void {
  const candidate = request.headers.get("x-supacloud-internal-auth") || "";
  const actual = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvalidInternalTokenError();
  }
}

const cacheRequestSchema = t.Union([
  t.Object({
    op: t.Union([
      t.Literal("get"),
      t.Literal("delete"),
      t.Literal("ttl"),
      t.Literal("getdel"),
    ]),
    key: CACHE_KEY_SCHEMA,
  }, { additionalProperties: false }),
  t.Object({
    op: t.Literal("set"),
    key: CACHE_KEY_SCHEMA,
    value: t.Unknown(),
    ttlMs: t.Optional(t.Union([
      t.Integer({ minimum: 0 }),
      t.Null(),
    ])),
  }, { additionalProperties: false }),
  t.Object({
    op: t.Literal("getset"),
    key: CACHE_KEY_SCHEMA,
    value: t.Unknown(),
  }, { additionalProperties: false }),
  t.Object({
    op: t.Literal("mget"),
    keys: t.Array(CACHE_KEY_SCHEMA, { minItems: 1, maxItems: MAX_BATCH_KEYS }),
  }, { additionalProperties: false }),
  t.Object({
    op: t.Literal("mset"),
    entries: t.Array(
      t.Object({ key: CACHE_KEY_SCHEMA, value: t.Unknown() }, { additionalProperties: false }),
      { minItems: 1, maxItems: MAX_BATCH_KEYS },
    ),
    ttlMs: t.Optional(t.Union([
      t.Integer({ minimum: 0 }),
      t.Null(),
    ])),
  }, { additionalProperties: false }),
]);
type CacheRequest = Static<typeof cacheRequestSchema>;

const projectRefSchema = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: PROJECT_REF_PATTERN.source,
});

const adminCacheRequestSchema = t.Union([
  t.Object({
    projectRef: projectRefSchema,
    op: t.Union([t.Literal("get"), t.Literal("delete"), t.Literal("ttl"), t.Literal("getdel")]),
    key: t.String({ minLength: 1, maxLength: 512 }),
  }, { additionalProperties: false }),
  t.Object({
    projectRef: projectRefSchema,
    op: t.Literal("set"),
    key: t.String({ minLength: 1, maxLength: 512 }),
    value: t.Unknown(),
    ttlMs: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
  }, { additionalProperties: false }),
  t.Object({
    projectRef: projectRefSchema,
    op: t.Literal("getset"),
    key: t.String({ minLength: 1, maxLength: 512 }),
    value: t.Unknown(),
  }, { additionalProperties: false }),
  t.Object({
    projectRef: projectRefSchema,
    op: t.Literal("flush"),
    confirmProjectRef: projectRefSchema,
  }, { additionalProperties: false }),
]);
type AdminCacheRequest = Static<typeof adminCacheRequestSchema>;

export function createPgredisRuntimeApp(options: PgredisRuntimeAppOptions) {
  const adminToken = options.adminToken ?? options.signingSecret;
  const maxKeysPerRequest = options.maxKeysPerRequest ?? DEFAULT_MAX_KEYS_PER_REQUEST;
  return new Elysia({ normalize: false })
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "Invalid cache request" };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "Not found" };
      }
      if (error instanceof ClientRequestError) {
        set.status = 400;
        return { error: error.message };
      }
      if (error instanceof InvalidCapabilityError || error instanceof InvalidInternalTokenError) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      if (error instanceof TenantConfigError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (error instanceof TenantCapacityError) {
        set.status = error.status;
        return { error: error.message };
      }
      console.error("[pgredis-runtime] request failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      set.status = 503;
      return { error: "Cache data plane is unavailable" };
    })
    .get("/health", () => ({
      ok: true,
      service: "pgredis-runtime",
      l1: true,
      queue: false,
      rateLimit: false,
      extensions: pgredisExtensionPolicy(),
      activeTenants: options.registry.size(),
    }))
    .get("/internal/v1/admin/status", ({ request }) => {
      requireInternalToken(request, adminToken);
      return {
        ok: true,
        service: "pgredis-runtime",
        namespace: "supacloud-edge-runtime",
        queue: false,
        rateLimit: false,
        extensions: pgredisExtensionPolicy(),
        ...options.registry.snapshot(),
      };
    })
    .get("/internal/v1/admin/metrics", ({ request, set }) => {
      requireInternalToken(request, adminToken);
      const snapshot = options.registry.snapshot();
      const database = options.registry.databaseBudgetStats?.();
      set.headers["content-type"] = "text/plain; version=0.0.4";
      return renderPgredisMetrics({
        activeTenants: snapshot.activeTenants,
        tenantCapacity: snapshot.maxTenants,
        l1MaxEntries: snapshot.l1.maxEntries,
        l1Hits: snapshot.l1.hits,
        l1Misses: snapshot.l1.misses,
        crossInstanceInvalidation: options.crossInstanceInvalidation ?? true,
        databaseInFlight: database?.inFlight ?? 0,
        databaseLimit: database?.limit ?? 0,
      });
    })
    .get(
      "/internal/v1/admin/projects/:ref/status",
      async ({ params, request }) => {
        requireInternalToken(request, adminToken);
        return await options.registry.projectStatus(params.ref);
      },
      {
        params: t.Object({ ref: projectRefSchema }),
      },
    )
    .post(
      "/internal/v1/admin/projects/:ref/refresh",
      async ({ params, request }) => {
        requireInternalToken(request, adminToken);
        const lease = await options.registry.acquire(params.ref);
        lease.release();
        return await options.registry.projectStatus(params.ref);
      },
      {
        params: t.Object({ ref: projectRefSchema }),
      },
    )
    .post(
      "/internal/v1/admin/cache",
      async ({ body, request }) => {
        requireInternalToken(request, adminToken);
        const adminRequest: AdminCacheRequest = body;
        if (
          adminRequest.op === "flush"
          && adminRequest.confirmProjectRef !== adminRequest.projectRef
        ) {
          throw new ClientRequestError("Project cache flush confirmation does not match");
        }

        const lease = await options.registry.acquire(adminRequest.projectRef);
        try {
          if (adminRequest.op === "flush") {
            return { deleted: await lease.cache.flush() };
          }
          return await executeMeasuredCacheOperation(
            lease.cache,
            adminRequest,
            options.maxValueBytes,
            options.maxTtlMs,
            maxKeysPerRequest,
          );
        } finally {
          lease.release();
        }
      },
      {
        body: adminCacheRequestSchema,
      },
    )
    .post(
      "/internal/v1/cache",
      async ({ body, request }) => {
        const authorization = request.headers.get("authorization") || "";
        const capabilityToken = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
        const capability = verifyPgredisCapability(capabilityToken, options.signingSecret, {
          maxTtlMs: options.capabilityMaxTtlMs,
        });
        const lease = await options.registry.acquire(capability.projectRef);
        try {
          return await executeMeasuredCacheOperation(
            lease.cache,
            body,
            options.maxValueBytes,
            options.maxTtlMs,
            maxKeysPerRequest,
          );
        } finally {
          lease.release();
        }
      },
      {
        body: cacheRequestSchema,
      },
    );
}
