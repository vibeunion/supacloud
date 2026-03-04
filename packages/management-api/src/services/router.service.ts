import fs from "node:fs/promises";
import path from "node:path";
import { shellService } from "./shell.service";

export interface ProjectDomains {
  apiDomain: string;
  studioDomain: string;
}

export class RouterService {
  private readonly ANGIE_SITES_DIR = process.env.ANGIE_SITES_DIR || "/etc/angie/http.d";
  private readonly KONG_INTERNAL = process.env.KONG_INTERNAL || "127.0.0.1:8000";
  private readonly STUDIO_INTERNAL = process.env.STUDIO_INTERNAL || "127.0.0.1:3000";
  private readonly MANAGEMENT_API_INTERNAL = process.env.MANAGEMENT_API_INTERNAL || "127.0.0.1:9090";
  private readonly BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";
  private readonly ENABLE_SSL = process.env.ENABLE_SSL === "true";
  private readonly ACME_CLIENT = process.env.ACME_CLIENT || "le";

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

    # Storage render endpoint (cache disabled - requires proxy_cache_path pre-configuration)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
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

    # Hijack /api/platform/* to Management API for multi-project support
    location /api/platform/ {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL}/platform/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://${this.STUDIO_INTERNAL};
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

    # Storage render endpoint (cache disabled - requires proxy_cache_path pre-configuration)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
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

    # Hijack /api/platform/* to Management API for multi-project support
    location /api/platform/ {
        proxy_pass http://${this.MANAGEMENT_API_INTERNAL}/platform/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://${this.STUDIO_INTERNAL};
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
      console.log(`Route added for ${projectRef} (api: ${apiDomain})`);

      const testResult = await shellService.executeCommand("angie", ["-t"]);
      if (!testResult.success) {
        console.error("Angie config test failed:", testResult.output);
        await fs.unlink(configFile).catch(() => { });
        return { success: false, error: testResult.output };
      }

      const reloadResult = await shellService.executeCommand("angie", ["-s", "reload"]);
      if (!reloadResult.success) {
        console.error("Angie reload failed:", reloadResult.output);
        return { success: false, error: reloadResult.output };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);

      try {
        await fs.unlink(configFile);
      } catch (e: any) {
        if (e.code !== "ENOENT") {
          throw e;
        }
      }

      const reloadResult = await shellService.executeCommand("angie", ["-s", "reload"]);
      if (!reloadResult.success) {
        return { success: false, error: reloadResult.output };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
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

    # Storage render endpoint (cache disabled)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
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

    # Storage render endpoint (cache disabled)
    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${projectRef};
    }

    location / {
        proxy_pass http://${kong};
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
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async removeCustomDomain(projectRef: string, domain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);
      await fs.unlink(configFile).catch(() => { });
      await shellService.executeCommand("angie", ["-s", "reload"]);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
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
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

export const routerService = new RouterService();
