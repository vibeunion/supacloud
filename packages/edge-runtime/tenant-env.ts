import { createHmac } from "node:crypto";

const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";

const TENANTS_DIRS = [
  process.env.TENANTS_DIR || "/etc/supabase/tenants",
  "/opt/supacloud/tenants",
];

export type TenantEnvLoadSource = "management_api" | "stale_cache" | "file_fallback";
export type TenantEnvLoadState = "loaded" | "unverified";
export type TenantEnvExecutionProfile = "foreground" | "background";

export interface TenantEnvLoad {
  env: Record<string, string>;
  revision: string | null;
  envProof: string | null;
  loadState: TenantEnvLoadState;
  loadSource: TenantEnvLoadSource;
  cacheEpoch: number;
}

export interface RuntimeEnvObservation {
  schema: "supacloud.edge-runtime-env-observation.v1";
  project_ref: string;
  loaded_revision: string | null;
  env_proof: string | null;
  load_state: "loaded" | "unverified" | "not_loaded";
  load_source: TenantEnvLoadSource | null;
  loaded_at: string | null;
}

export interface TenantEnvDispatchReservation {
  ordinal: number;
  cacheEpoch: number;
}

type CachedTenantEnv = TenantEnvLoad & { expiresAt: number };

const envCache = new Map<string, CachedTenantEnv>();
const envInflightLoads = new Map<string, Promise<TenantEnvLoad>>();
const cacheEpochs = new Map<string, number>();
const dispatchOrdinals = new Map<string, number>();
const loadedObservations = new Map<string, {
  ordinal: number;
  observation: RuntimeEnvObservation;
}>();
const ENV_CACHE_TTL = 5_000;
const ENV_FALLBACK_CACHE_TTL = 30_000;
const MASKED_SECRET_VALUE = "********";
const ATTESTED_REVISION_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
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

type ApiRuntimeEnv = {
  env: Record<string, string>;
  revision: string | null;
};

