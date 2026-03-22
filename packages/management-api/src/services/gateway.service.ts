import { $ } from "bun";
import { logger } from "../utils/logger";
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

    // --- Kong Admin API helper methods ---
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
            // During POST, 409 Conflict is considered normal (skip if already exists)
            if (res.status !== 409) {
                const text = await res.text().catch(() => "");
                logger.warn(`Kong API ${method} ${path} returned ${res.status}: ${text}`);
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

            // Delete old JWT credentials
            const existing = await this.kongRequest(`/consumers/${projectRef}/jwt`);
            for (const cred of existing?.data ?? []) {
                await this.kongRequest(`/consumers/${projectRef}/jwt/${cred.id}`, "DELETE");
            }

            // Create new credentials
            await this.kongRequest(`/consumers/${projectRef}/jwt`, "POST", {
                key: "supabase",
                secret: jwtSecret,
                algorithm: "HS256",
            });
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to setup JWT for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- Rate Limiting ---

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
            const existing = pluginsRes?.data?.find((p: Record<string, unknown>) => p.name === "rate-limiting");

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
        } catch (error: unknown) {
            logger.error(`Failed to set rate limit for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
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
        } catch (error: unknown) {
            logger.error(`Failed to set CORS for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- JWT Auth Plugin ---

    async enableJwtAuth(projectRef: string): Promise<boolean> {
        try {
            const routeName = `route-${projectRef}`;
            const pluginsRes = await this.kongRequest(`/routes/${routeName}/plugins`);
            const hasJwt = pluginsRes?.data?.some((p: Record<string, unknown>) => p.name === "jwt");
            if (!hasJwt) {
                await this.kongRequest(`/routes/${routeName}/plugins`, "POST", {
                    name: "jwt",
                    config: { key_claim_name: "iss", claims_to_verify: ["exp"] },
                });
            }
            return true;
        } catch (error: unknown) {
            logger.error(`Failed to enable JWT auth for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    // --- Declarative Kong YAML Management ---

    private generateTenantYaml(projectRef: string, hostIp: string, pgrstPort: number, gotruePort: number, jwtSecret?: string): string {
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
        plugins:
          - name: cors
            config:
              origins:
                - "*"
              methods:
                - GET
                - POST
                - PUT
                - PATCH
                - DELETE
                - OPTIONS
              headers:
                - Accept
                - Authorization
                - Content-Type
                - X-Api-Version
              credentials: true
              max_age: 3600
          - name: rate-limiting
            config:
              second: 10
              minute: 100
              hour: 1000
              policy: local
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
        plugins:
          - name: cors
            config:
              origins:
                - "*"
              methods:
                - GET
                - POST
                - PUT
                - PATCH
                - DELETE
                - OPTIONS
              headers:
                - Accept
                - Authorization
                - Content-Type
                - X-Api-Version
              credentials: true
              max_age: 3600
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
        plugins:
          - name: cors
            config:
              origins:
                - "*"
              methods:
                - GET
                - POST
                - PUT
                - PATCH
                - DELETE
                - OPTIONS
              headers:
                - Accept
                - Authorization
                - Content-Type
                - X-Api-Version
                - X-Client-Info
              exposed_headers:
                - X-Relay-Error
              credentials: true
              max_age: 3600
  - name: svc-storage-${projectRef}
    url: http://${hostIp}:9090
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-storage-${projectRef}
        strip_path: true
        preserve_host: true
        paths:
          - /storage/v1
        headers:
          x-project-ref:
            - ${projectRef}
        plugins:
          - name: cors
            config:
              origins:
                - "*"
              methods:
                - GET
                - POST
                - PUT
                - PATCH
                - DELETE
                - OPTIONS
              headers:
                - Accept
                - Authorization
                - Content-Type
                - X-Api-Version
               credentials: true
              max_age: 3600
  - name: svc-realtime-${projectRef}
    url: http://${hostIp}:4000
    connect_timeout: 5000
    read_timeout: 86400000
    write_timeout: 86400000
    routes:
      - name: route-realtime-${projectRef}
        strip_path: true
        preserve_host: true
        paths:
          - /realtime/v1
        headers:
          x-project-ref:
            - ${projectRef}
        plugins:
          - name: cors
            config:
              origins:
                - "*"
              methods:
                - GET
                - POST
                - PUT
                - PATCH
                - DELETE
                - OPTIONS
              headers:
                - Accept
                - Authorization
                - Content-Type
                - X-Api-Version
              credentials: true
              max_age: 3600
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

        logger.warn("Could not detect container bridge IP, defaulting to 127.0.0.1");
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
                logger.warn(`WARNING: ${kongYml} not found, skipping Kong reload`);
                return;
            }
        }

        // Read base configuration
        const baseContent = await Bun.file(kongBase).text();

        // Read YAML snippets from all tenants
        let tenantSnippets = "";
        try {
            const files = await fs.readdir(tenantDir);
            for (const file of files.filter(f => f.endsWith(".yml"))) {
                const snippet = await Bun.file(path.join(tenantDir, file)).text();
                tenantSnippets += snippet;
            }
        } catch (err: unknown) {
      // Skip if tenantDir doesn't exist
      logger.warn("[GatewayService] Failed to filter Angie upstream entries", { error: err });
    }

        // Insert tenant configurations after `services:` section
        const merged = baseContent.replace(/(^services:\s*$)/m, `$1\n${tenantSnippets}`);
        await Bun.write(kongYml, merged);

        // Hot reload Kong gateway
        const kongContainer = (await $`docker ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim()
            || (await $`podman ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim();

        if (kongContainer) {
            const runtime = (await $`docker ps -q -f name=supabase-kong`.nothrow().quiet()).text().trim()
                ? "docker" : "podman";
            await $`${runtime} exec supabase-kong kong reload`.nothrow().quiet();
            logger.info("Kong Gateway reloaded.");
        } else {
            logger.warn("WARNING: supabase-kong container not running, config written but not reloaded");
        }
    }

    // --- Core reload logic ---

    async setupUpstream(projectRef: string, pgrstPort: number | string, gotruePort: number | string): Promise<{ success: boolean; error?: string }> {
        try {
            const hostIp = await this.detectHostIp();
            await fs.mkdir(this.TENANT_DIR, { recursive: true });

            const yaml = this.generateTenantYaml(projectRef, hostIp, Number(pgrstPort), Number(gotruePort));
            await Bun.write(path.join(this.TENANT_DIR, `${projectRef}.yml`), yaml);

            await this.rebuildKongConfig();
            logger.info(`Kong upstream registered for ${projectRef} (pgrst:${pgrstPort}, gotrue:${gotruePort})`);
            return { success: true };
        } catch (error: unknown) {
            logger.error(`Failed to setup upstream for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
        try {
            const tenantYml = path.join(this.TENANT_DIR, `${projectRef}.yml`);
            if (await Bun.file(tenantYml).exists()) {
                await fs.unlink(tenantYml);
            }
            await this.rebuildKongConfig();
            logger.info(`Kong service removed for ${projectRef}`);
            return { success: true };
        } catch (error: unknown) {
            logger.error(`Failed to remove service for ${projectRef}:`, (error instanceof Error ? error.message : String(error)));
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
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
        } catch (error: unknown) {
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
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
        } catch (error: unknown) {
            return { success: false, error: (error instanceof Error ? error.message : String(error)) };
        }
    }

    async applyConfig(projectRef: string, config: GatewayConfig): Promise<{ success: boolean; message: string }> {
        if (config.jwtSecret) await this.setupJwt(projectRef, config.jwtSecret);
        if (config.rateLimitTier) await this.setRateLimit(projectRef, config.rateLimitTier);
        if (config.corsOrigins) await this.setCors(projectRef, config.corsOrigins);
        if (config.jwtEnabled) await this.enableJwtAuth(projectRef);
        return { success: true, message: "Gateway configuration updated" };
    }
}

export const gatewayService = new GatewayService();
