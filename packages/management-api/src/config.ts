import { logger } from "./utils/logger";

interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
  pgDataDir: string;
  masterToken: string;
  jwtSecret: string;
  storageSigningSecret: string;
  scriptsPath: string;
  pigstyPath: string;
  tenantConfigDir: string;
  edgeFunctionsDir: string;
  homePath: string;
  s3Endpoint: string;
  s3Region: string;
  storageType: string;
  storageMountPoint: string;
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
  postgrestBin: string;
  gotrueBin: string;
  pgrstPortBase: number;
  gotruePortBase: number;
  portRange: string;
  bunPath: string;
  enableSsl: boolean;
  acmeClient: string;
  baseDomain: string;
  poolerHost: string;
  poolerPort: number;
  studioUsername: string;
  studioPassword: string;
  gotrueApiExternalUrl: string;
  gotrueSmtpHost: string;
  gotrueSmtpUser: string;
  gotrueSmtpPass: string;
  gotrueSmtpAdminEmail: string;
  containerRuntime: string;
  dockerHostIp: string;
  isGithubActions: boolean;
  minDiskGb: number;
  supacloudAnsibleArgs: string;
  supacloudApiUrl: string;
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
}

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    const fs = require("fs");
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content) return {};

    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
    return env;
  } catch {
    return {};
  }
}

const envFiles = [
  "/opt/supacloud/config.env",
  "/etc/supabase/management-api.env",
  "/etc/supabase/master-token.env",
];

const fileEnvs: Record<string, string> = {};
for (const p of envFiles) {
  Object.assign(fileEnvs, loadEnvFile(p));
}

const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const isDev = (process.env.NODE_ENV || "production") !== "production";

function getEnv(key: string, fallback?: string): string {
  return process.env[key] || fileEnvs[key] || fallback || "";
}

