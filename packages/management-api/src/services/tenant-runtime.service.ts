import { $ } from "bun";
import { logger } from "../utils/logger";
import { sql as metaSql } from "../db";
import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";

export interface RuntimeStatus {
    status: "running" | "stopped" | "starting" | "error";
    port: number;
    gotruePort: number;
    health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

class TenantRuntimeService {
    private readonly TENANT_CONFIG_DIR = process.env.TENANT_CONFIG_DIR || "/etc/supabase/tenants";
    private readonly POSTGREST_BIN = process.env.POSTGREST_BIN || "/usr/local/bin/postgrest";
    private readonly GOTRUE_BIN = process.env.GOTRUE_BIN || "/usr/local/bin/gotrue";
    private readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
    private readonly PG_PORT = process.env.PG_PORT || process.env.POSTGRES_PORT || "5432";

    private readonly PGRST_PORT_BASE = parseInt(process.env.PGRST_PORT_BASE || "3100");
    private readonly GOTRUE_PORT_BASE = parseInt(process.env.GOTRUE_PORT_BASE || "4100");
    private readonly PORT_RANGE = parseInt(process.env.PORT_RANGE || "10000");

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
        const [project] = await metaSql`SELECT db_password, jwt_secret, config->>'api_url' as api_url, db_name FROM projects WHERE ref=${ref}`;

        if (!project || !project.db_password || !project.jwt_secret) {
            throw new Error(`Cannot find valid credentials for project ${ref} in supacloud_meta`);
        }

        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
            dbName: project.db_name || `supa_${ref}`,
            apiUrl: (project.api_url as string) || process.env.GOTRUE_API_EXTERNAL_URL || "https://your-supacloud-domain.com"
        };
    }

    /**
     * Ensure binaries exist at their configured paths.
     * PostgREST and GoTrue must be pre-installed — no container fallback.
     */
    private async ensureBinaries() {
        // Check PostgREST binary
        const pgrstCheck = await $`which postgrest`.nothrow().quiet();
        const hasPgrstBin = await fs.access(this.POSTGREST_BIN).then(() => true).catch(() => false);

        if (pgrstCheck.exitCode !== 0 && !hasPgrstBin) {
            throw new Error(
                `PostgREST binary not found at ${this.POSTGREST_BIN} or in PATH. ` +
                `Install it manually: curl -L https://github.com/PostgREST/postgrest/releases/latest -o ${this.POSTGREST_BIN} && chmod +x ${this.POSTGREST_BIN}`
            );
        }

        // Check GoTrue binary
        const gotrueCheck = await $`which gotrue`.nothrow().quiet();
        const hasGotrueBin = await fs.access(this.GOTRUE_BIN).then(() => true).catch(() => false);

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
`.trim();
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`), pgrstEnv);

        // Generate PostgREST .conf configuration
        const pgrstConf = `
# PostgREST config for tenant: ${ref}
db-uri = "postgres://authenticator_${ref}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}"
db-schemas = "public, storage, graphql_public"
db-extra-search-path = "public, extensions, auth, ${ref}"
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
        const gotrueSender = process.env.GOTRUE_SMTP_ADMIN_EMAIL || `noreply@${apiExternalUrl.replace('https://', '').replace('http://', '')}`;

        let gotrueEnv = `
