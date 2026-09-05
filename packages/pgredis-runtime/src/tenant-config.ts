import { lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const PROJECT_REF_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class TenantConfigError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 503,
  ) {
    super(message);
    this.name = "TenantConfigError";
  }
}

export interface TenantDatabaseConfig {
  databaseUrl: string;
  fingerprint: string;
}

function parseEnvironmentFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "string") {
          throw new TenantConfigError("Tenant pgredis configuration is invalid", 503);
        }
        values[key] = parsed;
      } catch {
        throw new TenantConfigError("Tenant pgredis configuration is invalid", 503);
      }
    } else {
      values[key] = value;
    }
  }
  return values;
}

function validateDatabaseUrl(ref: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TenantConfigError("Tenant pgredis database URL is invalid", 503);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TenantConfigError("Tenant pgredis database URL must use PostgreSQL", 503);
  }
  if (decodeURIComponent(url.username) !== `role_${ref}`) {
    throw new TenantConfigError("Tenant pgredis database role does not match the project", 503);
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new TenantConfigError("Tenant pgredis database URL is incomplete", 503);
  }
  return value;
}

export async function loadTenantDatabaseConfig(
  tenantsDir: string,
  ref: string,
): Promise<TenantDatabaseConfig> {
  if (!PROJECT_REF_PATTERN.test(ref)) {
    throw new TenantConfigError("Project reference is invalid", 404);
  }

  const configPath = path.join(tenantsDir, `${ref}_pgredis.env`);
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new TenantConfigError("Tenant pgredis configuration was not found", 404);
    }
    throw new TenantConfigError("Tenant pgredis configuration is unavailable", 503);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TenantConfigError("Tenant pgredis configuration must be a regular file", 503);
  }

  let content: string;
  try {
    content = await Bun.file(configPath).text();
  } catch {
    throw new TenantConfigError("Tenant pgredis configuration is unavailable", 503);
  }
  const values = parseEnvironmentFile(content);
  const databaseUrl = values.PGREDIS_DATABASE_URL;
  if (!databaseUrl) {
    throw new TenantConfigError("Tenant pgredis database URL is missing", 503);
  }

  return {
    databaseUrl: validateDatabaseUrl(ref, databaseUrl),
    fingerprint: createHash("sha256").update(content).digest("hex"),
  };
}
