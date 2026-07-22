import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

const MANAGEMENT_API_ENV = process.env.SUPACLOUD_MANAGEMENT_ENV_FILE
  ?? "/etc/supabase/management-api.env";
const LOCAL_ENV = process.env.SUPACLOUD_LOCAL_ENV_FILE ?? ".env";
const LEGACY_CONFIG_ENV = process.env.SUPACLOUD_LEGACY_CONFIG_ENV_FILE
  ?? "/opt/supacloud/config.env";

// Tracks values injected by config files so install.ts can distinguish an
// operator's explicit process environment from runtime values loaded here.
export const loadedConfigFileEnvKeys = new Set<string>();

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    loadedConfigFileEnvKeys.add(key);
  }
}

const hasManagementRuntimeEnv = existsSync(MANAGEMENT_API_ENV);
loadEnvFile(MANAGEMENT_API_ENV);

// The tracked repository config.env is never a production runtime source by
// default. Legacy loading is explicit and cannot overwrite management env or
// process-level values because loadEnvFile only fills undefined keys.
if (process.env.SUPACLOUD_LOAD_LEGACY_CONFIG_ENV === "true") {
  loadEnvFile(LEGACY_CONFIG_ENV);
}

const runtimeNodeEnv = process.env.NODE_ENV
  ?? process.env.BUN_ENV
  ?? (hasManagementRuntimeEnv ? "production" : "development");
process.env.NODE_ENV ??= runtimeNodeEnv;
if (runtimeNodeEnv === "development" || runtimeNodeEnv === "test") {
  loadEnvFile(LOCAL_ENV);
}

type CaddyTlsIssuer = "acme" | "internal";

export interface Config {
  port: number;
  maxRequestBodySize: number;
  nodeEnv: string;
  databaseUrl: string;
  isGithubActions: boolean;
  jwtSecret: string;
  jwtIssuer: string;
  jwtEnabled: boolean;
  baseDomain: string;
  dashboardUsername: string;
  dashboardPassword: string;
  studioUsername: string;
  studioPassword: string;
  studioInternal: string;
  supacloudApiUrl: string;
  s3Endpoint: string;
  s3Region: string;
  storageType: string;
  storageMountPoint: string;
  imaginaryUrl: string;
  gatewayProvider: "caddy";
  caddyAdminUrl: string;
  caddyConfigPath: string;
  caddyStateDir: string;
  caddyBinaryPath: string;
  grafanaUrl: string;
  victoriaMetricsUrl: string;
  realtimeAdminUrl: string;
  realtimeApiSecret: string;
  managementApiInternal: string;
  storageSigningSecret: string;
  scriptsPath: string;
  pigstyPath: string;
  tenantConfigDir: string;
  edgeFunctionsDir: string;
  homePath: string;
  masterToken: string;
  logLevel: string;
  dockerHostIp: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
  pgDataDir: string;
  minDiskGb: number;
  postgrestBin: string;
  postgrestRts: string;
  postgrestMemoryMax: string;
  postgrestCpuWeight: number;
  postgrestDbPool: number;
  gotrueBin: string;
  pgrstPortBase: number;
  gotruePortBase: number;
  /** Optional project ref that exclusively owns the local GoTrue runtime. */
  authRuntimeOwnerRef: string;
  portRange: string;
  gotrueSmtpAdminEmail: string;
  gotrueSmtpHost: string;
  gotrueSmtpUser: string;
  gotrueSmtpPass: string;
  poolerHost: string;
  poolerPort: number;
  rateLimitTier: string;
  corsOrigins: string;
  dbAllowedCidrs: string;
  dbAllowedCidrsV6: string;
  containerRuntime: string;
  supacloudAnsibleArgs: string;
  enableSsl: boolean;
  acmeClient: string;
  legoBin: string;
  acmeStateDir: string;
  acmeHttpWebroot: string;
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
  edgeRuntimeMode: "embedded" | "external";
  edgeRuntimeUrl: string;
  edgeRuntimePort: number;
  edgeRuntimeInternal: string;
  edgeRuntimeBackgroundInternal: string;
  edgeRuntimeMasterKey: string;
  bunPath: string;
  sdkProxyTimeoutMs: number;
  restProxyTimeoutMs: number;
  secretsEncryptionKey: string;
  legacySecretsEncryptionKey: string;
  supaoauthBffSigningSecret: string;
  caddyTlsBlockedDomains: string[];
  /** TLS certificate issuer for on-demand Caddy certificates. */
  caddyTlsIssuer: CaddyTlsIssuer;
  hostedAuthPageEnabled: boolean;
  hostedAuthPageHost: string;
  hostedAuthPageRoot: string;
}

