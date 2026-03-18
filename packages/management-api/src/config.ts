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
  } catch {
    return {};
  }
}

// Load environment files
const managementEnv = loadEnvFile("/etc/supabase/management-api.env");
const masterTokenEnv = loadEnvFile("/etc/supabase/master-token.env");

export const config = {
  port: parseInt(process.env.PORT || managementEnv.PORT || "9090", 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    managementEnv.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/supacloud_meta",
  masterToken:
    process.env.MASTER_TOKEN ||
    masterTokenEnv.MASTER_TOKEN ||
    managementEnv.MASTER_TOKEN ||
    "dev-master-token",
  scriptsPath:
    process.env.SCRIPTS_PATH ||
    managementEnv.SCRIPTS_PATH ||
    "/opt/supacloud/scripts/lib",

  // Pigsty/Supabase paths
  pigstyPath: process.env.PIGSTY_PATH || managementEnv.PIGSTY_PATH || "/root/pigsty",
  nginxSitesPath:
    process.env.NGINX_SITES_PATH ||
    managementEnv.NGINX_SITES_PATH ||
    "/etc/nginx/sites-enabled/supa-tenants",

  // S3 configuration
  s3Endpoint: process.env.S3_ENDPOINT || managementEnv.S3_ENDPOINT || "http://localhost:9000",
  s3Region: process.env.S3_REGION || managementEnv.S3_REGION || "us-east-1",

  // Base domain for projects
  baseDomain: process.env.BASE_DOMAIN || managementEnv.BASE_DOMAIN || "localhost",

  // Studio login credentials
  studioUsername: process.env.STUDIO_USERNAME || managementEnv.STUDIO_USERNAME || "admin",
  studioPassword: process.env.STUDIO_PASSWORD || managementEnv.STUDIO_PASSWORD || "supacloud",
};

// Add basic validation to prevent invalid configuration from crashing downstream
function validateConfig() {
  if (!config.databaseUrl || !/^postgresql?:\/\//.test(config.databaseUrl)) {
    throw new Error("Invalid or missing DATABASE_URL configuration. Must be a valid postgres DSN string.");
  }
  if (!config.masterToken || config.masterToken.length < 8) {
    console.warn("WARNING: MASTER_TOKEN is dangerously short or missing. Set properly for production security.");
  }
}

validateConfig();
