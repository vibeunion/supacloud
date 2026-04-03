import fs from "node:fs/promises";
import { logger } from "../utils/logger";
import { config } from "../config";
import path from "node:path";
import { shellService } from "./shell.service";

export interface ProjectDomains {
  apiDomain: string;
  studioDomain: string;
}

export class RouterService {
  private get ANGIE_SITES_DIR() { return config.angieSitesDir; }
  private get KONG_INTERNAL() { return config.kongInternal; }
  private get STUDIO_INTERNAL() { return config.studioInternal; }
  private get MANAGEMENT_API_INTERNAL() { return config.managementApiInternal; }
  private get EDGE_RUNTIME_INTERNAL() { return config.edgeRuntimeInternal; }
  private get BASE_DOMAIN() { return config.baseDomain; }
  private get ENABLE_SSL() { return config.enableSsl; }
  private get ACME_CLIENT() { return config.acmeClient; }

  getProjectApiUrl(projectRef: string, customDomain?: string): string {
    if (customDomain) {
      return `https://api.${customDomain}`;
    }
    return `https://${projectRef}.api.${this.BASE_DOMAIN}`;
  }

  getProjectStudioUrl(projectRef: string, customDomain?: string): string {
    if (customDomain) {
      return `https://studio.${customDomain}`;
    }
    return `https://studio-${projectRef}.${this.BASE_DOMAIN}`;
  }

  getProjectDomain(projectRef: string): string {
    return `${projectRef}.${this.BASE_DOMAIN}`;
  }

