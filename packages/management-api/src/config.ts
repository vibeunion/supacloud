import { logger } from "./utils/logger";

interface Config {
  // Server
  port: number;
  maxRequestBodySize: number;
  nodeEnv: string;
  // Database
  databaseUrl: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
  pgDataDir: string;
  // Security
  masterToken: string;
  jwtSecret: string;
  storageSigningSecret: string;
  // Paths
  scriptsPath: string;
  pigstyPath: string;

  tenantConfigDir: string;
  edgeFunctionsDir: string;
  homePath: string;
  // S3 / Storage
  s3Endpoint: string;
  s3Region: string;
  storageType: string;
  storageMountPoint: string;
  // Internal Service URLs
  imaginaryUrl: string;
  kongAdminUrl: string;
  kongYml: string;
  victoriaMetricsUrl: string;
  realtimeAdminUrl: string;
  realtimeApiSecret: string;
  managementApiInternal: string;
  studioInternal: string;
  edgeRuntimeInternal: string;
  kongInternal: string;
  // Service Binaries / Ports
  postgrestBin: string;
  gotrueBin: string;
  pgrstPortBase: number;
  gotruePortBase: number;
  portRange: string;
  bunPath: string;
  // SSL / Domain
  enableSsl: boolean;
  acmeClient: string;
  baseDomain: string;
  poolerHost: string;
  poolerPort: number;
  // Auth / SMTP
  studioUsername: string;
  studioPassword: string;
  gotrueApiExternalUrl: string;
  gotrueSmtpHost: string;
  gotrueSmtpUser: string;
  gotrueSmtpPass: string;
  gotrueSmtpAdminEmail: string;
  // Runtime
  containerRuntime: string;
  dockerHostIp: string;
  isGithubActions: boolean;
  minDiskGb: number;
  supacloudAnsibleArgs: string;
  supacloudApiUrl: string;
  // LLM (platform-unified AI)
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    // Use Bun.spawnSync to call cat directly, leveraging OS cache and completely avoiding Node.js fs module
    const { stdout } = Bun.spawnSync(["cat", path]);
    const content = stdout ? stdout.toString() : "";
    if (!content) return {};
    
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Support more formats, ensure = exists
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
    return env;
  } catch (err: unknown) {
    logger.warn("[Config] Failed to load config from override file", { error: err });
    return {};
  }
}

// Load environment files
const managementEnv = loadEnvFile("/etc/supabase/management-api.env");
const masterTokenEnv = loadEnvFile("/etc/supabase/master-token.env");
const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const defaultEdgeRuntimeInternal = isGithubActions
  ? "127.0.0.1:9005"
  : "127.0.0.1:9000";
const defaultS3Endpoint = isGithubActions
  ? "http://127.0.0.1:9000"
  : "http://localhost:9000";

