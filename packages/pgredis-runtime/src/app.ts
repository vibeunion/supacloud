import { Elysia, t } from "elysia";
import { TenantCapacityError, type TenantCache, type TenantCacheRegistry } from "./cache-registry";
import { InvalidCapabilityError, verifyPgredisCapability } from "./capability";
import { TenantConfigError } from "./tenant-config";

type CacheOperation = "get" | "set" | "delete" | "ttl" | "getset" | "getdel";

interface CacheRequest {
  op: CacheOperation;
  key: string;
  value?: unknown;
  ttlMs?: number | null;
}

export interface PgredisRuntimeAppOptions {
  signingSecret: string;
  capabilityMaxTtlMs: number;
  maxValueBytes: number;
  maxTtlMs: number;
  registry: Pick<TenantCacheRegistry, "acquire" | "size">;
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
    case "delete":
      return { deleted: await cache.delete(body.key) };
    case "ttl":
      return { ttlMs: await cache.ttl(body.key) };
    case "getset": {
      if (!("value" in body) || jsonSize(body.value) > maxValueBytes) {
        throw new ClientRequestError("Cache value is missing or too large");
      }
      return { value: await cache.getset(body.key, body.value) };
    }
    case "getdel":
      return { value: await cache.getdel(body.key) };
  }
}

class ClientRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRequestError";
  }
}

const cacheRequestSchema = t.Object({
  op: t.Union([
    t.Literal("get"),
    t.Literal("set"),
    t.Literal("delete"),
    t.Literal("ttl"),
    t.Literal("getset"),
    t.Literal("getdel"),
  ]),
  key: t.String({ minLength: 1, maxLength: 512 }),
  value: t.Optional(t.Unknown()),
  ttlMs: t.Optional(t.Union([
    t.Integer({ minimum: 0 }),
    t.Null(),
  ])),
}, { additionalProperties: false });

export function createPgredisRuntimeApp(options: PgredisRuntimeAppOptions) {
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
      if (error instanceof InvalidCapabilityError) {
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
      activeTenants: options.registry.size(),
    }))
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
          return await executeCacheOperation(
            lease.cache,
            body as CacheRequest,
            options.maxValueBytes,
            options.maxTtlMs,
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
