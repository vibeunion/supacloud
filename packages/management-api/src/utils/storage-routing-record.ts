import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isRecord } from "./project-config";

export class StorageRoutingUnavailableError extends Error {
  constructor() {
    super("Storage project routing unavailable");
    this.name = "StorageRoutingUnavailableError";
  }
}

const refSchema = Type.String({ minLength: 1, pattern: "^[A-Za-z0-9_-]+$" });
const domain = Type.Union([Type.String(), Type.Null()]);
const domains = Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]);
const configSchema = Type.Object({
  api_domain: Type.Optional(domain),
  custom_domain: Type.Optional(domain),
  auth_domain: Type.Optional(domain),
  studio_domain: Type.Optional(domain),
  additional_api_domains: Type.Optional(domains),
  api_domains: Type.Optional(domains),
});
const rowSchema = Type.Object({
  ref: refSchema,
  status: Type.Union([Type.Literal("active"), Type.Literal("creating")]),
  deleted_at: Type.Null(),
  config: configSchema,
});

export interface StorageRoutingProject {
  ref: string;
  config: Static<typeof configSchema>;
}

export function assertStorageRoutingRef(value: unknown): asserts value is string {
  if (!Value.Check(refSchema, value)) throw new StorageRoutingUnavailableError();
}

function parseRoutingConfig(value: unknown): Static<typeof configSchema> {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new StorageRoutingUnavailableError();
    const serialized = value;
    try {
      value = JSON.parse(serialized);
    } catch {
      // Older projects persisted a bare custom domain instead of a JSON object.
      const domain = serialized.trim();
      try {
        const parsed = new URL(`http://${domain}`);
        if (!domain || /[\u0000-\u0020\u007f/?#@\\]/.test(domain)
          || !/^[a-z0-9._:[\]-]+$/i.test(parsed.hostname)
          || parsed.username || parsed.password || parsed.pathname !== "/"
          || parsed.search || parsed.hash) throw new StorageRoutingUnavailableError();
        value = { custom_domain: domain };
      } catch {
        throw new StorageRoutingUnavailableError();
      }
    }
    if (!isRecord(value)) throw new StorageRoutingUnavailableError();
  }
  if (value === null) value = {};
  if (isRecord(value)) {
    for (const key of Object.keys(configSchema.properties)) {
      if (Object.hasOwn(value, key) && value[key] === undefined) throw new StorageRoutingUnavailableError();
    }
  }
  if (!Value.Check(configSchema, value)) throw new StorageRoutingUnavailableError();
  return value;
}

export function parseStorageRoutingRows(value: unknown, expectedRef?: string): StorageRoutingProject[] {
  if (!Array.isArray(value)) throw new StorageRoutingUnavailableError();
  const refs = new Set<string>();
  return Array.from(value, (row: unknown) => {
    if (!isRecord(row)) throw new StorageRoutingUnavailableError();
    const candidate = {
      ref: row.ref,
      status: typeof row.status === "string" ? row.status.toLowerCase() : row.status,
      deleted_at: row.deleted_at,
      config: parseRoutingConfig(row.config),
    };
    if (!Value.Check(rowSchema, candidate)
      || (expectedRef !== undefined && candidate.ref !== expectedRef)
      || refs.has(candidate.ref)) throw new StorageRoutingUnavailableError();
    refs.add(candidate.ref);
    return { ref: candidate.ref, config: candidate.config };
  });
}
