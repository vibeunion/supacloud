import { $ } from "bun";
import { resolve } from "node:path";

interface TenantCredentials {
    db_password?: string;
    jwt_secret?: string;
    api_url?: string;
}

export class TenantManager {
    private static readonly TENANT_CONFIG_DIR = process.env.TENANT_CONFIG_DIR || "/etc/supabase/tenants";
    private static readonly POSTGREST_BIN = process.env.POSTGREST_BIN || "/usr/local/bin/postgrest";
    private static readonly GOTRUE_BIN = process.env.GOTRUE_BIN || "/usr/local/bin/gotrue";
    private static readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
    private static readonly PG_PORT = process.env.PG_PORT || process.env.POSTGRES_PORT || "6432";
    private static readonly SUPACLOUD_META_DB = process.env.SUPACLOUD_META_DB || "supacloud_meta";

    /**
     * 确定性端口分配器（基于 Cksum / Hash)
     */
    static async getTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number> {
        const basePort = type === "pgrst" ? 3100 : 4100;

        // 用 Bun 原生哈希代替 bash cksum (此处使用简易字符串哈希)
        let hash = 0;
        for (let i = 0; i < ref.length; i++) {
            hash = ((hash << 5) - hash) + ref.charCodeAt(i);
            hash |= 0;
        }
        let port = basePort + (Math.abs(hash) % 10000);

        // 端口碰撞检测
        let tryCount = 0;
        while (tryCount < 100) {
            let conflict = false;
            if (await Bun.file(this.TENANT_CONFIG_DIR).exists()) {
                try {
                    const files = await $`ls ${this.TENANT_CONFIG_DIR}/*.env`.nothrow().text();
                    for (const file of files.split('\n').filter(Boolean)) {
                        if (file.includes(`/${ref}.env`) || file.includes(`/${ref}_gotrue.env`)) continue;

                        const content = await Bun.file(file).text();
                        if (type === "pgrst" && content.includes(`PGRST_SERVER_PORT=${port}`)) conflict = true;
                        if (type === "gotrue" && content.includes(`GOTRUE_API_PORT=${port}`)) conflict = true;
                    }
                } catch (e) { }
            }
            if (!conflict) return port;
            port++;
            tryCount++;
        }
        throw new Error(`Cannot find available port for ${ref} (${type})`);
    }

    /**
     * 从 supacloud_meta 查询租户凭据
     */
    static async getTenantCredentials(ref: string): Promise<TenantCredentials> {
        const password = process.env.PG_ADMIN_PASSWORD || process.env.POSTGRES_PASSWORD || "DBUser.DBA";
        // 使用 $ 捕获多行结果
        try {
            const query = `SELECT db_password, jwt_secret, api_url FROM projects WHERE ref='${ref}'`;
            const result = await $`PGPASSWORD="${password}" psql -h ${this.PG_HOST} -p ${this.PG_PORT} -U dbuser_dba -d ${this.SUPACLOUD_META_DB} -t -A -F ',' -c "${query}"`.text();

            // Clean up Pigsty /timing artifacts if present
            const lines = result.split('\n').filter(l => l.trim() && !l.startsWith('Time:'));
            if (lines.length > 0) {
                const [db_password, jwt_secret, api_url] = lines[0].split(',');
                return { db_password, jwt_secret, api_url };
            }
        } catch (e) {
            console.error(`[Tenant] Error fetching credentials for ${ref}:`, e);
        }
        throw new Error(`Credentials not found for ${ref}`);
    }

    /**
     * 下载或提取 PostgREST 二进制
     */
    static async ensurePostgrest(): Promise<void> {
        if ((await $`command -v postgrest`.nothrow()).exitCode === 0) return;
        if (await Bun.file(this.POSTGREST_BIN).exists()) return;

        console.log("[Tenant] PostgREST binary not found, extracting/downloading...");
        try {
            const cid = (await $`docker ps -q -f "name=supabase-rest"`.text()).trim();
            if (cid) {
                await $`docker cp ${cid}:/usr/local/bin/postgrest ${this.POSTGREST_BIN}`;
                if (await Bun.file(this.POSTGREST_BIN).exists()) return;
            }
        } catch (e) { }

        const arch = process.arch === "x64" ? "linux-static-x64" : "linux-static-aarch64";
        const version = "v12.2.3";
        const url = `https://github.com/PostgREST/postgrest/releases/download/${version}/postgrest-${version}-${arch}.tar.xz`;

        await $`curl -fsSL "https://gh-proxy.net/${url}" -o /tmp/pgrst.tar.xz || curl -fsSL "${url}" -o /tmp/pgrst.tar.xz`;
        await $`tar -xf /tmp/pgrst.tar.xz -C /tmp`;
        await $`mv /tmp/postgrest ${this.POSTGREST_BIN}`;
        await $`chmod +x ${this.POSTGREST_BIN}`;
    }

