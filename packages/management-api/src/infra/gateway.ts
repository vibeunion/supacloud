import { $ } from "bun";

export interface GatewayPorts {
    pgrst: number;
    gotrue: number;
    functions?: number;
    storage?: number;
    realtime?: number;
}

/**
 * 现代化的 Kong 网关管理层 (TypeScript / Bun 基础设施即代码)
 * 完全取代原本复杂的 gateway_manager.sh。提供类型安全的并发 API 请求与错误捕捉。
 */
export class GatewayManager {
    private static readonly ADMIN_URL = process.env.KONG_ADMIN_URL || "http://localhost:8001";
    private static readonly TENANT_DIR = "/etc/supabase/kong_tenants";
    private static readonly KONG_YML = process.env.KONG_YML || "/root/pigsty/app/supabase/volumes/api/kong.yml";

    /**
     * 确保 Kong Consumer 存在
     */
    private static async ensureConsumer(ref: string): Promise<void> {
        const form = new URLSearchParams({ username: ref, custom_id: ref });
        await fetch(`${this.ADMIN_URL}/consumers`, {
            method: "POST",
            body: form,
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
    }

    /**
     * 为租户配置并绑定全局 JWT Secret 凭据
     */
    static async setupJwt(ref: string, jwtSecret: string): Promise<void> {
        await this.ensureConsumer(ref);
        try {
            const res = await fetch(`${this.ADMIN_URL}/consumers/${ref}/jwt`);
            if (res.ok) {
                const data = await res.json();
                if (data?.data && data.data.length > 0) {
                    await Promise.all(
                        data.data.map((jwt: any) =>
                            fetch(`${this.ADMIN_URL}/consumers/${ref}/jwt/${jwt.id}`, { method: "DELETE" })
                        )
                    );
                }
            }
            const form = new URLSearchParams({
                key: "supabase",
                secret: jwtSecret,
                algorithm: "HS256"
            });
            await fetch(`${this.ADMIN_URL}/consumers/${ref}/jwt`, {
                method: "POST",
                body: form,
                headers: { "Content-Type": "application/x-www-form-urlencoded" }
            });
            console.log(`[Gateway] JWT credentials configured for tenant ${ref}`);
        } catch (e: any) {
            console.error(`[Gateway] Failed to setup JWT for ${ref}: ${e.message}`);
        }
    }

    /**
     * 动态设置租户 API 限流规则
     */
    static async setRateLimit(ref: string, tier: "free" | "pro" | "enterprise" = "free"): Promise<void> {
        let limits = { second: 10, minute: 100, hour: 1000 };
        if (tier === "pro") limits = { second: 100, minute: 2000, hour: 50000 };
        if (tier === "enterprise") limits = { second: 1000, minute: 50000, hour: 1000000 };

        const routeName = `route-${ref}`;
        try {
            const res = await fetch(`${this.ADMIN_URL}/routes/${routeName}/plugins`);
            let pluginId = null;
            if (res.ok) {
                const data = await res.json();
                const existing = data.data.find((p: any) => p.name === "rate-limiting");
                if (existing) pluginId = existing.id;
            }

            const form = new URLSearchParams({
                name: "rate-limiting",
                "config.second": limits.second.toString(),
                "config.minute": limits.minute.toString(),
                "config.hour": limits.hour.toString(),
                "config.policy": "local"
            });

            if (pluginId) {
                await fetch(`${this.ADMIN_URL}/plugins/${pluginId}`, {
                    method: "PATCH",
                    body: form,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" }
                });
            } else {
                await fetch(`${this.ADMIN_URL}/routes/${routeName}/plugins`, {
                    method: "POST",
                    body: form,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" }
                });
            }
        } catch (e) {
            console.error(`[Gateway] Failed to set rate limits for ${ref}`);
        }
    }

    /**
     * 生成声明式路由配置文件并重启 Kong (支持多节点负载均衡)
     */
    static async setupUpstream(ref: string, ports: GatewayPorts): Promise<void> {
        await $`mkdir -p ${this.TENANT_DIR}`.quiet();

        const { NodeManager } = await import("./node");
        const nodes = await NodeManager.listNodes();
        const appNodes = nodes.filter(n => n.role === "app" && n.status === "online");

        if (appNodes.length === 0) {
            let hostIp = "127.0.0.1";
            try {
                const hostIpText = await $`ip addr show podman1 | grep "inet " | awk '{print $2}' | cut -d/ -f1 || ip addr show docker0 | grep "inet " | awk '{print $2}' | cut -d/ -f1`.nothrow().quiet().text();
                if (hostIpText.trim()) hostIp = hostIpText.trim();
            } catch (e) { }
            appNodes.push({ ip: hostIp, hostname: "localhost", role: "app", status: "online", createdAt: 0 });
        }

        const upstreamNamePgrst = `upstream-pgrst-${ref}`;
        const upstreamNameGotrue = `upstream-gotrue-${ref}`;

        const targetsYaml = `
upstreams:
  - name: ${upstreamNamePgrst}
    targets:
${appNodes.map(n => `      - target: ${n.ip}:${ports.pgrst}`).join("\n")}
  - name: ${upstreamNameGotrue}
    targets:
${appNodes.map(n => `      - target: ${n.ip}:${ports.gotrue}`).join("\n")}
`;

        const serviceYaml = `
services:
  - name: svc-pgrst-${ref}
    host: ${upstreamNamePgrst}
    protocol: http
    port: 80
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-pgrst-${ref}
        strip_path: false
        preserve_host: true
        paths:
          - /rest/v1
          - /graphql/v1
        headers:
          x-project-ref:
            - ${ref}
            
  - name: svc-gotrue-${ref}
    host: ${upstreamNameGotrue}
    protocol: http
    port: 80
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-gotrue-${ref}
        strip_path: false
        preserve_host: true
        paths:
          - /auth/v1
        headers:
          x-project-ref:
            - ${ref}
`;

        const tenantYml = `${this.TENANT_DIR}/${ref}.yml`;
        await Bun.write(tenantYml, targetsYaml + serviceYaml);
        console.log(`[Gateway] Multi-node upstream config generated for ${ref} (${appNodes.length} nodes)`);

        await this.rebuildKongConfig();
    }

    /**
     * 将所有的租户拆分 YML 融合进 Kong 主配置，并执行热重载
     */
    private static async rebuildKongConfig(): Promise<void> {
        const baseYaml = `${this.KONG_YML}.base`;

        try {
            const baseExists = await Bun.file(baseYaml).exists();
            if (!baseExists && await Bun.file(this.KONG_YML).exists()) {
                await $`cp ${this.KONG_YML} ${baseYaml}`;
            }
        } catch (e) {
            console.warn("[Gateway] Base config sync failed:", e);
        }

        try {
            await $`awk -v tenant_dir=${this.TENANT_DIR} '
        /^services:/ {
            print $0
            system("if ls " tenant_dir "/*.yml >/dev/null 2>&1; then cat " tenant_dir "/*.yml; fi")
            next
        }
        { print $0 }
        ' ${baseYaml} > ${this.KONG_YML}`.nothrow();
        } catch (e) {
            console.error("[Gateway] Failed to dynamically construct Kong Declarative JSON", e);
            return;
        }

        try {
            const isDockerKong = (await $`docker ps -q -f "name=supabase-kong"`.nothrow().quiet().text()).trim();
            const isPodmanKong = (await $`podman ps -q -f "name=supabase-kong"`.nothrow().quiet().text()).trim();

            if (isDockerKong) {
                await $`docker exec supabase-kong kong reload`.nothrow();
                console.log("[Gateway] Kong Reloaded (Docker)");
            } else if (isPodmanKong) {
                await $`podman exec supabase-kong kong reload`.nothrow();
                console.log("[Gateway] Kong Reloaded (Podman)");
            } else {
                console.warn("[Gateway] Kong gateway container not running, skipped reload.");
            }
        } catch (e) {
            console.error(`[Gateway] Error during Kong hot reload:`, e);
        }
    }
}
