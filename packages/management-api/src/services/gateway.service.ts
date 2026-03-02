import { $ } from "bun";
import path from "node:path";
import fs from "node:fs/promises";

export interface GatewayConfig {
    rateLimitTier?: "free" | "pro" | "enterprise";
    corsOrigins?: string;
    jwtEnabled?: boolean;
    jwtSecret?: string;
}

interface RateLimitConfig {
    second: number;
    minute: number;
    hour: number;
}

export class GatewayService {
    private readonly KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || "http://localhost:8001";
    private readonly KONG_YML = process.env.KONG_YML || "/root/pigsty/app/supabase/volumes/api/kong.yml";
    private readonly TENANT_DIR = "/etc/supabase/kong_tenants";

    // --- Kong Admin API 辅助方法 ---
    private async kongRequest(path: string, method: string = "GET", body?: Record<string, unknown>): Promise<any> {
        const init: RequestInit = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body) {
            init.body = JSON.stringify(body);
        }
        const res = await fetch(`${this.KONG_ADMIN_URL}${path}`, init);
        if (!res.ok && method !== "POST") {
            // POST 时，409 Conflict 视为正常（已存在则跳过）
            if (res.status !== 409) {
                const text = await res.text().catch(() => "");
                console.warn(`Kong API ${method} ${path} returned ${res.status}: ${text}`);
            }
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    // --- Consumer & JWT ---

    async ensureConsumer(projectRef: string): Promise<void> {
        await this.kongRequest("/consumers", "POST", {
            username: projectRef,
            custom_id: projectRef,
        });
    }

    async setupJwt(projectRef: string, jwtSecret: string): Promise<boolean> {
        try {
            await this.ensureConsumer(projectRef);

            // 删除旧的 JWT 凭据
            const existing = await this.kongRequest(`/consumers/${projectRef}/jwt`);
            for (const cred of existing?.data ?? []) {
                await this.kongRequest(`/consumers/${projectRef}/jwt/${cred.id}`, "DELETE");
            }

            // 创建新凭据
            await this.kongRequest(`/consumers/${projectRef}/jwt`, "POST", {
                key: "supabase",
                secret: jwtSecret,
                algorithm: "HS256",
            });
            return true;
        } catch (error: any) {
            console.error(`Failed to setup JWT for ${projectRef}:`, error.message);
            return false;
        }
    }

    // --- 限流 ---

    private getRateLimitConfig(tier: string): RateLimitConfig {
        switch (tier) {
            case "pro": return { second: 100, minute: 2000, hour: 50000 };
            case "enterprise": return { second: 1000, minute: 50000, hour: 1000000 };
            default: return { second: 10, minute: 100, hour: 1000 };
        }
    }

    async setRateLimit(projectRef: string, tier: string = "free"): Promise<boolean> {
        try {
            const { second, minute, hour } = this.getRateLimitConfig(tier);
            const routeName = `route-${projectRef}`;
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const existing = pluginsRes?.data?.find((p: any) => p.name === "rate-limiting");

            const payload = {
                name: "rate-limiting",
                config: { second, minute, hour, policy: "local" },
            };

            if (existing) {
                await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }
            return true;
        } catch (error: any) {
            console.error(`Failed to set rate limit for ${projectRef}:`, error.message);
            return false;
        }
    }

    // --- CORS ---

    async setCors(projectRef: string, origins: string = "*"): Promise<boolean> {
        try {
            const routeName = `route-${projectRef}`;
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins?name=cors`);
            const existing = pluginsRes?.data?.[0];

            const payload = {
                name: "cors",
                config: {
                    origins: [origins],
                    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                    headers: ["Accept", "Authorization", "Content-Type", "X-Api-Version"],
                    exposed_headers: ["Content-Length", "X-JSON"],
                    credentials: true,
                    max_age: 3600,
                },
            };

            if (existing) {
                await this.kongRequest(`/plugins/${existing.id}`, "PATCH", payload);
            } else {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", payload);
            }
            return true;
        } catch (error: any) {
            console.error(`Failed to set CORS for ${projectRef}:`, error.message);
            return false;
        }
    }

    // --- JWT Auth 插件 ---

    async enableJwtAuth(projectRef: string): Promise<boolean> {
        try {
            const routeName = `route-${projectRef}`;
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const hasJwt = pluginsRes?.data?.some((p: any) => p.name === "jwt");
            if (!hasJwt) {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", {
                    name: "jwt",
                    config: { key_claim_name: "iss", claims_to_verify: ["exp"] },
                });
            }
            return true;
        } catch (error: any) {
            console.error(`Failed to enable JWT auth for ${projectRef}:`, error.message);
            return false;
        }
    }

    // --- 声明式 Kong YAML 管理 ---

    private generateTenantYaml(projectRef: string, hostIp: string, pgrstPort: number, gotruePort: number): string {
        const functionsPort = 9000;
        return `  - name: svc-pgrst-${projectRef}
    url: http://${hostIp}:${pgrstPort}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-pgrst-${projectRef}
        strip_path: true
        preserve_host: true
        paths:
          - /rest/v1
          - /graphql/v1
        headers:
          x-project-ref:
            - ${projectRef}
  - name: svc-gotrue-${projectRef}
    url: http://${hostIp}:${gotruePort}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-gotrue-${projectRef}
        strip_path: true
        preserve_host: true
        paths:
          - /auth/v1
        headers:
          x-project-ref:
            - ${projectRef}
  - name: svc-functions-${projectRef}
    url: http://${hostIp}:${functionsPort}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-functions-${projectRef}
        strip_path: true
        preserve_host: true
        paths:
          - /functions/v1
        headers:
          x-project-ref:
            - ${projectRef}
`;
    }

    private async detectHostIp(): Promise<string> {
        if (process.env.DOCKER_HOST_IP) return process.env.DOCKER_HOST_IP;

        for (const iface of ["podman1", "docker0"]) {
            const result = await $`ip addr show ${iface}`.nothrow().quiet();
            if (result.exitCode === 0) {
                const match = result.text().match(/inet (\d+\.\d+\.\d+\.\d+)/);
                if (match) return match[1];
            }
        }

        console.warn("Could not detect container bridge IP, defaulting to 127.0.0.1");
        return "127.0.0.1";
    }

    private async rebuildKongConfig(): Promise<void> {
        const kongYml = this.KONG_YML;
        const kongBase = `${kongYml}.base`;
        const tenantDir = this.TENANT_DIR;

        if (!(await Bun.file(kongBase).exists())) {
            if (await Bun.file(kongYml).exists()) {
                const baseContent = await Bun.file(kongYml).text();
                await Bun.write(kongBase, baseContent);
            } else {
                console.warn(`WARNING: ${kongYml} not found, skipping Kong reload`);
                return;
            }
        }

        // 读取 base 配置
        const baseContent = await Bun.file(kongBase).text();

        // 读取所有租户的 YAML 片段
        let tenantSnippets = "";
        try {
            const files = await fs.readdir(tenantDir);
            for (const file of files.filter(f => f.endsWith(".yml"))) {
                const snippet = await Bun.file(path.join(tenantDir, file)).text();
                tenantSnippets += snippet;
            }
        } catch {
            // tenantDir 不存在时跳过
        }

        // 将租户配置插入 `services:` 之后
        const merged = baseContent.replace(/(^services:\s*$)/m, `$1\n${tenantSnippets}`);
        await Bun.write(kongYml, merged);

        // 热重载 Kong
        const kongContainer = (await $`docker ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim()
            || (await $`podman ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim();

        if (kongContainer) {
            const runtime = (await $`docker ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim()
                ? "docker" : "podman";
            await $`${runtime} exec supabase-kong kong reload`.nothrow().quiet();
            console.log("Kong Gateway reloaded.");
        } else {
            console.warn("WARNING: supabase-kong container not running, config written but not reloaded");
        }
    }

    // --- 核心公开方法 ---

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string): Promise<{ success: boolean; error?: string }> {
        try {
            const hostIp = await this.detectHostIp();
            await fs.mkdir(this.TENANT_DIR, { recursive: true });

            const yaml = this.generateTenantYaml(projectRef, hostIp, Number(pgrstPort), Number(gotruePort));
            await Bun.write(path.join(this.TENANT_DIR, `${projectRef}.yml`), yaml);

            await this.rebuildKongConfig();
            console.log(`Kong upstream registered for ${projectRef} (pgrst:${pgrstPort}, gotrue:${gotruePort})`);
            return { success: true };
        } catch (error: any) {
            console.error(`Failed to setup upstream for ${projectRef}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
        try {
            const tenantYml = path.join(this.TENANT_DIR, `${projectRef}.yml`);
            if (await Bun.file(tenantYml).exists()) {
                await fs.unlink(tenantYml);
            }
            await this.rebuildKongConfig();
            console.log(`Kong service removed for ${projectRef}`);
            return { success: true };
        } catch (error: any) {
            console.error(`Failed to remove service for ${projectRef}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    async addUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }> {
        try {
            const upstreamName = `upstream-${projectRef}-ro`;
            await this.kongRequest(`/upstreams`, "POST", { name: upstreamName });
            await this.kongRequest(`/upstreams/${upstreamName}/targets`, "POST", {
                target: `${replicaIp}:5432`,
                weight: 100,
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    async removeUpstreamTarget(projectRef: string, replicaIp: string): Promise<{ success: boolean; error?: string }> {
        try {
            const upstreamName = `upstream-${projectRef}-ro`;
            await this.kongRequest(`/upstreams/${upstreamName}/targets`, "POST", {
                target: `${replicaIp}:5432`,
                weight: 0,
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    async applyConfig(projectRef: string, config: GatewayConfig): Promise<{ success: boolean; message: string }> {
        if (config.jwtSecret) await this.setupJwt(projectRef, config.jwtSecret);
        if (config.rateLimitTier) await this.setRateLimit(projectRef, config.rateLimitTier);
        if (config.corsOrigins) await this.setCors(projectRef, config.corsOrigins);
        if (config.jwtEnabled) await this.enableJwtAuth(projectRef);
        return { success: true, message: "网关配置已更新" };
    }
}

export const gatewayService = new GatewayService();