function runtimeEnvRecord(payload: unknown): Record<string, string> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const entries = Object.entries(payload);
  if (!entries.every(([, value]) => typeof value === "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

async function loadEnvFromApi(ref: string): Promise<ApiRuntimeEnv | null> {
  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${ref}/internal/runtime-env`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 404) {
      // 明文运行时环境只允许通过 master-only internal/runtime-env 获取。
      // 旧的 /secrets?reveal=true 端点现在始终掩码，不能作为运行时回退，
      // 否则混合版本部署会把“掩码值”误注入 GoTrue/Edge Function 环境。
      console.warn(`[tenant-env] runtime-env endpoint missing for ${ref}; refusing legacy masked secrets endpoint`);
      return null;
    }

    if (!res.ok) {
      console.warn(
        `[tenant-env] API returned ${res.status} for ${ref}, falling back to stale cache or file`
      );
      return null;
    }

    const env = runtimeEnvRecord(await res.json());
    if (!env) return null;
    const revisionHeader = res.headers.get("x-supacloud-runtime-env-revision");
    return {
      env,
      revision: revisionHeader && ATTESTED_REVISION_PATTERN.test(revisionHeader)
        ? revisionHeader
        : null,
    };
  } catch (err) {
    console.warn(
      `[tenant-env] API error for ${ref}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function canonicalRuntimeEnv(env: Record<string, string>): string {
  return JSON.stringify(Object.keys(env).sort().map((name) => [name, env[name]]));
}

function keyedEnvProof(
  domain: "env" | "module-env",
  ref: string,
  payload: string,
): string {
  const digest = createHmac("sha256", MASTER_TOKEN)
    .update(`supacloud:edge-runtime-${domain}-proof:v1\0`, "utf8")
    .update(ref, "utf8")
    .update("\0", "utf8")
    .update(payload, "utf8")
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

function runtimeEnvProof(ref: string, env: Record<string, string>): string {
  return keyedEnvProof("env", ref, canonicalRuntimeEnv(env));
}

function verifiedApiLoad(
  ref: string,
  apiEnv: ApiRuntimeEnv,
  cacheEpoch: number,
): TenantEnvLoad {
  const env = { ...apiEnv.env };
  const verified = apiEnv.revision !== null && MASTER_TOKEN.length > 0;
  return {
    env,
    revision: verified ? apiEnv.revision : null,
    envProof: verified ? runtimeEnvProof(ref, env) : null,
    loadState: verified ? "loaded" : "unverified",
    loadSource: "management_api",
    cacheEpoch,
  };
}

function fallbackLoad(
  ref: string,
  fileEnv: Record<string, string>,
  cacheEpoch: number,
  cached?: CachedTenantEnv,
): TenantEnvLoad {
  return {
    env: buildFallbackTenantEnv(ref, fileEnv, cached?.env),
    revision: null,
    envProof: null,
    loadState: "unverified",
    loadSource: cached ? "stale_cache" : "file_fallback",
    cacheEpoch,
  };
}

async function loadTenantEnvUncached(ref: string, cacheEpoch: number): Promise<TenantEnvLoad> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const fileEnv = stripMaskedSecretValues(await loadEnvFromFile(ref));

  const apiEnv = await loadEnvFromApi(ref);
  if (apiEnv === null) {
    const fallback = fallbackLoad(ref, fileEnv, cacheEpoch, cached);
    if ((cacheEpochs.get(ref) || 0) === cacheEpoch) {
      envCache.set(ref, { ...fallback, expiresAt: Date.now() + ENV_FALLBACK_CACHE_TTL });
    }
    return fallback;
  }

  const loaded = verifiedApiLoad(ref, apiEnv, cacheEpoch);
  if ((cacheEpochs.get(ref) || 0) === cacheEpoch) {
    envCache.set(ref, { ...loaded, expiresAt: Date.now() + ENV_CACHE_TTL });
  }
  return loaded;
}

export async function loadTenantRuntimeEnv(ref: string): Promise<TenantEnvLoad> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const inflight = envInflightLoads.get(ref);
  if (inflight) {
    return inflight;
  }

  const cacheEpoch = cacheEpochs.get(ref) || 0;
  const load = loadTenantEnvUncached(ref, cacheEpoch).then((loaded) => {
    if ((cacheEpochs.get(ref) || 0) === cacheEpoch) return loaded;
    return loadTenantRuntimeEnv(ref);
  }).finally(() => {
    if (envInflightLoads.get(ref) === load) {
      envInflightLoads.delete(ref);
    }
  });
  envInflightLoads.set(ref, load);
  return load;
}

export async function loadTenantEnv(ref: string): Promise<Record<string, string>> {
  return (await loadTenantRuntimeEnv(ref)).env;
}

export function tenantEnvModuleProof(
  ref: string,
  env: Record<string, string>,
  load: Pick<TenantEnvLoad, "revision" | "loadState" | "loadSource">,
  executionProfile: TenantEnvExecutionProfile,
): string | null {
  if (!MASTER_TOKEN) return null;
  return keyedEnvProof("module-env", ref, JSON.stringify({
    executionProfile,
    revision: load.revision,
    state: load.loadState,
    source: load.loadSource,
    env: canonicalRuntimeEnv(env),
  }));
}

export function reserveTenantEnvDispatch(ref: string): TenantEnvDispatchReservation {
  const cacheEpoch = cacheEpochs.get(ref) || 0;
  const ordinal = (dispatchOrdinals.get(ref) || 0) + 1;
  dispatchOrdinals.set(ref, ordinal);
  return { ordinal, cacheEpoch };
}

export function isTenantEnvLoadCurrent(ref: string, load: TenantEnvLoad): boolean {
  return load.cacheEpoch === (cacheEpochs.get(ref) || 0);
}

export function recordTenantEnvDispatch(
  ref: string,
  load: TenantEnvLoad,
  reservation: TenantEnvDispatchReservation,
): void {
  if (!isTenantEnvLoadCurrent(ref, load)) return;
  if ((cacheEpochs.get(ref) || 0) !== reservation.cacheEpoch) return;
  if ((loadedObservations.get(ref)?.ordinal || 0) >= reservation.ordinal) return;
  const verified = load.loadState === "loaded" && load.revision !== null && load.envProof !== null;
  loadedObservations.set(ref, {
    ordinal: reservation.ordinal,
    observation: {
      schema: "supacloud.edge-runtime-env-observation.v1",
      project_ref: ref,
      loaded_revision: verified ? load.revision : null,
      env_proof: verified ? load.envProof : null,
      load_state: verified ? "loaded" : "unverified",
      load_source: load.loadSource,
      loaded_at: new Date().toISOString(),
    },
  });
}

export function runtimeEnvObservation(ref: string): RuntimeEnvObservation {
  return loadedObservations.get(ref)?.observation || {
    schema: "supacloud.edge-runtime-env-observation.v1",
    project_ref: ref,
    loaded_revision: null,
    env_proof: null,
    load_state: "not_loaded",
    load_source: null,
    loaded_at: null,
  };
}

export function invalidateTenantEnvCache(ref: string) {
  cacheEpochs.set(ref, (cacheEpochs.get(ref) || 0) + 1);
  envCache.delete(ref);
  envInflightLoads.delete(ref);
}
