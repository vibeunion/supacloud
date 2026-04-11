import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import { sql as metaSql } from "../db";
import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";
import { tenantOAuthService } from "./tenant-oauth.service";

export interface RuntimeStatus {
    status: "running" | "stopped" | "starting" | "error";
    port: number;
    gotruePort: number;
    health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

class TenantRuntimeService {
    private readonly TENANT_CONFIG_DIR = config.tenantConfigDir;
    private readonly POSTGREST_BIN = config.postgrestBin;
    private readonly GOTRUE_BIN = config.gotrueBin;
    private readonly PG_HOST = config.pgHost;
    private readonly PG_PORT = String(config.pgPort);

    private readonly PGRST_PORT_BASE = config.pgrstPortBase;
    private readonly GOTRUE_PORT_BASE = config.gotruePortBase;
    
    // config.portRange is a string like "3100-3200". We just need the difference as the range size.
    private readonly PORT_RANGE = (() => {
        const parts = config.portRange.split('-');
        if (parts.length === 2) {
            return parseInt(parts[1]) - parseInt(parts[0]);
        }
        return parseInt(config.portRange); // fallback if it's just a number
    })();

    private deriveApiUrl(ref: string, projectConfig: Record<string, unknown> | null | undefined): string {
        const explicitApiDomain = typeof projectConfig?.api_domain === "string" ? projectConfig.api_domain.trim() : "";
        if (explicitApiDomain) return `https://${explicitApiDomain}`;

        const customDomain = typeof projectConfig?.custom_domain === "string" ? projectConfig.custom_domain.trim() : "";
        if (customDomain) return `https://api.${customDomain}`;

        if (config.gotrueApiExternalUrl) return config.gotrueApiExternalUrl.replace(/\/+$/, "");

        return `https://${ref}.api.${config.baseDomain}`;
    }

    /**
     * Deterministic port allocation based on hashing
     * Aligned with original bash awk behavior using native Bun logic
     */
    private async getTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number> {
        const basePort = type === "pgrst" ? this.PGRST_PORT_BASE : this.GOTRUE_PORT_BASE;

        // Use bun:hash for performance
        const hash = Bun.hash(ref);
        // BigInt modulo for safe large number arithmetic
        let port = basePort + Number(BigInt(hash) % BigInt(this.PORT_RANGE));

        // Port collision detection logic
        const maxTries = 100;
        try {
            await fs.access(this.TENANT_CONFIG_DIR);
            for (let tryIdx = 0; tryIdx < maxTries; tryIdx++) {
                let conflict = false;
                const files = await fs.readdir(this.TENANT_CONFIG_DIR);

                for (const file of files) {
                    if (!file.endsWith(".env")) continue;

                    const existingRef = file.replace(/\.env$/, "").replace(/_gotrue$/, "");
                    if (existingRef === ref) continue; // Same tenant

                    const content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                    const searchStr = type === "gotrue" ? `GOTRUE_API_PORT=${port}` : `PGRST_SERVER_PORT=${port}`;

                    if (content.includes(searchStr)) {
                        conflict = true;
                        break;
                    }
                }

                if (!conflict) return port;
                port++;
            }
        } catch (e: unknown) {
            // Config directory missing, return the first calculated port
            throw e;
        }

        throw new Error(`Cannot find available port for ${ref} (${type})`);
    }

    /**
     * Retrieve credentials from supacloud_meta (local metadata DB)
     * Uses the global connection pool from db/index.ts
     */
    private async getTenantCredentials(ref: string) {
        const [project] = await metaSql`
          SELECT db_password, jwt_secret, config, db_name, anon_key, service_role_key
          FROM projects
          WHERE ref=${ref}
        `;

        if (!project || !project.db_password || !project.jwt_secret) {
            throw new Error(`Cannot find valid credentials for project ${ref} in supacloud_meta`);
        }

        const projectConfig = (project.config as Record<string, unknown> | null | undefined) || {};
        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
            dbName: project.db_name || `supa_${ref}`,
            apiUrl: this.deriveApiUrl(ref, projectConfig),
            anonKey: project.anon_key,
            serviceRoleKey: project.service_role_key
        };
    }

    /**
     * Ensure binaries exist at their configured paths.
     * PostgREST and GoTrue must be pre-installed — no container fallback.
     */
    private async ensureBinaries() {
        // Check PostgREST binary
        const pgrstCheck = await $`which postgrest`.nothrow().quiet();
        const hasPgrstBin = await Bun.file(this.POSTGREST_BIN).exists();

        if (pgrstCheck.exitCode !== 0 && !hasPgrstBin) {
            throw new Error(
                `PostgREST binary not found at ${this.POSTGREST_BIN} or in PATH. ` +
                `Install it manually: curl -L https://github.com/PostgREST/postgrest/releases/latest -o ${this.POSTGREST_BIN} && chmod +x ${this.POSTGREST_BIN}`
            );
        }

        // Check GoTrue binary
        const gotrueCheck = await $`which gotrue`.nothrow().quiet();
        const hasGotrueBin = await Bun.file(this.GOTRUE_BIN).exists();

        if (gotrueCheck.exitCode !== 0 && !hasGotrueBin) {
            throw new Error(
                `GoTrue binary not found at ${this.GOTRUE_BIN} or in PATH. ` +
                `Install it manually: curl -L https://github.com/supabase/gotrue/releases/latest -o ${this.GOTRUE_BIN} && chmod +x ${this.GOTRUE_BIN}`
            );
        }
    }