  async addRoute(projectRef: string, domains?: ProjectDomains): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = domains?.apiDomain || `${projectRef}.api.${this.BASE_DOMAIN}`;
      const studioDomain = domains?.studioDomain || `studio-${projectRef}.${this.BASE_DOMAIN}`;
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);

      await fs.mkdir(this.ANGIE_SITES_DIR, { recursive: true });

      const kong = this.KONG_INTERNAL;
      const acmeClient = this.ACME_CLIENT;

      let config: string;

      if (this.ENABLE_SSL) {
        config = `# SupaCloud tenant: ${projectRef}
# Generated: ${new Date().toISOString()}

# --- API Endpoint ---
server {
    listen 80;
    listen 443 ssl;
    server_name ${apiDomain};

    acme ${acmeClient};
    ssl_certificate $acme_cert_${acmeClient};
    ssl_certificate_key $acme_cert_key_${acmeClient};

    add_header x-project-ref ${projectRef} always;

    # Edge Functions — direct to edge-runtime (bypass Kong for lower latency)
    location /functions/v1/ {
        proxy_pass http://${this.EDGE_RUNTIME_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};
    }

    # Storage render endpoint (cache disabled - requires proxy_cache_path pre-configuration)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header x-project-ref ${projectRef};
    }

    # MCP endpoint — direct to management API (uses its own auth)
    location /mcp {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
        proxy_read_timeout 300;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}

# --- Studio Endpoint ---
server {
    listen 80;
    listen 443 ssl;
    server_name ${studioDomain};

    acme ${acmeClient};
    ssl_certificate $acme_cert_${acmeClient};
    ssl_certificate_key $acme_cert_key_${acmeClient};

    add_header x-project-ref ${projectRef} always;

    # Studio login/verify — pass directly to management API
    location /auth/login {
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /auth/verify {
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # GoTrue auth endpoints (rewrite /auth/* to /auth/v1/)
    location /auth {
        rewrite ^/auth/(.*)$ /auth/v1/$1 break;
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Grafana reverse proxy
    location /grafana/ {
        proxy_pass http://${this.STUDIO_INTERNAL}/grafana/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # API routes to Management API
    location /api {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other routes — SPA served by management API
    location / {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
      } else {
        config = `# SupaCloud tenant: ${projectRef}
# Generated: ${new Date().toISOString()}
# Note: SSL disabled (ENABLE_SSL not set)

# --- API Endpoint ---
server {
    listen 80;
    server_name ${apiDomain};

    add_header x-project-ref ${projectRef} always;

    # Edge Functions — direct to edge-runtime (bypass Kong for lower latency)
    location /functions/v1/ {
        proxy_pass http://${this.EDGE_RUNTIME_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};
    }

    # Storage render endpoint (cache disabled - requires proxy_cache_path pre-configuration)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header x-project-ref ${projectRef};
    }

    # MCP endpoint — direct to management API (uses its own auth)
    location /mcp {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
        proxy_read_timeout 300;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}

# --- Studio Endpoint ---
server {
    listen 80;
    server_name ${studioDomain};

    add_header x-project-ref ${projectRef} always;

    # Studio login/verify — pass directly to management API
    location /auth/login {
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /auth/verify {
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # GoTrue auth endpoints (rewrite /auth/* to /auth/v1/)
    location /auth {
        rewrite ^/auth/(.*)$ /auth/v1/$1 break;
        proxy_read_timeout 120s;
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Grafana reverse proxy
    location /grafana/ {
        proxy_pass http://${this.STUDIO_INTERNAL}/grafana/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # API routes to Management API
    location /api {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other routes — SPA served by management API
    location / {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
      }

      await fs.writeFile(configFile, config, "utf-8");
      logger.info(`Route added for ${projectRef} (api: ${apiDomain})`);

      const testResult = await shellService.executeCommand("angie", ["-t"]);
      if (!testResult.success) {
        logger.error("Angie config test failed:", testResult.output);
        await fs.unlink(configFile).catch(() => { });
        return { success: false, error: testResult.output };
      }

      const reloadResult = await shellService.executeCommand("angie", ["-s", "reload"]);
      if (!reloadResult.success) {
        logger.error("Angie reload failed:", reloadResult.output);
        return { success: false, error: reloadResult.output };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);

      try {
        await fs.unlink(configFile);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
      }

      const reloadResult = await shellService.executeCommand("angie", ["-s", "reload"]);
      if (!reloadResult.success) {
        return { success: false, error: reloadResult.output };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async reload(): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.executeCommand("angie", ["-s", "reload"]);
    return result;
  }

  async addCustomDomain(projectRef: string, domain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const kong = this.KONG_INTERNAL;
      const acmeClient = this.ACME_CLIENT;
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);

      let config: string;

      if (this.ENABLE_SSL) {
        config = `server {
    listen 80;
    listen 443 ssl;
    server_name ${domain};

    acme ${acmeClient};
    ssl_certificate $acme_cert_${acmeClient};
    ssl_certificate_key $acme_cert_key_${acmeClient};

    # Edge Functions — direct to edge-runtime
    location /functions/v1/ {
        proxy_pass http://${this.EDGE_RUNTIME_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};
    }

    # Storage render endpoint (cache disabled)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Project-Ref ${projectRef};
    }
}
`;
      } else {
        config = `server {
    listen 80;
    server_name ${domain};

    # Edge Functions — direct to edge-runtime
    location /functions/v1/ {
        proxy_pass http://${this.EDGE_RUNTIME_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Project-Ref ${projectRef};
    }

    # Storage render endpoint (cache disabled)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Project-Ref ${projectRef};
    }
}
`;
      }

      await fs.writeFile(configFile, config, "utf-8");

      const testResult = await shellService.executeCommand("angie", ["-t"]);
      if (!testResult.success) {
        await fs.unlink(configFile).catch(() => { });
        return { success: false, error: testResult.output };
      }

      await shellService.executeCommand("angie", ["-s", "reload"]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeCustomDomain(projectRef: string, domain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);
      await fs.unlink(configFile).catch(() => { });
      await shellService.executeCommand("angie", ["-s", "reload"]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async updateNetworkRestrictions(projectRef: string, allowedIps: string[]): Promise<{ success: boolean; error?: string }> {
    try {
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);
      const existing = await fs.readFile(configFile, "utf-8").catch(() => "");
      // Build geo-restriction allow block from IP list
      const allowRules = allowedIps.length > 0
        ? allowedIps.map(ip => `        allow ${ip};`).join("\n") + "\n        deny all;"
        : "        allow all;";
      // Replace or inject the allow/deny block inside location block
      const updated = existing.replace(
        /(location\s+\/\s*\{[^}]*?)(allow[^;]+;[^}]*?deny[^;]+;|allow all;)/s,
        `$1${allowRules}`
      );
      await fs.writeFile(configFile, updated.includes("allow") ? updated : existing + `\n# Network restrictions\n${allowRules}\n`);
      await shellService.executeCommand("angie", ["-s", "reload"]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }
}

export const routerService = new RouterService();
