import { $ } from "bun";
import os from "node:os";

/**
 * 现代版 Angie (OpenResty 兼容加强版 / Nginx Fork) 负载均衡与网关生命周期管理
 */
export class LoadBalancerManager {
    /**
     * 安装并配置具备自动 ACME SSL 能力的前端代理网关
     */
    static async installAngie(studioDomain: string, apiDomain: string) {
        console.log("[LoadBalancerManager] 安装 Angie (原生 http_acme 自动 SSL)...");

        // 1. 处理已有的 Nginx (备份、停用、卸载)
        if ((await $`which nginx`.nothrow()).exitCode === 0 ||
            (await $`systemctl list-unit-files nginx.service`.nothrow()).exitCode === 0) {

            const backupDir = `/etc/nginx.bak.${Date.now()}`;
            if ((await $`test -d /etc/nginx`.nothrow()).exitCode === 0) {
                console.log(`[LoadBalancerManager] 备份原有 Nginx 配置到 ${backupDir} ...`);
                await $`cp -a /etc/nginx ${backupDir}`.nothrow();
            }

            // 仅在有 systemctl 时尝试停止
            if ((await $`systemctl --version`.nothrow().quiet()).exitCode === 0) {
                await $`systemctl stop nginx`.nothrow();
                await $`systemctl disable nginx`.nothrow();
            }

            if ((await $`which dnf`.nothrow()).exitCode === 0) {
                await $`dnf remove -y nginx nginx-core nginx-filesystem`.nothrow();
            } else if ((await $`which apt-get`.nothrow()).exitCode === 0) {
                await $`apt-get remove -y nginx nginx-common nginx-full`.nothrow();
            }
        }

        // 2. 调用已释放出来的底层原生 setup.sh (由于涉及到红帽 DNF 仓库源的配置，保留 bash 隔离)
        const setupScript = "/opt/supacloud/infra/angie/setup.sh";
        if ((await $`test -f ${setupScript}`.nothrow()).exitCode !== 0) {
            console.warn(`[LoadBalancerManager] 找不到底层脚本: ${setupScript}，跳过 Angie 安装。`);
            return;
        }

        const isRHEL = (await $`which dnf`.nothrow()).exitCode === 0;
        if (!isRHEL) {
            console.warn("[LoadBalancerManager] Angie 独立发行版目前仅支持 RHEL/DNF 系列 (CentOS/Rocky)。在 Debian/Ubuntu 上建议直接使用源码或等待后续更新。跳过部署。");
            return;
        }

        const res = await $`bash ${setupScript} --studio-domain ${studioDomain} --api-domain ${apiDomain}`.nothrow();
        if (res.exitCode !== 0) {
            console.warn("[LoadBalancerManager] Angie setup.sh 执行失败", res.stderr.toString());
            return;
        }

        // 3. 注入全局性能配置 (Gzip & 代理缓存)
        console.log("[LoadBalancerManager] 初始化 Angie 全局性能配置...");
        await $`mkdir -p /etc/angie/http.d`;

        const perfConf = `
# 全局 Gzip 压缩优化 (减少外网流量消耗)
gzip on;
gzip_comp_level 5;
gzip_min_length 256;
gzip_types application/javascript application/json application/xml text/css text/plain text/xml image/svg+xml;
gzip_vary on;

# 全局代理缓存池 (专用于 Storage 缩略图提速)
proxy_cache_path /var/cache/angie/storage_render levels=1:2 keys_zone=render_cache:10m max_size=1g inactive=7d use_temp_path=off;
`;
        // 改用 Bun.write 加速文件落盘
        await Bun.write("/etc/angie/http.d/00-global-perf.conf", perfConf.trim());
        await $`mkdir -p /var/cache/angie/storage_render`;
        await $`chown -R angie:angie /var/cache/angie`.nothrow();

        if ((await $`systemctl --version`.nothrow().quiet()).exitCode === 0) {
            await $`systemctl restart angie`.nothrow();
        }

        console.log("[LoadBalancerManager] Angie 配置成功, 代理网关已上线。");
    }
}
