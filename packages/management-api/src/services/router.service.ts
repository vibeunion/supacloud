import fs from "node:fs/promises";
import path from "node:path";
import { shellService } from "./shell.service";

export class RouterService {
  private readonly ANGIE_SITES_DIR = process.env.ANGIE_SITES_DIR || "/etc/angie/http.d";
  private readonly KONG_INTERNAL = process.env.KONG_INTERNAL || "127.0.0.1:8000";
  private readonly BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";

  getProjectApiUrl(projectRef: string): string {
    return `https://${projectRef}.api.${this.BASE_DOMAIN}`;
  }

  getProjectStudioUrl(projectRef: string): string {
    return `https://studio-${projectRef}.${this.BASE_DOMAIN}`;
  }

  getProjectDomain(projectRef: string): string {
    return `${projectRef}.${this.BASE_DOMAIN}`;
  }

  async addRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = `${projectRef}.api.${this.BASE_DOMAIN}`;
      const studioDomain = `studio-${projectRef}.${this.BASE_DOMAIN}`;
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);

      await fs.mkdir(this.ANGIE_SITES_DIR, { recursive: true });

      const kong = this.KONG_INTERNAL;

      const config = `# SupaCloud tenant: ${projectRef}
# Generated: ${new Date().toISOString()}

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

    location / {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;

      await fs.writeFile(configFile, config, "utf-8");
      console.log(`Route added for ${projectRef} (api: ${apiDomain})`);

      // 测试并重载 Angie
      const testResult = await shellService.executeCommand("angie", ["-t"]);
      if (!testResult.success) {
        console.error("Angie config test failed:", testResult.output);
        // 删除失败的配置
        await fs.unlink(configFile).catch(() => {});
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

      // Reload Angie
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
      const configFile = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);

      const config = `server {
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

      await fs.writeFile(configFile, config, "utf-8");

      const testResult = await shellService.executeCommand("angie", ["-t"]);
      if (!testResult.success) {
        await fs.unlink(configFile).catch(() => {});
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
      await fs.unlink(configFile).catch(() => {});
      await shellService.executeCommand("angie", ["-s", "reload"]);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

export const routerService = new RouterService();
