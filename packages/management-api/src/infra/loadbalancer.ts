import { $ } from "bun";
import os from "node:os";

/**
 * Modern Angie (OpenResty-compatible enhanced version / Nginx Fork) Load Balancer and Gateway Lifecycle Management
 */
export class LoadBalancerManager {
    /**
     * Install and configure frontend proxy gateway with automatic ACME SSL capability
     */
    static async installAngie(studioDomain: string, apiDomain: string, enableSsl = true, acmeClient = "le") {
        console.log(`[LoadBalancerManager] Installing Angie (SSL=${enableSsl}, Client=${acmeClient})...`);

        // 1. Handle existing Nginx (backup, stop, uninstall)
        if ((await $`which nginx`.nothrow()).exitCode === 0 ||
            (await $`systemctl list-unit-files nginx.service`.nothrow()).exitCode === 0) {

            const backupDir = `/etc/nginx.bak.${Date.now()}`;
            if ((await $`test -d /etc/nginx`.nothrow()).exitCode === 0) {
                console.log(`[LoadBalancerManager] Backing up existing Nginx config to ${backupDir} ...`);
                await $`cp -a /etc/nginx ${backupDir}`.nothrow();
            }

            // Only attempt to stop if systemctl is available
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

        // 2. Call underlying native setup.sh (bash isolation required for RedHat DNF repo configuration)
        const setupScript = "/opt/supacloud/infra/angie/setup.sh";
        if ((await $`test -f ${setupScript}`.nothrow()).exitCode !== 0) {
            console.warn(`[LoadBalancerManager] Setup script not found: ${setupScript}, skipping Angie installation.`);
            return;
        }

        const res = await $`bash ${setupScript} --studio-domain ${studioDomain} --api-domain ${apiDomain} --acme-client ${acmeClient}`.nothrow();
        if (res.exitCode !== 0) {
            console.warn("[LoadBalancerManager] Angie setup.sh execution failed", res.stderr.toString());
            return;
        }

        // 3. Inject global performance configuration (Gzip & Proxy Cache)
        console.log("[LoadBalancerManager] Initializing Angie global performance configuration...");
        await $`mkdir -p /etc/angie/http.d`;

        const perfConf = `
# Global Gzip compression optimization (reduce external network traffic)
gzip on;
gzip_comp_level 5;
gzip_min_length 256;
gzip_types application/javascript application/json application/xml text/css text/plain text/xml image/svg+xml;
gzip_vary on;

# Global proxy cache pool (dedicated for Storage thumbnail acceleration)
proxy_cache_path /var/cache/angie/storage_render levels=1:2 keys_zone=render_cache:10m max_size=1g inactive=7d use_temp_path=off;
`;
        // Use Bun.write for faster file writing
        await Bun.write("/etc/angie/http.d/00-global-perf.conf", perfConf.trim());
        await $`mkdir -p /var/cache/angie/storage_render`;
        await $`chown -R angie:angie /var/cache/angie`.nothrow();

        if ((await $`systemctl --version`.nothrow().quiet()).exitCode === 0) {
            await $`systemctl restart angie`.nothrow();
        }

        console.log("[LoadBalancerManager] Angie configured successfully, proxy gateway is online.");
    }
}
