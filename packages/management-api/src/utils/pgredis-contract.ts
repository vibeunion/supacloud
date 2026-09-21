import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "./errors";
import { isRecord } from "./project-config";

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ProjectRef = Type.String({ minLength: 1, maxLength: 64 });
const Timestamp = Type.String({ minLength: 1 });

export const PgredisPlatformStatusSchema = Type.Object({
  ok: Type.Boolean(),
  service: Type.Literal("pgredis-runtime"),
  namespace: Type.String({ minLength: 1 }),
  queue: Type.Literal(false),
  rateLimit: Type.Literal(false),
  extensions: Type.Object({
    required: Type.Array(Type.String()),
    recommended: Type.Array(Type.String()),
    optional: Type.Array(Type.String()),
  }),
  activeTenants: Count,
  maxTenants: Count,
  connectionsPerTenant: Count,
  l1: Type.Object({ enabled: Type.Boolean(), maxEntries: Count, ttlMs: Count }),
  tenants: Type.Array(Type.Object({
    projectRef: ProjectRef,
    leases: Count,
    lastUsedAt: Timestamp,
  })),
});

export const PgredisProjectStatusSchema = Type.Object({
  projectRef: ProjectRef,
  configured: Type.Boolean(),
  active: Type.Boolean(),
  configurationCurrent: Type.Boolean(),
  leases: Count,
  lastUsedAt: Type.Union([Timestamp, Type.Null()]),
});

export type PgredisPlatformStatus = Static<typeof PgredisPlatformStatusSchema> & { configured: boolean };
export type PgredisProjectStatus = Static<typeof PgredisProjectStatusSchema>;

export function invalidPgredisReceipt(): AppError {
  return new AppError("Cache data plane returned an invalid response", 502, "PGREDIS_INVALID_RESPONSE");
}

function isTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function parsePgredisPlatformStatus(value: unknown): PgredisPlatformStatus {
  if (!Value.Check(PgredisPlatformStatusSchema, value)
    || value.tenants.some((tenant) => !isTimestamp(tenant.lastUsedAt))) {
    throw invalidPgredisReceipt();
  }
  return {
    configured: true,
    ok: value.ok,
    service: value.service,
    namespace: value.namespace,
    queue: value.queue,
    rateLimit: value.rateLimit,
    extensions: {
      required: value.extensions.required,
      recommended: value.extensions.recommended,
      optional: value.extensions.optional,
    },
    activeTenants: value.activeTenants,
    maxTenants: value.maxTenants,
    connectionsPerTenant: value.connectionsPerTenant,
    l1: { enabled: value.l1.enabled, maxEntries: value.l1.maxEntries, ttlMs: value.l1.ttlMs },
    tenants: value.tenants.map(({ projectRef, leases, lastUsedAt }) => ({ projectRef, leases, lastUsedAt })),
  };
}

export function parsePgredisProjectStatus(value: unknown, projectRef: string): PgredisProjectStatus {
  if (!Value.Check(PgredisProjectStatusSchema, value) || value.projectRef !== projectRef
    || (value.lastUsedAt !== null && !isTimestamp(value.lastUsedAt))) {
    throw invalidPgredisReceipt();
  }
  return {
    projectRef: value.projectRef,
    configured: value.configured,
    active: value.active,
    configurationCurrent: value.configurationCurrent,
    leases: value.leases,
    lastUsedAt: value.lastUsedAt,
  };
}

export function parsePgredisOperationResult(value: unknown, operation: "get" | "set" | "getset" | "getdel" | "delete" | "ttl") {
  if (!isRecord(value)) throw invalidPgredisReceipt();
  switch (operation) {
    case "get":
    case "getset":
    case "getdel":
      if (Object.hasOwn(value, "value")) return { value: value.value };
      break;
    case "set":
      if (typeof value.written === "boolean") return { written: value.written };
      break;
    case "delete":
      if (typeof value.deleted === "boolean") return { deleted: value.deleted };
      break;
    case "ttl":
      if (value.ttlMs === null
        || (typeof value.ttlMs === "number" && Number.isSafeInteger(value.ttlMs) && value.ttlMs >= 0)) {
        return { ttlMs: value.ttlMs };
      }
  }
  throw invalidPgredisReceipt();
}

export function parsePgredisFlushResult(value: unknown): { deleted: number } {
  if (!isRecord(value) || typeof value.deleted !== "number"
    || !Number.isSafeInteger(value.deleted) || value.deleted < 0) throw invalidPgredisReceipt();
  return { deleted: value.deleted };
}
