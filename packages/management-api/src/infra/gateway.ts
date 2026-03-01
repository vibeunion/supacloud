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
            // 1. 获取现有 JWT ID
            const res = await fetch(`${this.ADMIN_URL}/consumers/${ref}/jwt`);
            if (res.ok) {
                const data = await res.json();
                // 尝试删除
                if (data?.data && data.data.length > 0) {
                    await Promise.all(
                        data.data.map((jwt: any) =>
                            fetch(`${this.ADMIN_URL}/consumers/${ref}/jwt/${jwt.id}`, { method: "DELETE" })
                        )
                    );
                }
            }

            // 2. 新增新的凭据
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
                // PATCH
                await fetch(`${this.ADMIN_URL}/plugins/${pluginId}`, {
                    method: "PATCH",
                    body: form,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" }
                });
            } else {
                // POST
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
     * 生成声明式路由配置文件并重启 Kong (按需休眠的 Wakeup Proxy)
     */
    static async setupUpstream(ref: string, ports: GatewayPorts): Promise<void> {
        // 确保租户目录存在
        await $`mkdir -p ${this.TENANT_DIR}`.quiet();
        const proxyPort = process.env.MANAGEMENT_API_PORT || "8080";

        // 探明容器宿主机桥接 IP (以确保 Kong 容器可以访问 API 控制面)
        let hostIp = "127.0.0.1";
        try {
            const hostIpText = await $`ip addr show podman1 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 || ip addr show docker0 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1`.text();
            if (hostIpText.trim()) {
                hostIp = hostIpText.trim();
            }
        } catch (e) { }

        const yamlContent = `
  - name: svc-pgrst-${ref}
    url: http://${hostIp}:${proxyPort}/_proxy/pgrst/${ref}/${ports.pgrst}
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
    url: http://${hostIp}:${proxyPort}/_proxy/gotrue/${ref}/${ports.gotrue}
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
        // 可选的 Functions 配置
        let extraYaml = "";
        if (ports.functions) {
            extraYaml += `
  - name: svc-functions-${ref}
    url: http://${hostIp}:${ports.functions}
    connect_timeout: 5000
    read_timeout: 60000
    write_timeout: 60000
    routes:
      - name: route-functions-${ref}
        strip_path: true
        preserve_host: true
        paths:
          - /functions/v1
        headers:
          x-project-ref:
            - ${ref}
`;
        }

        const tenantYml = `${this.TENANT_DIR}/${ref}.yml`;
        await Bun.write(tenantYml, yamlContent + extraYaml);
        console.log(`[Gateway] Declarative config generated for ${ref}`);

        // 重建汇总 YAML
        await this.rebuildKongConfig();
    }

    /**
     * 将所有的租户拆分 YML 融合进 Kong 主配置，并执行热重载
     */
    private static async rebuildKongConfig(): Promise<void> {
        const baseYaml = `${this.KONG_YML}.base`;

        // 如果 base 不存在，先备份初始状态
        try {
            const baseExists = await Bun.file(baseYaml).exists();
            if (!baseExists && await Bun.file(this.KONG_YML).exists()) {
                await $`cp ${this.KONG_YML} ${baseYaml}`;
            }
        } catch (e) {
            console.warn("[Gateway] Base config sync failed:", e);
        }

        // 进行安全的文件拼接
        try {
            // 利用 awk 进行高效组合，相当于完整的 Bash 拼接迁移
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

        // Kong Hot Reload
        try {
            const isDockerKong = (await $`docker ps -q -f "name=supabase-kong" 2>/dev/null`.nothrow().text()).trim();
            const isPodmanKong = (await $`podman ps -q -f "name=supabase-kong" 2>/dev/null`.nothrow().text()).trim();

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