    private async generateTenantConfig(ref: string, pgrstPort: number, gotruePort: number) {
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true });

        const creds = await this.getTenantCredentials(ref);

        // Generate PostgREST .env configuration
        const pgrstEnv = `
# SupaCloud Tenant PostgREST Runtime: ${ref}
PGRST_DB_URI=postgres://authenticator_${ref}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_EXTRA_SEARCH_PATH=public
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=${creds.jwtSecret}
PGRST_SERVER_PORT=${pgrstPort}
PGRST_DB_POOL=10
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_LOG_LEVEL=warn

# SupaCloud Edge Runtime Injection
SUPABASE_URL=${creds.apiUrl}
SUPABASE_ANON_KEY=${creds.anonKey}
SUPABASE_SERVICE_ROLE_KEY=${creds.serviceRoleKey}
SUPABASE_DB_URL=postgresql://postgres:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
JWT_SECRET=${creds.jwtSecret}
`.trim();
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`), pgrstEnv);

        // Generate PostgREST .conf configuration
        const pgrstConf = `
# PostgREST config for tenant: ${ref}
db-uri = "postgres://authenticator_${ref}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}"
db-schemas = "public, storage, graphql_public"
db-extra-search-path = "public, extensions, auth"
db-anon-role = "anon"
jwt-secret = "${creds.jwtSecret}"
server-port = ${pgrstPort}
server-host = "0.0.0.0"
db-pool = 10
db-pool-acquisition-timeout = 10
log-level = "warn"
`.trim();
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}.conf`), pgrstConf);

        // Generate GoTrue .env configuration
        const apiExternalUrl = creds.apiUrl;
        const gotrueSender = config.gotrueSmtpAdminEmail || `noreply@${apiExternalUrl.replace('https://', '').replace('http://', '')}`;

        let gotrueEnv = `
# SupaCloud Tenant GoTrue Runtime: ${ref}
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotruePort}
API_EXTERNAL_URL=${apiExternalUrl}
GOTRUE_SITE_URL=${apiExternalUrl}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
GOTRUE_JWT_SECRET=${creds.jwtSecret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true
GOTRUE_WEBAUTHN_ENABLED=true
GOTRUE_WEBAUTHN_RP_ID=${apiExternalUrl.replace('https://', '').replace('http://', '').split('/')[0]}
`.trim();

        if (config.gotrueSmtpHost) {
            gotrueEnv += `
# SMTP Configuration
GOTRUE_SMTP_ADMIN_EMAIL=${gotrueSender}
GOTRUE_SMTP_HOST=${config.gotrueSmtpHost}
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=${config.gotrueSmtpUser}
GOTRUE_SMTP_PASS=${config.gotrueSmtpPass}
GOTRUE_SMTP_SENDER_NAME=SupaCloud
`;
        }
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`), gotrueEnv);

        logger.info(`Config generated for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
    }

    private async installSystemdTemplate() {
        const pgrstUnitPath = "/etc/systemd/system/supacloud-pgrst@.service";
        const gotrueUnitPath = "/etc/systemd/system/supacloud-gotrue@.service";

        // Avoid redundant disk IO if units already exist
        const pgrstExists = await Bun.file(pgrstUnitPath).exists();
        if (!pgrstExists) {
            const pgrstUnit = `
[Unit]
Description=SupaCloud PostgREST for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=${this.TENANT_CONFIG_DIR}/%i.env
Environment="GHCRTS=-N1 -M30m -I0.1 -A1m"
ExecStart=${this.POSTGREST_BIN} ${this.TENANT_CONFIG_DIR}/%i.conf +RTS -N1 -M30m -I0.1 -A1m -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${this.TENANT_CONFIG_DIR}
MemoryMax=45M
CPUWeight=20

[Install]
WantedBy=multi-user.target
`.trim();
            await Bun.write(pgrstUnitPath, pgrstUnit);
        }

        const gotrueExists = await Bun.file(gotrueUnitPath).exists();
        if (!gotrueExists) {
            const gotrueUnit = `
[Unit]
Description=SupaCloud GoTrue for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nobody
EnvironmentFile=${this.TENANT_CONFIG_DIR}/%i_gotrue.env
Environment="GOMEMLIMIT=15MiB"
Environment="GOGC=20"
ExecStart=${this.GOTRUE_BIN}
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${this.TENANT_CONFIG_DIR}
MemoryMax=30M
CPUWeight=20

[Install]
WantedBy=multi-user.target
`.trim();
            await Bun.write(gotrueUnitPath, gotrueUnit);
        }

        if (!pgrstExists || !gotrueExists) {
            await $`systemctl daemon-reload`.nothrow().quiet();
            logger.info("systemd template units installed");
        }
    }

    public async startRuntime(ref: string): Promise<RuntimeStatus> {
        await this.ensureBinaries();
        await this.installSystemdTemplate();

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");

        await this.generateTenantConfig(ref, pgrstPort, gotruePort);

        // Start and enable systemd units
        await $`systemctl enable supacloud-pgrst@${ref}`.nothrow().quiet();
        await $`systemctl start supacloud-pgrst@${ref}`.nothrow().quiet();

        await $`systemctl enable supacloud-gotrue@${ref}`.nothrow().quiet();
        await $`systemctl start supacloud-gotrue@${ref}`.nothrow().quiet();

        // Wait for service health checks
        logger.info(`Waiting for PostgREST(${pgrstPort}) and GoTrue(${gotruePort}) health checks...`);
        let pgrstOk = false;
        let gotrueOk = false;

        for (let tryIdx = 0; tryIdx < 20; tryIdx++) {
            if (!pgrstOk) {
                try {
                    const res = await fetch(`http://127.0.0.1:${pgrstPort}/`);
                    if (res.ok) pgrstOk = true;
                } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
            }

            if (!gotrueOk) {
                try {
                    const res = await fetch(`http://127.0.0.1:${gotruePort}/health`);
                    if (res.ok) gotrueOk = true;
                } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
            }

            if (pgrstOk && gotrueOk) {
                return { status: "running", port: pgrstPort, gotruePort, health: "healthy" };
            }
            await Bun.sleep(1000);
        }

        logger.warn("WARNING: Health check timeout, some services may still be starting");
        return { status: "starting", port: pgrstPort, gotruePort, health: "degraded" };
    }

    public async stopRuntime(ref: string): Promise<void> {
        await $`systemctl stop supacloud-pgrst@${ref}`.nothrow().quiet();
        await $`systemctl disable supacloud-pgrst@${ref}`.nothrow().quiet();

        await $`systemctl stop supacloud-gotrue@${ref}`.nothrow().quiet();
        await $`systemctl disable supacloud-gotrue@${ref}`.nothrow().quiet();

        // Clean up configuration files
        const pgrstEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`));
        const pgrstConfFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.conf`));
        const gotrueEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`));

        if (await pgrstEnvFile.exists()) await fs.unlink(pgrstEnvFile.name!);
        if (await pgrstConfFile.exists()) await fs.unlink(pgrstConfFile.name!);
        if (await gotrueEnvFile.exists()) await fs.unlink(gotrueEnvFile.name!);

        logger.info(`Runtime stopped for ${ref}`);
    }

    public async restartRuntime(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = (await $`systemctl is-active supacloud-pgrst@${ref}`.nothrow().quiet()).exitCode === 0;
        const gotrueActive = (await $`systemctl is-active supacloud-gotrue@${ref}`.nothrow().quiet()).exitCode === 0;

        if (pgrstActive || gotrueActive) {
            await this.ensureBinaries();
            await this.installSystemdTemplate();

            const pgrstPort = await this.getTenantPort(ref, "pgrst");
            const gotruePort = await this.getTenantPort(ref, "gotrue");
            await this.generateTenantConfig(ref, pgrstPort, gotruePort);

            await $`systemctl restart supacloud-pgrst@${ref}`.nothrow().quiet();
            await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();

            return await this.checkStatus(ref);
        } else {
            return await this.startRuntime(ref);
        }
    }

    public async checkStatus(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = (await $`systemctl is-active supacloud-pgrst@${ref}`.nothrow().quiet()).exitCode === 0;
        const gotrueActive = (await $`systemctl is-active supacloud-gotrue@${ref}`.nothrow().quiet()).exitCode === 0;

        const port = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");

        if (pgrstActive || gotrueActive) {
            let pgrstOk = false;
            let gotrueOk = false;

            try {
                pgrstOk = (await fetch(`http://127.0.0.1:${port}/`)).ok;
            } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

            try {
                gotrueOk = (await fetch(`http://127.0.0.1:${gotruePort}/health`)).ok;
            } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

            let health: RuntimeStatus["health"] = "unhealthy";
            if (pgrstOk && gotrueOk) health = "healthy";
            else if (pgrstOk || gotrueOk) health = "degraded";

            return { status: "running", port, gotruePort, health };
        }

        return { status: "stopped", port, gotruePort, health: "unknown" };
    }

    public async updateOAuthConfig(ref: string, provider: OAuthProvider, providerConfig: OAuthProviderConfig): Promise<void> {
        return tenantOAuthService.updateOAuthConfig(ref, provider, providerConfig);
    }

    public async removeOAuthConfig(ref: string, provider: OAuthProvider): Promise<void> {
        return tenantOAuthService.removeOAuthConfig(ref, provider);
    }

    public async updateGoTrueCustomOAuth(ref: string, config: {
        name: string;
        client_id: string;
        client_secret: string;
        redirect_uri: string;
        authorize_url: string;
        token_url: string;
        user_url: string;
        auth_scheme?: string;
    }): Promise<void> {
        return tenantOAuthService.updateGoTrueCustomOAuth(ref, config);
    }
}

export const tenantRuntimeService = new TenantRuntimeService();
