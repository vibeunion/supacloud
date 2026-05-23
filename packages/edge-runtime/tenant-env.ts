const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";

const TENANTS_DIRS = [
  process.env.TENANTS_DIR || "/etc/supabase/tenants",
  "/opt/supacloud/tenants",
];

const envCache = new Map<string, { env: Record<string, string>; expiresAt: number }>();
const ENV_CACHE_TTL = 5_000;
const ENV_FALLBACK_CACHE_TTL = 30_000;
const MASKED_SECRET_VALUE = "********";

export function isMaskedSecretValue(value: unknown): boolean {
  return typeof value === "string" && value.trim() === MASKED_SECRET_VALUE;
}

export function stripMaskedSecretValues(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isMaskedSecretValue(value)) {
      console.warn(`[tenant-env] ignoring masked secret value for ${key}`);
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const inlineComment = value.match(/\s+#.*$/);
      if (inlineComment) {
        value = value.slice(0, inlineComment.index).trimEnd();
      }
    }

    env[key] = value;
  }
  return env;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function hostFromUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function defaultInternalSupabaseUrl(): string {
  return stripTrailingSlash(
    process.env.SUPACLOUD_INTERNAL_SUPABASE_URL ||
      process.env.INTERNAL_SUPABASE_URL ||
      "http://127.0.0.1",
  );
}

export function normalizeTenantEnv(ref: string, env: Record<string, string>): Record<string, string> {
  const normalized = { ...env };
  const internalSupabaseUrl = stripTrailingSlash(
    normalized.SUPACLOUD_INTERNAL_SUPABASE_URL || defaultInternalSupabaseUrl(),
  );
  const apiHost =
    normalized.SUPACLOUD_PROJECT_API_HOST ||
    hostFromUrl(normalized.SUPABASE_URL) ||
    hostFromUrl(normalized.SUPACLOUD_EXTERNAL_SUPABASE_URL);

  normalized.SUPACLOUD_PROJECT_REF ||= ref;
  normalized.X_PROJECT_REF ||= ref;
  normalized.SUPACLOUD_INTERNAL_SUPABASE_URL = internalSupabaseUrl;
  normalized.SUPACLOUD_INTERNAL_AUTH_URL ||= `${internalSupabaseUrl}/auth/v1`;
  normalized.SUPACLOUD_INTERNAL_REST_URL ||= `${internalSupabaseUrl}/rest/v1`;
  if (apiHost) normalized.SUPACLOUD_PROJECT_API_HOST = apiHost;

  return normalized;
}

export function withBackgroundInternalToken(
  env: Record<string, string>,
  token: string,
): Record<string, string> {
  if (!token) return env;
  return {
    ...env,
    SUPACLOUD_BACKGROUND_INTERNAL_TOKEN: token,
  };
}

async function loadEnvFromFile(ref: string): Promise<Record<string, string>> {
  for (const dir of TENANTS_DIRS) {
    const envPath = `${dir}/${ref}.env`;
    try {
      const file = Bun.file(envPath);
      if (await file.exists()) {
        const content = await file.text();
        return parseEnvFile(content);
      }
    } catch {}
  }
  return {};
}

async function loadEnvFromApi(ref: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${ref}/internal/runtime-env`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 404) {
      console.warn(
        `[tenant-env] runtime-env endpoint missing for ${ref}, trying legacy secrets endpoint`,
      );
      return await loadEnvFromLegacySecretsApi(ref);
    }

    if (!res.ok) {
      console.warn(
        `[tenant-env] API returned ${res.status} for ${ref}, falling back to stale cache or file`
      );
      return null;
    }

    const payload = await res.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return stripMaskedSecretValues(payload as Record<string, string>);
    }
    return null;
  } catch (err) {
    console.warn(
      `[tenant-env] API error for ${ref}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function loadEnvFromLegacySecretsApi(ref: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${ref}/secrets?reveal=true`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(
        `[tenant-env] legacy secrets API returned ${res.status} for ${ref}, falling back to stale cache or file`
      );
      return null;
    }

    const secrets = (await res.json()) as unknown;
    if (!Array.isArray(secrets)) return null;

    const env: Record<string, string> = {};
    for (const secret of secrets) {
      if (
        secret &&
        typeof secret === "object" &&
        "name" in secret &&
        "value" in secret &&
        typeof secret.name === "string" &&
        typeof secret.value === "string"
      ) {
        env[secret.name] = secret.value;
      }
    }
    return stripMaskedSecretValues(env);
  } catch (err) {
    console.warn(
      `[tenant-env] legacy secrets API error for ${ref}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function loadTenantEnv(ref: string): Promise<Record<string, string>> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.env;
  }

  const fileEnv = stripMaskedSecretValues(await loadEnvFromFile(ref));

  const apiEnv = await loadEnvFromApi(ref);
  if (apiEnv === null) {
    const fallback = normalizeTenantEnv(ref, cached ? { ...fileEnv, ...cached.env } : fileEnv);
    envCache.set(ref, { env: fallback, expiresAt: Date.now() + ENV_FALLBACK_CACHE_TTL });
    if (cached) {
      return fallback;
    }
    return fallback;
  }

  const merged = normalizeTenantEnv(ref, { ...fileEnv, ...apiEnv });

  envCache.set(ref, { env: merged, expiresAt: Date.now() + ENV_CACHE_TTL });
  return merged;
}

export function invalidateTenantEnvCache(ref: string) {
  envCache.delete(ref);
}
