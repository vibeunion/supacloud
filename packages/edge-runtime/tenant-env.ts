const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";

const TENANTS_DIRS = [
  process.env.TENANTS_DIR || "/etc/supabase/tenants",
  "/opt/supacloud/tenants",
];

const envCache = new Map<string, { env: Record<string, string>; expiresAt: number }>();
const envInflightLoads = new Map<string, Promise<Record<string, string>>>();
const ENV_CACHE_TTL = 5_000;
const ENV_FALLBACK_CACHE_TTL = 30_000;
const MASKED_SECRET_VALUE = "********";
const SHARED_FORBIDDEN_AUTH_ENV_KEYS = [
  "JWT_SECRET",
  "JWT_KEYS",
  "SUPACLOUD_THIRD_PARTY_JWT_POLICY",
] as const;
const FILE_AUTH_VERIFIER_ENV_KEYS = [
  ...SHARED_FORBIDDEN_AUTH_ENV_KEYS,
  "JWT_JWKS",
] as const;
const LEGACY_AUTH_ENV_KEYS = [
  ...FILE_AUTH_VERIFIER_ENV_KEYS,
  "SUPACLOUD_AUTH_RUNTIME_MODE",
  "SUPACLOUD_AUTH_AUTHORITY_REF",
  "SUPACLOUD_AUTH_ISSUER",
] as const;

function stripEnvKeys(
  env: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const clean = { ...env };
  for (const key of keys) delete clean[key];
  return clean;
}

function prepareFallbackFileEnv(
  fileEnv: Record<string, string>,
  hasCachedEnv: boolean,
): Record<string, string> {
  if (hasCachedEnv) return stripEnvKeys(fileEnv, FILE_AUTH_VERIFIER_ENV_KEYS);
  const mode = fileEnv.SUPACLOUD_AUTH_RUNTIME_MODE;
  if (mode === "local" || mode === "owner") return { ...fileEnv };
  return stripEnvKeys(fileEnv, FILE_AUTH_VERIFIER_ENV_KEYS);
}

export function buildFallbackTenantEnv(
  ref: string,
  fileEnv: Record<string, string>,
  cachedEnv?: Record<string, string>,
): Record<string, string> {
  return normalizeTenantEnv(ref, {
    ...prepareFallbackFileEnv(fileEnv, cachedEnv !== undefined),
    ...(cachedEnv ? stripEnvKeys(cachedEnv, LEGACY_AUTH_ENV_KEYS) : {}),
  });
}

export function mergeTenantRuntimeEnv(
  ref: string,
  fileEnv: Record<string, string>,
  apiEnv: Record<string, string>,
): Record<string, string> {
  return normalizeTenantEnv(ref, {
    ...stripEnvKeys(fileEnv, LEGACY_AUTH_ENV_KEYS),
    ...apiEnv,
  });
}

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

function pickPort(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
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

function tenantLocalPostgrestUrl(env: Record<string, string>): string | undefined {
  const port = pickPort(
    env.SUPACLOUD_INTERNAL_POSTGREST_PORT ||
      env.POSTGREST_PORT ||
      env.PGRST_PORT,
  );
  return port ? `http://127.0.0.1:${port}` : undefined;
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
  normalized.SUPACLOUD_INTERNAL_REST_URL ||= tenantLocalPostgrestUrl(normalized) || `${internalSupabaseUrl}/rest/v1`;
  if (apiHost) normalized.SUPACLOUD_PROJECT_API_HOST = apiHost;

  const authRuntimeMode = normalized.SUPACLOUD_AUTH_RUNTIME_MODE;
  if (authRuntimeMode === "shared") {
    for (const key of SHARED_FORBIDDEN_AUTH_ENV_KEYS) delete normalized[key];
  } else if (authRuntimeMode !== "local" && authRuntimeMode !== "owner") {
    for (const key of FILE_AUTH_VERIFIER_ENV_KEYS) delete normalized[key];
  }

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
    return stripEnvKeys(stripMaskedSecretValues(env), LEGACY_AUTH_ENV_KEYS);
  } catch (err) {
    console.warn(
      `[tenant-env] legacy secrets API error for ${ref}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function loadTenantEnvUncached(ref: string): Promise<Record<string, string>> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.env;
  }

  const fileEnv = stripMaskedSecretValues(await loadEnvFromFile(ref));

  const apiEnv = await loadEnvFromApi(ref);
  if (apiEnv === null) {
    const fallback = buildFallbackTenantEnv(ref, fileEnv, cached?.env);
    envCache.set(ref, { env: fallback, expiresAt: Date.now() + ENV_FALLBACK_CACHE_TTL });
    return fallback;
  }

  const merged = mergeTenantRuntimeEnv(ref, fileEnv, apiEnv);

  envCache.set(ref, { env: merged, expiresAt: Date.now() + ENV_CACHE_TTL });
  return merged;
}

export async function loadTenantEnv(ref: string): Promise<Record<string, string>> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.env;
  }

  const inflight = envInflightLoads.get(ref);
  if (inflight) {
    return inflight;
  }

  const load = loadTenantEnvUncached(ref).finally(() => {
    if (envInflightLoads.get(ref) === load) {
      envInflightLoads.delete(ref);
    }
  });
  envInflightLoads.set(ref, load);
  return load;
}

export function invalidateTenantEnvCache(ref: string) {
  envCache.delete(ref);
  envInflightLoads.delete(ref);
}