# SupaCloud Tenant GoTrue Runtime: ${ref}
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotruePort}
API_EXTERNAL_URL=${apiExternalUrl}
GOTRUE_SITE_URL=${apiExternalUrl}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'postgres'}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
GOTRUE_JWT_SECRET=${creds.jwtSecret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
`.trim();

        if (process.env.GOTRUE_SMTP_HOST) {
            gotrueEnv += `
# SMTP Configuration
GOTRUE_SMTP_ADMIN_EMAIL=${gotrueSender}
GOTRUE_SMTP_HOST=${process.env.GOTRUE_SMTP_HOST}
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=${process.env.GOTRUE_SMTP_USER || ''}
GOTRUE_SMTP_PASS=${process.env.GOTRUE_SMTP_PASS || ''}
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
        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);

        const exists = await Bun.file(gotrueEnvPath).exists();
        if (!exists) {
            throw new Error(`GoTrue config file not found for project ${ref}`);
        }

        let envContent = await Bun.file(gotrueEnvPath).text();

        const mapping = OAUTH_ENV_MAPPINGS[provider];
        if (!mapping) {
            throw new Error(`Unsupported OAuth provider: ${provider}`);
        }

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        const addedKeys = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                updatedLines.push(line);
                continue;
            }

            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();

            if (keyTrimmed === mapping.clientId) {
                updatedLines.push(`${mapping.clientId}=${providerConfig.client_id}`);
                addedKeys.add(mapping.clientId);
            } else if (keyTrimmed === mapping.clientSecret) {
                updatedLines.push(`${mapping.clientSecret}=${providerConfig.client_secret}`);
                addedKeys.add(mapping.clientSecret);
            } else if (mapping.redirectUri && keyTrimmed === mapping.redirectUri) {
                if (providerConfig.redirect_uri) {
                    updatedLines.push(`${mapping.redirectUri}=${providerConfig.redirect_uri}`);
                }
                addedKeys.add(mapping.redirectUri);
            } else if (mapping.url && keyTrimmed === mapping.url) {
                if (providerConfig.url) {
                    updatedLines.push(`${mapping.url}=${providerConfig.url}`);
                }
                addedKeys.add(mapping.url);
            } else {
                updatedLines.push(line);
            }
        }

        const newLines: string[] = [];
        if (!addedKeys.has(mapping.clientId)) {
            newLines.push(`${mapping.clientId}=${providerConfig.client_id}`);
        }
        if (!addedKeys.has(mapping.clientSecret)) {
            newLines.push(`${mapping.clientSecret}=${providerConfig.client_secret}`);
        }
        if (mapping.redirectUri && providerConfig.redirect_uri && !addedKeys.has(mapping.redirectUri)) {
            newLines.push(`${mapping.redirectUri}=${providerConfig.redirect_uri}`);
        }
        if (mapping.url && providerConfig.url && !addedKeys.has(mapping.url)) {
            newLines.push(`${mapping.url}=${providerConfig.url}`);
        }

        if (newLines.length > 0) {
            updatedLines.push("");
            updatedLines.push(`# OAuth Provider: ${provider}`);
            updatedLines.push(...newLines);
        }

        await Bun.write(gotrueEnvPath, updatedLines.join("\n"));

        await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();
        logger.info(`OAuth config updated for ${provider} in project ${ref}`);
    }

    public async removeOAuthConfig(ref: string, provider: OAuthProvider): Promise<void> {
        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);

        const exists = await Bun.file(gotrueEnvPath).exists();
        if (!exists) {
            return;
        }

        let envContent = await Bun.file(gotrueEnvPath).text();

        const mapping = OAUTH_ENV_MAPPINGS[provider];
        if (!mapping) {
            throw new Error(`Unsupported OAuth provider: ${provider}`);
        }

        const keysToRemove = new Set<string>([
            mapping.clientId,
            mapping.clientSecret,
        ]);
        if (mapping.redirectUri) keysToRemove.add(mapping.redirectUri);
        if (mapping.url) keysToRemove.add(mapping.url);

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                updatedLines.push(line);
                continue;
            }

            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();

            if (keyTrimmed && keysToRemove.has(keyTrimmed)) {
                continue;
            }

            updatedLines.push(line);
        }

        await Bun.write(gotrueEnvPath, updatedLines.join("\n"));

        await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();
        logger.info(`OAuth config removed for ${provider} in project ${ref}`);
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
        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);

        const exists = await Bun.file(gotrueEnvPath).exists();
        if (!exists) {
            throw new Error(`GoTrue config file not found for project ${ref}`);
        }

        let envContent = await Bun.file(gotrueEnvPath).text();

        const prefix = `GOTRUE_EXTERNAL_${config.name.toUpperCase()}`;
        const customOAuthEnv = `
# Custom OAuth Provider: ${config.name}
${prefix}_CLIENT_ID=${config.client_id}
${prefix}_SECRET=${config.client_secret}
${prefix}_REDIRECT_URI=${config.redirect_uri}
${prefix}_URL=${config.authorize_url}
`;

        const keysToRemove = new Set<string>([
            `${prefix}_CLIENT_ID`,
            `${prefix}_SECRET`,
            `${prefix}_REDIRECT_URI`,
            `${prefix}_URL`,
        ]);

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        let hasCustomSection = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                if (trimmed.includes(`# Custom OAuth Provider: ${config.name}`)) {
                    hasCustomSection = true;
                }
                updatedLines.push(line);
                continue;
            }

            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();

            if (keyTrimmed && keysToRemove.has(keyTrimmed)) {
                continue;
            }

            updatedLines.push(line);
        }

        if (!hasCustomSection) {
            updatedLines.push(customOAuthEnv);
        } else {
            const sectionStartIndex = updatedLines.findIndex(l => 
                l.includes(`# Custom OAuth Provider: ${config.name}`)
            );
            if (sectionStartIndex >= 0) {
                updatedLines.splice(sectionStartIndex + 1, 0, ...customOAuthEnv.trim().split("\n").slice(1));
            }
        }

        await Bun.write(gotrueEnvPath, updatedLines.join("\n"));

        await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();
        logger.info(`Custom OAuth config updated for ${config.name} in project ${ref}`);
    }
}

export const tenantRuntimeService = new TenantRuntimeService();
