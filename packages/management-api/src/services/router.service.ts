import { $ } from "bun";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config";

export class RouterService {
  private readonly ANGIE_SITES_DIR = process.env.ANGIE_SITES_DIR || "/etc/angie/http.d";
  private readonly KONG_INTERNAL = process.env.KONG_INTERNAL || "127.0.0.1:8000";
  private readonly BASE_DOMAIN = process.env.BASE_DOMAIN || config.baseDomain || "localhost";

  private detectSslMode(domain: string): "pigsty" | "angie-acme" {
    // 同步判断是否存在 pigsty 证书文件
    const certPath = `/etc/pigsty/cert/${domain}.pem`;
    try {
      require("fs").accessSync(certPath);
      return "pigsty";
    } catch {
      return "angie-acme";
    }
  }

  private generateSslBlock(domain: string): string {
    const mode = this.detectSslMode(domain);
    if (mode === "pigsty") {
      return `    # Pigsty static certificate\n    ssl_certificate     /etc/pigsty/cert/${domain}.pem;\n    ssl_certificate_key /etc/pigsty/cert/${domain}.key;`;
    }
    return `    # Angie native ACME\n    acme                le;\n    ssl_certificate     $acme_cert_le;\n    ssl_certificate_key $acme_cert_key_le;`;
  }

  private generateRouteConfig(projectRef: string): string {
    const apiDomain = `${projectRef}.api.${this.BASE_DOMAIN}`;
    const studioDomain = `studio-${projectRef}.${this.BASE_DOMAIN}`;
    const apiSsl = this.generateSslBlock(apiDomain);
    const studioSsl = this.generateSslBlock(studioDomain);
    const kong = this.KONG_INTERNAL;

    return `# SupaCloud tenant: ${projectRef}
# Generated: ${new Date().toISOString()}

# --- API Endpoint ---
server {
    listen 80;
    listen 443 ssl;
    server_name ${apiDomain};

${apiSsl}

    add_header x-project-ref ${projectRef} always;

    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header x-project-ref ${projectRef};

        proxy_cache render_cache;
        proxy_cache_valid 200 7d;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        add_header X-Cache-Status $upstream_cache_status always;
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

${studioSsl}

    add_header x-project-ref ${projectRef} always;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
  }

  private generateCustomDomainConfig(projectRef: string, domain: string): string {
    const ssl = this.generateSslBlock(domain);
    const kong = this.KONG_INTERNAL;

    return `server {
    listen 80;
    listen 443 ssl;
    server_name ${domain};

${ssl}

    location ^~ /storage/v1/render/ {
        proxy_pass http://${kong};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header x-project-ref ${projectRef};

        proxy_cache render_cache;
        proxy_cache_valid 200 7d;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        add_header X-Cache-Status $upstream_cache_status always;
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

  private async reloadAngie(): Promise<{ success: boolean; error?: string }> {
    const testResult = await $`angie -t`.nothrow().quiet();
    if (testResult.exitCode !== 0) {
      const err = testResult.stderr.toString();
      console.error("Angie config test failed:", err);
      return { success: false, error: `Angie config test failed: ${err}` };
    }
    await $`angie -s reload`.nothrow().quiet();
    console.log("Angie reloaded successfully.");
    return { success: true };
  }

  // 添加项目路由配置
  async addRoute(projectRef: string, domain?: string): Promise<{ success: boolean; error?: string }> {
    await fs.mkdir(this.ANGIE_SITES_DIR, { recursive: true });
    const configPath = path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`);
    await Bun.write(configPath, this.generateRouteConfig(projectRef));
    console.log(`Route added for ${projectRef} (api: ${projectRef}.api.${this.BASE_DOMAIN})`);
    return this.reloadAngie();
  }

  // 移除项目路由配置
  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const files = [
      path.join(this.ANGIE_SITES_DIR, `${projectRef}.conf`),
      path.join(this.ANGIE_SITES_DIR, `${projectRef}_restrictions.inc`),
    ];
    // Also remove wildcard custom domain configs
    try {
      const all = await fs.readdir(this.ANGIE_SITES_DIR);
      for (const f of all.filter(f => f.startsWith(`${projectRef}_custom_`))) {
        files.push(path.join(this.ANGIE_SITES_DIR, f));
      }
    } catch { /* ignore */ }

    await Promise.all(files.map(f => fs.unlink(f).catch(() => { })));
    console.log(`Routes removed for ${projectRef}`);
    return this.reloadAngie();
  }

  // 重载 Angie 配置
  async reload(): Promise<{ success: boolean; error?: string }> {
    return this.reloadAngie();
  }

  // 添加自定义域名
  async addCustomDomain(projectRef: string, domain: string): Promise<{ success: boolean; error?: string }> {
    await fs.mkdir(this.ANGIE_SITES_DIR, { recursive: true });
    const configPath = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);
    await Bun.write(configPath, this.generateCustomDomainConfig(projectRef, domain));
    console.log(`Custom domain ${domain} added for ${projectRef}`);
    return this.reloadAngie();
  }

  // 移除自定义域名
  async removeCustomDomain(projectRef: string, domain: string): Promise<{ success: boolean; error?: string }> {
    const configPath = path.join(this.ANGIE_SITES_DIR, `${projectRef}_custom_${domain}.conf`);
    await fs.unlink(configPath).catch(() => { });
    return this.reloadAngie();
  }

  // 更新 IP 限制
  async updateNetworkRestrictions(projectRef: string, allowedIps: string[]): Promise<{ success: boolean; error?: string }> {
    const restrictionPath = path.join(this.ANGIE_SITES_DIR, `${projectRef}_restrictions.inc`);
    const lines = [`# IP Restrictions for ${projectRef}`];
    if (allowedIps.length > 0) {
      lines.push(...allowedIps.map(ip => `allow ${ip};`));
      lines.push("deny all;");
    } else {
      lines.push("allow all;");
    }
    await Bun.write(restrictionPath, lines.join("\n") + "\n");
    return this.reloadAngie();
  }

  // 获取项目域名
  getProjectDomain(projectRef: string): string {
    return `${projectRef}.${this.BASE_DOMAIN}`;
  }

  // 获取项目 API URL
  getProjectApiUrl(projectRef: string): string {
    return `https://${projectRef}.api.${this.BASE_DOMAIN}`;
  }

  // 获取项目 Studio URL
  getProjectStudioUrl(projectRef: string): string {
    return `https://studio-${projectRef}.${this.BASE_DOMAIN}`;
  }
}

export const routerService = new RouterService();