    /**
     * 下载或提取 GoTrue 二进制
     */
    static async ensureGotrue(): Promise<void> {
        if ((await $`which gotrue`.nothrow()).exitCode === 0) return;
        if (await Bun.file(this.GOTRUE_BIN).exists()) return;

        console.log("[Tenant] GoTrue binary not found, extracting...");
        try {
            let cid = (await $`docker ps -q -f "name=supabase-auth"`.text()).trim();
            if (!cid) cid = (await $`podman ps -q -f "name=supabase-auth"`.nothrow().text()).trim();

            if (cid) {
                await $`docker cp ${cid}:/usr/local/bin/gotrue /tmp/gotrue-extract 2>/dev/null || docker cp ${cid}:/usr/local/bin/auth /tmp/gotrue-extract 2>/dev/null`.nothrow();
                if (await Bun.file('/tmp/gotrue-extract').exists()) {
                    await $`mv /tmp/gotrue-extract ${this.GOTRUE_BIN}`;
                    await $`chmod +x ${this.GOTRUE_BIN}`;
                    return;
                }
            }
        } catch (e) { }
        throw new Error(`Failed to extract GoTrue from running auth container`);
    }

    /**
     * 生成租户环境变量和 conf 配置文件
     */
    static async generateTenantConfig(ref: string, pgrstPort: number, gotruePort: number): Promise<void> {
        await $`mkdir -p ${this.TENANT_CONFIG_DIR}`;
        const creds = await this.getTenantCredentials(ref);
        const db_name = `supa_${ref}`;

        const apiUrl = creds.api_url || process.env.GOTRUE_API_EXTERNAL_URL || "https://your-domain.com";

        // 1. PostgREST
        const pgrstEnv = `
# SupaCloud Tenant PostgREST Runtime: ${ref}
PGRST_DB_URI=postgres://authenticator_${ref}:${creds.db_password}@${this.PG_HOST}:${this.PG_PORT}/${db_name}
PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_EXTRA_SEARCH_PATH=public
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=${creds.jwt_secret}
PGRST_SERVER_PORT=${pgrstPort}
PGRST_DB_POOL=10
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL=warn
`;
        await Bun.write(`${this.TENANT_CONFIG_DIR}/${ref}.env`, pgrstEnv.trim());

        const pgrstConf = `
db-uri = "postgres://authenticator_${ref}:${creds.db_password}@${this.PG_HOST}:${this.PG_PORT}/${db_name}"
db-schemas = "public, storage, graphql_public"
db-extra-search-path = "public, extensions, auth, ${ref}"
db-anon-role = "anon"
jwt-secret = "${creds.jwt_secret}"
server-port = ${pgrstPort}
server-host = "0.0.0.0"
db-pool = 10
db-pool-acquisition-timeout = 10
log-level = "warn"
`;
        await Bun.write(`${this.TENANT_CONFIG_DIR}/${ref}.conf`, pgrstConf.trim());

        // 2. GoTrue
        const gotrueEnv = `
# SupaCloud Tenant GoTrue Runtime: ${ref}
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotruePort}
API_EXTERNAL_URL=${apiUrl}
GOTRUE_SITE_URL=${apiUrl}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${process.env.PG_PASSWORD || process.env.POSTGRES_PASSWORD || "postgres"}@${this.PG_HOST}:${this.PG_PORT}/${db_name}
GOTRUE_JWT_SECRET=${creds.jwt_secret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
`;
        await Bun.write(`${this.TENANT_CONFIG_DIR}/${ref}_gotrue.env`, gotrueEnv.trim());
    }

    /**
     * 安装并加载 Systemd 单元
     */
    static async installSystemdTemplate(): Promise<void> {
        const pgrstUnit = "/etc/systemd/system/supacloud-pgrst@.service";
        const gotrueUnit = "/etc/systemd/system/supacloud-gotrue@.service";

        if (!(await Bun.file(pgrstUnit).exists())) {
            const pgrstContent = `
[Unit]
Description=SupaCloud PostgREST for tenant %i
After=postgresql.service network.target
Wants=network.target

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i.env
Environment="GHCRTS=-N1 -M128m -I0.5 -A4m"
ExecStart=${this.POSTGREST_BIN} /etc/supabase/tenants/%i.conf +RTS -N1 -M128m -I0.5 -A4m -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
CPUWeight=20

[Install]
WantedBy=multi-user.target
`;
            await Bun.write(pgrstUnit, pgrstContent.trim());
        }

        if (!(await Bun.file(gotrueUnit).exists())) {
            const gotrueContent = `
[Unit]
Description=SupaCloud GoTrue for tenant %i
After=postgresql.service network.target
Wants=network.target

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=/etc/supabase/tenants/%i_gotrue.env
Environment="GOMEMLIMIT=128MiB"
ExecStart=${this.GOTRUE_BIN}
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/supabase/tenants
CPUWeight=20

[Install]
WantedBy=multi-user.target
`;
            await Bun.write(gotrueUnit, gotrueContent.trim());
        }

        await $`systemctl daemon-reload`.nothrow();
    }

    /**
     * 停止租户程序
     */
    static async stopRuntime(ref: string): Promise<void> {
        await $`systemctl stop supacloud-pgrst@${ref} supacloud-gotrue@${ref}`.nothrow();
        await $`systemctl disable supacloud-pgrst@${ref} supacloud-gotrue@${ref}`.nothrow();
        await $`rm -f ${this.TENANT_CONFIG_DIR}/${ref}.env ${this.TENANT_CONFIG_DIR}/${ref}.conf ${this.TENANT_CONFIG_DIR}/${ref}_gotrue.env`.nothrow();
    }

    /**
     * 重启 / 重载
     */
    static async restartRuntime(ref: string): Promise<void> {
        await this.ensurePostgrest();
        await this.ensureGotrue();
        await this.installSystemdTemplate();
        await $`systemctl restart supacloud-pgrst@${ref} supacloud-gotrue@${ref}`.nothrow();
    }
}