export const config = {
  port: parseInt(getEnv("PORT", "9090"), 10),
  nodeEnv: getEnv("NODE_ENV", "production"),

  databaseUrl: getEnv("DATABASE_URL", isDev ? "postgresql://postgres:postgres@localhost:5432/supacloud_meta" : ""),
  pgHost: getEnv("PG_HOST", getEnv("POSTGRES_HOST", "localhost")),
  pgPort: parseInt(getEnv("PG_PORT", getEnv("POSTGRES_PORT", "5432")), 10),
  pgUser: getEnv("PG_USER", "postgres"),
  pgPassword: getEnv("PGPASSWORD", getEnv("POSTGRES_PASSWORD", isDev ? "postgres" : "")),
  pgDatabase: getEnv("PG_DATABASE", "postgres"),
  pgDataDir: getEnv("PG_DATA_DIR", "/pg/data"),

  masterToken: getEnv("MASTER_TOKEN", isDev ? "dev-master-token" : ""),
  jwtSecret: getEnv("JWT_SECRET", isDev ? "super-secret-jwt-token-with-at-least-32-characters-long" : ""),
  storageSigningSecret: getEnv("STORAGE_SIGNING_SECRET", ""),

  scriptsPath: getEnv("SCRIPTS_PATH", "/opt/supacloud/scripts/lib"),
  pigstyPath: getEnv("PIGSTY_PATH", "/root/pigsty"),
  tenantConfigDir: getEnv("TENANT_CONFIG_DIR", "/opt/supabase/volumes/api/kong_tenants"),
  edgeFunctionsDir: getEnv("EDGE_FUNCTIONS_DIR", "/opt/supacloud/functions"),
  homePath: getEnv("HOME", "/root"),

  s3Endpoint: getEnv("S3_ENDPOINT", isGithubActions ? "http://127.0.0.1:9000" : "http://localhost:9000"),
  s3Region: getEnv("S3_REGION", "us-east-1"),
  storageType: getEnv("STORAGE_TYPE", "local"),
  storageMountPoint: getEnv("STORAGE_MOUNT_POINT", "/data/storage"),

  imaginaryUrl: getEnv("IMAGINARY_URL", "http://127.0.0.1:9010"),
  kongAdminUrl: getEnv("KONG_ADMIN_URL", "http://localhost:8001"),
  kongYml: getEnv("KONG_YML", "/opt/supabase/volumes/api/kong.yml"),
  victoriaMetricsUrl: getEnv("VICTORIAMETRICS_URL", "http://127.0.0.1:8428"),
  realtimeAdminUrl: getEnv("REALTIME_ADMIN_URL", "http://127.0.0.1:4000"),
  realtimeApiSecret: getEnv("REALTIME_API_SECRET", ""),
  managementApiInternal: getEnv("MANAGEMENT_API_INTERNAL", "127.0.0.1:9090"),
  studioInternal: getEnv("STUDIO_INTERNAL", "127.0.0.1:3000"),
  edgeRuntimeInternal: getEnv("EDGE_RUNTIME_INTERNAL", isGithubActions ? "127.0.0.1:9005" : "127.0.0.1:9000"),
  kongInternal: getEnv("KONG_INTERNAL", "127.0.0.1:8000"),

  postgrestBin: getEnv("POSTGREST_BIN", "postgrest"),
  gotrueBin: getEnv("GOTRUE_BIN", "gotrue"),
  pgrstPortBase: parseInt(getEnv("PGRST_PORT_BASE", "3100"), 10),
  gotruePortBase: parseInt(getEnv("GOTRUE_PORT_BASE", "9999"), 10),
  portRange: getEnv("PORT_RANGE", "3100-3200"),
  bunPath: getEnv("BUN_PATH", "bun"),

  enableSsl: getEnv("ENABLE_SSL", "false") === "true",
  acmeClient: getEnv("ACME_CLIENT", "acme.sh"),
  baseDomain: getEnv("BASE_DOMAIN", "localhost"),
  poolerHost: getEnv("POOLER_HOST", ""),
  poolerPort: parseInt(getEnv("POOLER_PORT", "6543"), 10),

  studioUsername: getEnv("STUDIO_USERNAME", "admin"),
  studioPassword: getEnv("STUDIO_PASSWORD", isDev ? "supacloud" : ""),
  gotrueApiExternalUrl: getEnv("GOTRUE_API_EXTERNAL_URL", ""),
  gotrueSmtpHost: getEnv("GOTRUE_SMTP_HOST", ""),
  gotrueSmtpUser: getEnv("GOTRUE_SMTP_USER", ""),
  gotrueSmtpPass: getEnv("GOTRUE_SMTP_PASS", ""),
  gotrueSmtpAdminEmail: getEnv("GOTRUE_SMTP_ADMIN_EMAIL", ""),

  containerRuntime: getEnv("CONTAINER_RUNTIME", "podman"),
  dockerHostIp: getEnv("DOCKER_HOST_IP", ""),
  isGithubActions,
  minDiskGb: parseInt(getEnv("MIN_DISK_GB", "2"), 10),
  supacloudAnsibleArgs: getEnv("SUPACLOUD_ANSIBLE_ARGS", ""),
  supacloudApiUrl: getEnv("SUPACLOUD_API_URL", "http://127.0.0.1:9090"),

  llmApiKey: getEnv("LLM_API_KEY", ""),
  llmEndpoint: getEnv("LLM_ENDPOINT", "https://api.openai.com/v1/chat/completions"),
  llmModel: getEnv("LLM_MODEL", "gpt-4o-mini"),
} satisfies Config;

function validateConfig() {
  const errors: string[] = [];

  if (!config.databaseUrl || !/^postgresql?:\/\//.test(config.databaseUrl)) {
    errors.push("DATABASE_URL must be a valid postgres DSN string");
  }
  if (!config.masterToken) {
    errors.push("MASTER_TOKEN is required. Set it via environment variable or /etc/supabase/master-token.env");
  } else if (config.masterToken.length < 8) {
    logger.warn("[Config] WARNING: MASTER_TOKEN is dangerously short (< 8 chars). Use a strong token for production.");
  }
  if (!config.jwtSecret && !isDev) {
    errors.push("JWT_SECRET is required in production");
  } else if (config.jwtSecret && config.jwtSecret.length < 32) {
    logger.warn("[Config] WARNING: JWT_SECRET is too short (< 32 chars). This may cause security issues.");
  }
  if (!config.studioPassword && !isDev) {
    errors.push("STUDIO_PASSWORD is required in production");
  }
  if (config.masterToken === "dev-master-token" && !isDev) {
    logger.warn("[Config] WARNING: Using default dev MASTER_TOKEN in production! This is a security risk.");
  }
  if (config.studioPassword === "supacloud" && !isDev) {
    logger.warn("[Config] WARNING: Using default STUDIO_PASSWORD in production! Change it immediately.");
  }

  if (errors.length > 0) {
    const msg = "Configuration validation failed:\n" + errors.map(e => `  - ${e}`).join("\n");
    if (isDev) {
      logger.warn(msg);
    } else {
      throw new Error(msg);
    }
  }
}

validateConfig();