export const config = {
  // ── Server ───────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || managementEnv.PORT || "9090", 10),
  maxRequestBodySize: parseInt(
    process.env.MANAGEMENT_API_MAX_REQUEST_BODY_SIZE ||
      managementEnv.MANAGEMENT_API_MAX_REQUEST_BODY_SIZE ||
      String(1024 * 1024 * 1024),
    10,
  ),
  nodeEnv: process.env.NODE_ENV || "production",

  // ── Database ─────────────────────────────────────────────────────
  databaseUrl:
    process.env.DATABASE_URL ||
    managementEnv.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/supacloud_meta",
  pgHost: process.env.PG_HOST || process.env.POSTGRES_HOST || managementEnv.PG_HOST || "localhost",
  pgPort: parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || managementEnv.PG_PORT || "5432", 10),
  pgUser: process.env.PG_USER || managementEnv.PG_USER || "postgres",
  pgPassword: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || managementEnv.PGPASSWORD || "postgres",
  pgDatabase: process.env.PG_DATABASE || managementEnv.PG_DATABASE || "postgres",
  pgDataDir: process.env.PG_DATA_DIR || managementEnv.PG_DATA_DIR || "/pg/data",

  // ── Security ─────────────────────────────────────────────────────
  masterToken:
    process.env.MASTER_TOKEN ||
    masterTokenEnv.MASTER_TOKEN ||
    managementEnv.MASTER_TOKEN ||
    "dev-master-token",
  jwtSecret: process.env.JWT_SECRET || managementEnv.JWT_SECRET || "super-secret-jwt-token-with-at-least-32-characters-long",
  storageSigningSecret: process.env.STORAGE_SIGNING_SECRET || managementEnv.STORAGE_SIGNING_SECRET || "",

  // ── Paths ────────────────────────────────────────────────────────
  scriptsPath:
    process.env.SCRIPTS_PATH ||
    managementEnv.SCRIPTS_PATH ||
    "/opt/supacloud/scripts/lib",
  pigstyPath: process.env.PIGSTY_PATH || managementEnv.PIGSTY_PATH || "/root/pigsty",

  tenantConfigDir: process.env.TENANT_CONFIG_DIR || managementEnv.TENANT_CONFIG_DIR || "/opt/supabase/volumes/api/kong_tenants",
  edgeFunctionsDir: process.env.EDGE_FUNCTIONS_DIR || managementEnv.EDGE_FUNCTIONS_DIR || "/opt/supacloud/functions",
  homePath: process.env.HOME || "/root",

  // ── S3 / Storage ─────────────────────────────────────────────────
  s3Endpoint: process.env.S3_ENDPOINT || managementEnv.S3_ENDPOINT || defaultS3Endpoint,
  s3Region: process.env.S3_REGION || managementEnv.S3_REGION || "us-east-1",
  storageType: process.env.STORAGE_TYPE || managementEnv.STORAGE_TYPE || "local",
  storageMountPoint: process.env.STORAGE_MOUNT_POINT || managementEnv.STORAGE_MOUNT_POINT || "/data/storage",

  // ── Internal Service URLs ────────────────────────────────────────
  imaginaryUrl: process.env.IMAGINARY_URL || managementEnv.IMAGINARY_URL || "http://127.0.0.1:9010",
  kongAdminUrl: process.env.KONG_ADMIN_URL || managementEnv.KONG_ADMIN_URL || "http://localhost:8001",
  kongYml: process.env.KONG_YML || managementEnv.KONG_YML || "/opt/supabase/volumes/api/kong.yml",
  victoriaMetricsUrl: process.env.VICTORIAMETRICS_URL || managementEnv.VICTORIAMETRICS_URL || "http://127.0.0.1:8428",
  realtimeAdminUrl: process.env.REALTIME_ADMIN_URL || managementEnv.REALTIME_ADMIN_URL || "http://127.0.0.1:4000",
  realtimeApiSecret: process.env.REALTIME_API_SECRET || managementEnv.REALTIME_API_SECRET || "",
  managementApiInternal: process.env.MANAGEMENT_API_INTERNAL || managementEnv.MANAGEMENT_API_INTERNAL || "127.0.0.1:9090",
  studioInternal: process.env.STUDIO_INTERNAL || managementEnv.STUDIO_INTERNAL || "127.0.0.1:3000",
  edgeRuntimeInternal:
    process.env.EDGE_RUNTIME_INTERNAL ||
    managementEnv.EDGE_RUNTIME_INTERNAL ||
    defaultEdgeRuntimeInternal,
  kongInternal: process.env.KONG_INTERNAL || managementEnv.KONG_INTERNAL || "127.0.0.1:8000",

  // ── Service Binaries / Ports ─────────────────────────────────────
  postgrestBin: process.env.POSTGREST_BIN || managementEnv.POSTGREST_BIN || "postgrest",
  gotrueBin: process.env.GOTRUE_BIN || managementEnv.GOTRUE_BIN || "gotrue",
  pgrstPortBase: parseInt(process.env.PGRST_PORT_BASE || managementEnv.PGRST_PORT_BASE || "3100", 10),
  gotruePortBase: parseInt(process.env.GOTRUE_PORT_BASE || managementEnv.GOTRUE_PORT_BASE || "9999", 10),
  portRange: process.env.PORT_RANGE || managementEnv.PORT_RANGE || "3100-3200",
  bunPath: process.env.BUN_PATH || managementEnv.BUN_PATH || "bun",

  // ── SSL / Domain ─────────────────────────────────────────────────
  enableSsl: (process.env.ENABLE_SSL || managementEnv.ENABLE_SSL || "false") === "true",
  acmeClient: process.env.ACME_CLIENT || managementEnv.ACME_CLIENT || "acme.sh",
  baseDomain: process.env.BASE_DOMAIN || managementEnv.BASE_DOMAIN || "localhost",
  poolerHost: process.env.POOLER_HOST || managementEnv.POOLER_HOST || "",
  poolerPort: parseInt(process.env.POOLER_PORT || managementEnv.POOLER_PORT || "6543", 10),

  // ── Auth / SMTP ──────────────────────────────────────────────────
  studioUsername: process.env.STUDIO_USERNAME || managementEnv.STUDIO_USERNAME || "admin",
  studioPassword: process.env.STUDIO_PASSWORD || managementEnv.STUDIO_PASSWORD || "supacloud",
  gotrueApiExternalUrl: process.env.GOTRUE_API_EXTERNAL_URL || managementEnv.GOTRUE_API_EXTERNAL_URL || "",
  gotrueSmtpHost: process.env.GOTRUE_SMTP_HOST || managementEnv.GOTRUE_SMTP_HOST || "",
  gotrueSmtpUser: process.env.GOTRUE_SMTP_USER || managementEnv.GOTRUE_SMTP_USER || "",
  gotrueSmtpPass: process.env.GOTRUE_SMTP_PASS || managementEnv.GOTRUE_SMTP_PASS || "",
  gotrueSmtpAdminEmail: process.env.GOTRUE_SMTP_ADMIN_EMAIL || managementEnv.GOTRUE_SMTP_ADMIN_EMAIL || "",

  // ── Runtime ──────────────────────────────────────────────────────
  containerRuntime: process.env.CONTAINER_RUNTIME || managementEnv.CONTAINER_RUNTIME || "podman",
  dockerHostIp: process.env.DOCKER_HOST_IP || managementEnv.DOCKER_HOST_IP || "",
  isGithubActions,
  minDiskGb: parseInt(process.env.MIN_DISK_GB || managementEnv.MIN_DISK_GB || "2", 10),
  supacloudAnsibleArgs: process.env.SUPACLOUD_ANSIBLE_ARGS || managementEnv.SUPACLOUD_ANSIBLE_ARGS || "",
  supacloudApiUrl: process.env.SUPACLOUD_API_URL || managementEnv.SUPACLOUD_API_URL || "http://127.0.0.1:9090",

  // ── LLM (Platform AI) ─────────────────────────────────────────
  llmApiKey: process.env.LLM_API_KEY || managementEnv.LLM_API_KEY || "",
  llmEndpoint: process.env.LLM_ENDPOINT || managementEnv.LLM_ENDPOINT || "https://api.openai.com/v1/chat/completions",
  llmModel: process.env.LLM_MODEL || managementEnv.LLM_MODEL || "gpt-4o-mini",
} satisfies Config;

// Add basic validation to prevent invalid configuration from crashing downstream
function validateConfig() {
  if (!config.databaseUrl || !/^postgresql?:\/\//.test(config.databaseUrl)) {
    throw new Error("Invalid or missing DATABASE_URL configuration. Must be a valid postgres DSN string.");
  }
  if (!Number.isFinite(config.maxRequestBodySize) || config.maxRequestBodySize <= 0) {
    throw new Error("Invalid MANAGEMENT_API_MAX_REQUEST_BODY_SIZE configuration. Must be a positive integer.");
  }
  if (!config.masterToken || config.masterToken.length < 8) {
    logger.warn("WARNING: MASTER_TOKEN is dangerously short or missing. Set properly for production security.");
  }
}

validateConfig();