function getEnv(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

const DEFAULT_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DEFAULT_DASHBOARD_PASSWORDS = new Set(["supabase", "supacloud", "admin", "password", "changeme"]);
const DEVELOPMENT_ENVS = new Set(["development", "test"]);
const isGithubActions = getEnv("GITHUB_ACTIONS") === "true";
const edgeRuntimePort = Number(getEnv("EDGE_RUNTIME_PORT", "9000"));
const edgeRuntimeMode = getEnv("EDGE_RUNTIME_MODE", "embedded") === "external" ? "external" : "embedded";
const dashboardUsername = getEnv("DASHBOARD_USERNAME", getEnv("STUDIO_USERNAME", "admin"));
const dashboardPassword = getEnv("DASHBOARD_PASSWORD", getEnv("STUDIO_PASSWORD", "supabase"));
const port = Number(getEnv("PORT", "9090"));
const pgHost = getEnv("PG_HOST", "127.0.0.1");
const pgPort = Number(getEnv("PG_PORT", "5432"));
const pgUser = getEnv("PG_USER", "postgres");
const rawPgPassword = getEnv("PGPASSWORD");
const pgPassword = rawPgPassword === "" ? getEnv("PG_PASSWORD", "postgres") : rawPgPassword;
const pgDatabase = getEnv("PG_DATABASE", "postgres");
const edgeRuntimeInternal = getEnv("EDGE_RUNTIME_INTERNAL", `127.0.0.1:${edgeRuntimePort}`);

// A private listen address indicates the common single-node LAN setup. Public
// deployments behind NAT can explicitly force ACME with SUPACLOUD_CADDY_TLS_ISSUER.
function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  const addressFamily = isIP(normalized);
  if (addressFamily === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }
  if (addressFamily !== 6) return false;

  const firstHextet = Number.parseInt(normalized.split(":")[0], 16);
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function resolveCaddyTlsIssuer(explicitIssuer: string, listenAddress: string): CaddyTlsIssuer {
  const normalizedIssuer = explicitIssuer.trim().toLowerCase();
  if (normalizedIssuer === "acme" || normalizedIssuer === "internal") return normalizedIssuer;
  if (normalizedIssuer) {
    throw new Error('Invalid SUPACLOUD_CADDY_TLS_ISSUER. Expected "acme" or "internal".');
  }
  return isPrivateNetworkAddress(listenAddress) ? "internal" : "acme";
}

export const config: Config = {
  port,
  maxRequestBodySize: Number(getEnv("MANAGEMENT_API_MAX_REQUEST_BODY_SIZE", String(1024 * 1024 * 1024))),
  databaseUrl: getEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres"),
  nodeEnv: getEnv("NODE_ENV", runtimeNodeEnv),
  isGithubActions,

  jwtSecret: getEnv("JWT_SECRET", getEnv("SUPACLOUD_JWT_SECRET", DEFAULT_JWT_SECRET)),
  jwtIssuer: getEnv("JWT_ISSUER", "supacloud"),
  jwtEnabled: getEnv("JWT_ENABLED", "false") === "true",
  baseDomain: getEnv("BASE_DOMAIN", "example.com"),
  dashboardUsername,
  dashboardPassword,
  studioUsername: getEnv("STUDIO_USERNAME", dashboardUsername),
  studioPassword: getEnv("STUDIO_PASSWORD", dashboardPassword),
  studioInternal: getEnv("STUDIO_INTERNAL", "127.0.0.1:3000"),
  supacloudApiUrl: getEnv("SUPACLOUD_API_URL", `http://${getEnv("MANAGEMENT_API_INTERNAL", `127.0.0.1:${port}`)}`),

  s3Endpoint: getEnv("S3_ENDPOINT", isGithubActions ? "http://127.0.0.1:9000" : "http://localhost:9000"),
  s3Region: getEnv("S3_REGION", "us-east-1"),
  storageType: getEnv("S3_STORAGE_TYPE", getEnv("STORAGE_TYPE", "juicefs")),
  storageMountPoint: getEnv("STORAGE_MOUNT_POINT", "/data/storage"),

  imaginaryUrl: getEnv("IMAGINARY_URL", "http://127.0.0.1:9010"),
  gatewayProvider: "caddy",
  caddyAdminUrl: getEnv("CADDY_ADMIN_URL", "http://127.0.0.1:2019"),
  caddyConfigPath: getEnv(
    "CADDY_CONFIG_PATH",
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      ? "/tmp/supacloud-caddy-test/config.json"
      : "/etc/supacloud/caddy/config.json",
  ),
  caddyStateDir: getEnv(
    "CADDY_STATE_DIR",
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      ? "/tmp/supacloud-caddy-test/state"
      : "/var/lib/supacloud/caddy",
  ),
  caddyBinaryPath: getEnv("CADDY_BINARY_PATH", "/usr/local/bin/supacloud-caddy"),
  grafanaUrl: getEnv("GRAFANA_URL", "http://127.0.0.1:3000"),
  victoriaMetricsUrl: getEnv("VICTORIAMETRICS_URL", "http://127.0.0.1:8428"),
  realtimeAdminUrl: getEnv("REALTIME_ADMIN_URL", "http://127.0.0.1:4000"),
  realtimeApiSecret: getEnv("REALTIME_API_SECRET", ""),
  managementApiInternal: getEnv("MANAGEMENT_API_INTERNAL", `127.0.0.1:${port}`),
  storageSigningSecret: getEnv("STORAGE_SIGNING_SECRET", ""),

  scriptsPath: getEnv("SCRIPTS_PATH", "/opt/supacloud/scripts/lib"),
  pigstyPath: getEnv("PIGSTY_PATH", "/root/pigsty"),
  tenantConfigDir: getEnv("TENANT_CONFIG_DIR", "/etc/supabase/tenants"),
  edgeFunctionsDir: getEnv("EDGE_FUNCTIONS_DIR", "/opt/supacloud/functions"),
  homePath: getEnv("HOME", "/root"),
  masterToken: getEnv(
    "MASTER_TOKEN",
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      ? "dev-master-token"
      : "",
  ),
  logLevel: getEnv("LOG_LEVEL", "info"),
  dockerHostIp: getEnv("DOCKER_HOST_IP", getEnv("INTERNAL_IP", "127.0.0.1")),

  pgHost,
  pgPort,
  pgUser,
  pgPassword,
  pgDatabase,
  pgDataDir: getEnv("PG_DATA_DIR", "/var/lib/pgsql/data"),
  minDiskGb: Number(getEnv("MIN_DISK_GB", "10")),
  postgrestBin: getEnv("POSTGREST_BIN", "/usr/local/bin/postgrest"),
  postgrestRts: getEnv("POSTGREST_RTS", "-N1 -M256m -I0.5 -A4m"),
  postgrestMemoryMax: getEnv("POSTGREST_MEMORY_MAX", "384M"),
  postgrestCpuWeight: Number(getEnv("POSTGREST_CPU_WEIGHT", "40")),
  postgrestDbPool: Number(getEnv("POSTGREST_DB_POOL", "10")),
  gotrueBin: getEnv("GOTRUE_BIN", "/usr/local/bin/gotrue"),
  pgrstPortBase: Number(getEnv("PGRST_PORT_BASE", "3100")),
  gotruePortBase: Number(getEnv("GOTRUE_PORT_BASE", "3200")),
  authRuntimeOwnerRef: getEnv("SUPACLOUD_AUTH_RUNTIME_OWNER_REF", "").trim(),
  portRange: getEnv("PORT_RANGE", "3100-3299"),
  gotrueSmtpAdminEmail: getEnv("GOTRUE_SMTP_ADMIN_EMAIL", ""),
  gotrueSmtpHost: getEnv("GOTRUE_SMTP_HOST", ""),
  gotrueSmtpUser: getEnv("GOTRUE_SMTP_USER", ""),
  gotrueSmtpPass: getEnv("GOTRUE_SMTP_PASS", ""),
  poolerHost: getEnv("POOLER_HOST", pgHost),
  poolerPort: Number(getEnv("POOLER_PORT", "6543")),
  rateLimitTier: getEnv("RATE_LIMIT_TIER", ""),
  corsOrigins: getEnv("CORS_ORIGINS", ""),
  dbAllowedCidrs: getEnv("DB_ALLOWED_CIDRS", ""),
  dbAllowedCidrsV6: getEnv("DB_ALLOWED_CIDRS_V6", ""),
  containerRuntime: getEnv("CONTAINER_RUNTIME", "podman"),
  supacloudAnsibleArgs: getEnv("SUPACLOUD_ANSIBLE_ARGS", ""),
  enableSsl: getEnv("ENABLE_SSL", "true") !== "false",
  acmeClient: getEnv("ACME_CLIENT", "lego"),
  legoBin: getEnv("LEGO_BIN", "lego"),
  acmeStateDir: getEnv("ACME_STATE_DIR", "/var/lib/supacloud/lego"),
  acmeHttpWebroot: getEnv("ACME_HTTP_WEBROOT", "/var/lib/supacloud/acme-challenges"),
  llmApiKey: getEnv("LLM_API_KEY", ""),
  llmEndpoint: getEnv("LLM_ENDPOINT", "https://api.openai.com/v1/chat/completions"),
  llmModel: getEnv("LLM_MODEL", "gpt-4o-mini"),

  edgeRuntimeMode,
  edgeRuntimeUrl: getEnv("EDGE_RUNTIME_URL", `http://127.0.0.1:${edgeRuntimePort}`),
  edgeRuntimePort,
  edgeRuntimeInternal,
  edgeRuntimeBackgroundInternal: getEnv("EDGE_RUNTIME_BACKGROUND_INTERNAL", edgeRuntimeInternal),
  edgeRuntimeMasterKey: getEnv(
    "EDGE_RUNTIME_MASTER_KEY",
    getEnv(
      "MASTER_TOKEN",
      process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
        ? "dev-master-token"
        : "",
    ),
  ),
  bunPath: getEnv("BUN_PATH", "bun"),
  sdkProxyTimeoutMs: Number(getEnv("SDK_PROXY_TIMEOUT_MS", "30000")),
  restProxyTimeoutMs: Number(getEnv("REST_PROXY_TIMEOUT_MS", "300000")),
  secretsEncryptionKey: getEnv(
    "SECRETS_ENCRYPTION_KEY",
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      ? "dev-secrets-encryption-key-change-me"
      : "",
  ),
  legacySecretsEncryptionKey: getEnv("LEGACY_SECRETS_ENCRYPTION_KEY"),
  supaoauthBffSigningSecret: getEnv(
    "SUPAOAUTH_BFF_SIGNING_SECRET",
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
      ? "dev-supaoauth-bff-signing-secret-change-me"
      : "",
  ),
  caddyTlsBlockedDomains: getEnv("CADDY_TLS_BLOCKED_DOMAINS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  caddyTlsIssuer: resolveCaddyTlsIssuer(
    getEnv("SUPACLOUD_CADDY_TLS_ISSUER"),
    getEnv("DOCKER_HOST_IP", getEnv("INTERNAL_IP", "127.0.0.1")),
  ),

  hostedAuthPageEnabled: getEnv("HOSTED_AUTH_PAGE_ENABLED", getEnv("SUPAUTH_HOSTED_LOGIN_ENABLED", "false")) === "true",
  hostedAuthPageHost: getEnv("HOSTED_AUTH_PAGE_HOST", getEnv("SUPAUTH_HOSTED_LOGIN_HOST", "")),
  hostedAuthPageRoot: getEnv("HOSTED_AUTH_PAGE_ROOT", getEnv("SUPAUTH_HOSTED_LOGIN_PAGE_ROOT", "")),
};

function validateConfig() {
  if (!config.databaseUrl || !/^postgres(?:ql)?:\/\//.test(config.databaseUrl)) {
    throw new Error("Invalid or missing DATABASE_URL configuration. Must be a valid postgres DSN string.");
  }
  if (!Number.isFinite(config.maxRequestBodySize) || config.maxRequestBodySize <= 0) {
    throw new Error("Invalid MANAGEMENT_API_MAX_REQUEST_BODY_SIZE configuration. Must be a positive integer.");
  }
  if (!Number.isFinite(config.sdkProxyTimeoutMs) || config.sdkProxyTimeoutMs <= 0) {
    throw new Error("Invalid SDK_PROXY_TIMEOUT_MS configuration. Must be a positive integer.");
  }
  if (!Number.isFinite(config.restProxyTimeoutMs) || config.restProxyTimeoutMs <= 0) {
    throw new Error("Invalid REST_PROXY_TIMEOUT_MS configuration. Must be a positive integer.");
  }

  const isDevelopment = DEVELOPMENT_ENVS.has(config.nodeEnv) || process.env.BUN_ENV === "test" || config.isGithubActions;
  const weakMasterToken = !config.masterToken || config.masterToken.length < 32 || config.masterToken === "dev-master-token";
  const weakJwtSecret = !config.jwtSecret || config.jwtSecret.length < 32 || config.jwtSecret === DEFAULT_JWT_SECRET;
  const weakDashboardPassword = !config.dashboardPassword || config.dashboardPassword.length < 12 || DEFAULT_DASHBOARD_PASSWORDS.has(config.dashboardPassword.toLowerCase());
  const weakSecretsEncryptionKey = !config.secretsEncryptionKey
    || config.secretsEncryptionKey.length < 32
    || config.secretsEncryptionKey === "dev-master-token"
    || config.secretsEncryptionKey === config.masterToken;
  const invalidLegacyEncryptionKey = Boolean(config.legacySecretsEncryptionKey)
    && (config.legacySecretsEncryptionKey.length < 32
      || config.legacySecretsEncryptionKey === config.secretsEncryptionKey);
  const weakBffSigningSecret = !config.supaoauthBffSigningSecret
    || config.supaoauthBffSigningSecret.length < 32
    || config.supaoauthBffSigningSecret === config.masterToken
    || config.supaoauthBffSigningSecret === config.secretsEncryptionKey
    || config.supaoauthBffSigningSecret === config.legacySecretsEncryptionKey;

  if (isDevelopment) {
    if (weakMasterToken) {
      console.warn("WARNING: MASTER_TOKEN is weak or missing. Set a 32+ character random value before production use.");
    }
    if (weakJwtSecret) {
      console.warn("WARNING: JWT_SECRET uses a development default. Set a high-entropy secret before production use.");
    }
    if (weakDashboardPassword) {
      console.warn("WARNING: DASHBOARD_PASSWORD is weak or default. Set a stronger password before production use.");
    }
    if (weakSecretsEncryptionKey) {
      console.warn("WARNING: SECRETS_ENCRYPTION_KEY is weak, missing, or shared with MASTER_TOKEN. Set an independent 32+ character random value before using the secret store.");
    }
    if (invalidLegacyEncryptionKey) {
      console.warn("WARNING: LEGACY_SECRETS_ENCRYPTION_KEY must be a distinct value of at least 32 characters when used for migration.");
    }
    if (weakBffSigningSecret) {
      console.warn("WARNING: SUPAOAUTH_BFF_SIGNING_SECRET is weak or missing. Set an independent 32+ character random value before production use.");
    }
    return;
  }

  if (weakMasterToken) {
    throw new Error("MASTER_TOKEN must be set to a non-default random value of at least 32 characters in production.");
  }
  if (weakJwtSecret) {
    throw new Error("JWT_SECRET must be set to a non-default random value of at least 32 characters in production.");
  }
  if (weakDashboardPassword) {
    throw new Error("DASHBOARD_PASSWORD must be set to a non-default password of at least 12 characters in production.");
  }
  if (weakSecretsEncryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be an independent non-default random value of at least 32 characters in production.");
  }
  if (invalidLegacyEncryptionKey) {
    throw new Error("LEGACY_SECRETS_ENCRYPTION_KEY must be a distinct value of at least 32 characters when used for migration.");
  }
  if (weakBffSigningSecret) {
    throw new Error("SUPAOAUTH_BFF_SIGNING_SECRET must be set to an independent random value of at least 32 characters in production.");
  }
}

validateConfig();
