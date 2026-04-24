import { existsSync, readFileSync } from "node:fs";

const MANAGEMENT_API_ENV = "/etc/supabase/management-api.env";
const LOCAL_ENV = ".env";
const CONFIG_ENV = "/opt/supacloud/config.env";

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
  }
}

loadEnvFile(MANAGEMENT_API_ENV);
loadEnvFile(CONFIG_ENV);
loadEnvFile(LOCAL_ENV);

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
  kongAdminUrl: string;
  kongYml: string;
  kongInternal: string;
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
  gotrueBin: string;
  pgrstPortBase: number;
  gotruePortBase: number;
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
}

function getEnv(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

const isGithubActions = getEnv("GITHUB_ACTIONS") === "true";
const edgeRuntimePort = Number(getEnv("EDGE_RUNTIME_PORT", "9000"));
const edgeRuntimeMode = getEnv("EDGE_RUNTIME_MODE", "embedded") === "external" ? "external" : "embedded";
const dashboardUsername = getEnv("DASHBOARD_USERNAME", getEnv("STUDIO_USERNAME", "admin"));
const dashboardPassword = getEnv("DASHBOARD_PASSWORD", getEnv("STUDIO_PASSWORD", "supabase"));
const port = Number(getEnv("PORT", "9090"));
const pgHost = getEnv("PG_HOST", "127.0.0.1");
const pgPort = Number(getEnv("PG_PORT", "5432"));
const pgUser = getEnv("PG_USER", "postgres");
const pgPassword = getEnv("PGPASSWORD", getEnv("PG_PASSWORD", "postgres"));
const pgDatabase = getEnv("PG_DATABASE", "postgres");
const edgeRuntimeInternal = getEnv("EDGE_RUNTIME_INTERNAL", `127.0.0.1:${edgeRuntimePort}`);

export const config: Config = {
  port,
  maxRequestBodySize: Number(getEnv("MANAGEMENT_API_MAX_REQUEST_BODY_SIZE", String(1024 * 1024 * 1024))),
  databaseUrl: getEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres"),
  nodeEnv: getEnv("NODE_ENV", "development"),
  isGithubActions,

  jwtSecret: getEnv("JWT_SECRET", "super-secret-jwt-token-with-at-least-32-characters-long"),
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
  kongAdminUrl: getEnv("KONG_ADMIN_URL", "http://localhost:8001"),
  kongYml: getEnv("KONG_YML", "/opt/supabase/volumes/api/kong.yml"),
  kongInternal: getEnv("KONG_INTERNAL", "127.0.0.1:8000"),
  victoriaMetricsUrl: getEnv("VICTORIAMETRICS_URL", "http://127.0.0.1:8428"),
  realtimeAdminUrl: getEnv("REALTIME_ADMIN_URL", "http://127.0.0.1:4000"),
  realtimeApiSecret: getEnv("REALTIME_API_SECRET", ""),
  managementApiInternal: getEnv("MANAGEMENT_API_INTERNAL", `127.0.0.1:${port}`),
  storageSigningSecret: getEnv("STORAGE_SIGNING_SECRET", ""),

  scriptsPath: getEnv("SCRIPTS_PATH", "/opt/supacloud/scripts/lib"),
  pigstyPath: getEnv("PIGSTY_PATH", "/root/pigsty"),
  tenantConfigDir: getEnv("TENANT_CONFIG_DIR", "/opt/supabase/volumes/api/kong_tenants"),
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
  gotrueBin: getEnv("GOTRUE_BIN", "/usr/local/bin/gotrue"),
  pgrstPortBase: Number(getEnv("PGRST_PORT_BASE", "3100")),
  gotruePortBase: Number(getEnv("GOTRUE_PORT_BASE", "3200")),
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
  acmeClient: getEnv("ACME_CLIENT", "le"),
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
};

function validateConfig() {
  if (!config.databaseUrl || !/^postgresql?:\/\//.test(config.databaseUrl)) {
    throw new Error("Invalid or missing DATABASE_URL configuration. Must be a valid postgres DSN string.");
  }
  if (!Number.isFinite(config.maxRequestBodySize) || config.maxRequestBodySize <= 0) {
    throw new Error("Invalid MANAGEMENT_API_MAX_REQUEST_BODY_SIZE configuration. Must be a positive integer.");
  }
  if (!config.masterToken || config.masterToken.length < 8) {
    console.warn("WARNING: MASTER_TOKEN is dangerously short or missing. Set properly for production security.");
  }
}

validateConfig();
