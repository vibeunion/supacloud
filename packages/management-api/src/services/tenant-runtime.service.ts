import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import { sql as metaSql, resolveDbName, resolveAuthenticatorName, resolvePgrstChannel } from "../db";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";
import { tenantOAuthService } from "./tenant-oauth.service";
import { resolveProjectApiUrl, resolveProjectStudioUrl } from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectJwtJwks, normalizeProjectJwtKeys } from "../utils/project-jwt";

function stringifyJsonConfig(value: unknown): string | null {
    if (!value) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
}

function quoteSystemdEnvValue(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface RuntimeStatus {
    status: "running" | "stopped" | "starting" | "error";
    port: number;
    gotruePort: number;
    health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

export type RuntimeDesiredState = "running" | "stopped";

export interface PostgrestRuntimeStatus {
    component: "postgrest";
    desired: RuntimeDesiredState;
    actual: RuntimeStatus["status"];
    port: number;
    unit: string;
    health: "healthy" | "unhealthy" | "unknown";
    last_error: string | null;
    updated_at: string | null;
    last_reconciled_at: string | null;
}

export interface ProjectServiceStatus {
    id: string;
    name: string;
    status: string;
    healthy: boolean;
    service_host_ids: string[];
    component?: "postgrest";
    desired_state?: RuntimeDesiredState;
    actual_state?: RuntimeStatus["status"];
    health?: PostgrestRuntimeStatus["health"];
    port?: number;
    unit?: string;
    last_error?: string | null;
    updated_at?: string | null;
    last_reconciled_at?: string | null;
}

class PostgrestRuntimeController {
    unit(ref: string): string {
        return `supacloud-pgrst@${ref}`;
    }

    async isActive(ref: string): Promise<boolean> {
        return (await $`systemctl is-active ${this.unit(ref)}`.nothrow().quiet()).exitCode === 0;
    }

    async enable(ref: string): Promise<void> {
        await $`systemctl enable ${this.unit(ref)}`.nothrow().quiet();
    }

    async start(ref: string): Promise<void> {
        await $`systemctl start ${this.unit(ref)}`.nothrow().quiet();
    }

    async restart(ref: string): Promise<void> {
        await $`systemctl restart ${this.unit(ref)}`.nothrow().quiet();
    }

    async stop(ref: string): Promise<void> {
        await $`systemctl stop ${this.unit(ref)}`.nothrow().quiet();
    }

    async disable(ref: string): Promise<void> {
        await $`systemctl disable ${this.unit(ref)}`.nothrow().quiet();
    }

    async observe(ref: string, port: number): Promise<Pick<PostgrestRuntimeStatus, "actual" | "health" | "last_error">> {
        if (!(await this.isActive(ref))) {
            return { actual: "stopped", health: "unknown", last_error: null };
        }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.ok) {
                return { actual: "running", health: "healthy", last_error: null };
            }
            return {
                actual: "error",
                health: "unhealthy",
                last_error: `PostgREST health check failed with HTTP ${res.status}`,
            };
        } catch (error: unknown) {
            return {
                actual: "error",
                health: "unhealthy",
                last_error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async startOrRepair(
        ref: string,
        port: number,
        mode: "restart" | "repair",
    ): Promise<PostgrestRuntimeStatus> {
        const active = await this.isActive(ref);
        const shouldRestart = active && (
            mode === "restart" ||
            (mode === "repair" && (await this.observe(ref, port)).health !== "healthy")
        );

        await this.enable(ref);
        if (shouldRestart) {
            await this.restart(ref);
        } else if (!active) {
            await this.start(ref);
        }

        return this.waitForHealthy(ref, port);
    }

    async waitForHealthy(
        ref: string,
        port: number,
        attempts = 10,
        delayMs = 500,
    ): Promise<PostgrestRuntimeStatus> {
        let status = await this.observe(ref, port);
        for (let tryIdx = 0; tryIdx < attempts && status.health !== "healthy"; tryIdx++) {
            await Bun.sleep(delayMs);
            status = await this.observe(ref, port);
        }
        return {
            component: "postgrest",
            desired: "running",
            actual: status.actual,
            port,
            unit: this.unit(ref),
            health: status.health,
            last_error: status.last_error,
            updated_at: null,
            last_reconciled_at: null,
        };
    }

    async stopAndDisable(ref: string): Promise<void> {
        await this.stop(ref);
        await this.disable(ref);
    }
}

class TenantRuntimeService {
    private readonly TENANT_CONFIG_DIR = config.tenantConfigDir;
    private readonly POSTGREST_BIN = config.postgrestBin;
    private readonly POSTGREST_RTS = config.postgrestRts;
    private readonly POSTGREST_MEMORY_MAX = config.postgrestMemoryMax;
    private readonly POSTGREST_CPU_WEIGHT = config.postgrestCpuWeight;
    private readonly POSTGREST_DB_POOL = config.postgrestDbPool;
    private readonly GOTRUE_BIN = config.gotrueBin;
    private readonly PG_HOST = config.pgHost;
    private readonly PG_PORT = String(config.pgPort);

    private readonly PGRST_PORT_BASE = config.pgrstPortBase;
    private readonly GOTRUE_PORT_BASE = config.gotruePortBase;
    private readonly postgrestController = new PostgrestRuntimeController();

    // config.portRange is a string like "3100-3200". We just need the difference as the range size.
    private readonly PORT_RANGE = (() => {
        const parts = config.portRange.split('-');
        if (parts.length === 2) {
            return parseInt(parts[1]) - parseInt(parts[0]);
        }
        return parseInt(config.portRange); // fallback if it's just a number
    })();

    private deriveApiUrl(ref: string, projectConfig: Record<string, unknown> | null | undefined): string {
        return resolveProjectApiUrl(ref, projectConfig);
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
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true });
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

        const projectConfig = normalizeProjectConfig(project.config);
        const authConfig = (projectConfig.auth as Record<string, unknown>) || {};
        const oauthServerConfig = (authConfig.oauth_server || {}) as Record<string, unknown>;
        const jwtKeys = stringifyJsonConfig(normalizeProjectJwtKeys(oauthServerConfig.jwt_keys));
        const jwtJwks = stringifyJsonConfig(normalizeProjectJwtJwks(oauthServerConfig.jwt_jwks));
        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
            jwtKeys,
            jwtJwks,
            dbName: await resolveDbName(ref),
            apiUrl: this.deriveApiUrl(ref, projectConfig),
            anonKey: project.anonKey || project.anon_key,
            serviceRoleKey: project.serviceRoleKey || project.service_role_key,
            siteUrl: typeof projectConfig.site_url === "string"
                ? projectConfig.site_url
                : (typeof projectConfig.siteUrl === "string"
                    ? projectConfig.siteUrl
                    : resolveProjectStudioUrl(ref, projectConfig)),
            uriAllowList: Array.isArray(projectConfig.additional_redirect_urls) ? projectConfig.additional_redirect_urls.join(',') : (Array.isArray(projectConfig.additionalRedirectUrls) ? projectConfig.additionalRedirectUrls.join(',') : ""),
            authConfig
        };
    }

    /**
     * Ensure binaries exist at their configured paths.
     * PostgREST and GoTrue must be pre-installed — no container fallback.
     */
    private async ensurePostgrestBinary() {
        const pgrstCheck = await $`which postgrest`.nothrow().quiet();
        const hasPgrstBin = await Bun.file(this.POSTGREST_BIN).exists();

        if (pgrstCheck.exitCode !== 0 && !hasPgrstBin) {
            throw new Error(
                `PostgREST binary not found at ${this.POSTGREST_BIN} or in PATH. ` +
                `Install it manually: curl -L https://github.com/PostgREST/postgrest/releases/latest -o ${this.POSTGREST_BIN} && chmod +x ${this.POSTGREST_BIN}`
            );
        }
    }

    private async ensureGotrueBinary() {
        const gotrueCheck = await $`which gotrue`.nothrow().quiet();
        const hasGotrueBin = await Bun.file(this.GOTRUE_BIN).exists();

        if (gotrueCheck.exitCode !== 0 && !hasGotrueBin) {
            throw new Error(
                `GoTrue binary not found at ${this.GOTRUE_BIN} or in PATH. ` +
                `Install it manually: curl -L https://github.com/supabase/gotrue/releases/latest -o ${this.GOTRUE_BIN} && chmod +x ${this.GOTRUE_BIN}`
            );
        }
    }

    private async ensureBinaries() {
        await this.ensurePostgrestBinary();
        await this.ensureGotrueBinary();
    }

    private async generateTenantConfig(ref: string, pgrstPort: number, gotruePort: number) {
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true });

        const creds = await this.getTenantCredentials(ref);

        const jwtVerifierSecret = creds.jwtJwks || creds.jwtSecret;
        const jwtJwksEnv = creds.jwtJwks ? `\nJWT_JWKS=${quoteSystemdEnvValue(creds.jwtJwks)}` : "";
        const jwtKeysEnv = creds.jwtKeys ? `\nJWT_KEYS=${quoteSystemdEnvValue(creds.jwtKeys)}` : "";

        // Generate PostgREST .env configuration
        // Edge runtime and other services consume these env vars
        const pgrstEnv = `
# SupaCloud Tenant PostgREST Runtime: ${ref}
# PGRST_* variables have been removed to avoid duplicate configuration (P2-2)
# PostgREST configuration is now single-sourced from the .conf file.

# SupaCloud Edge Runtime Injection
SUPABASE_URL=${creds.apiUrl}
SUPABASE_ANON_KEY=${creds.anonKey}
SUPABASE_SERVICE_ROLE_KEY=${creds.serviceRoleKey}
SUPABASE_DB_URL=postgresql://${resolveAuthenticatorName(ref)}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
JWT_SECRET=${creds.jwtSecret}
${jwtJwksEnv}${jwtKeysEnv}
`.trim();
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`), pgrstEnv);

        // Generate PostgREST .conf configuration (single source of truth for all settings)
        const pgrstConf = `
# PostgREST config for tenant: ${ref}
db-uri = "postgres://${resolveAuthenticatorName(ref)}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}"
db-schemas = "public, storage, graphql_public"
db-extra-search-path = "public, extensions, auth"
db-anon-role = "anon"
jwt-secret = ${JSON.stringify(jwtVerifierSecret)}
server-port = ${pgrstPort}
server-host = "0.0.0.0"
db-pool = ${this.POSTGREST_DB_POOL}
db-pool-acquisition-timeout = 10
log-level = "warn"

# P0-10: OpenAPI spec generation (required by Studio Table Editor & API Docs)
openapi-mode = "follow-privileges"
openapi-server-proxy-uri = "${creds.apiUrl}/rest/v1"

# P0-11: Pre-request function for RLS context injection
db-pre-request = "public.set_request_context"

# P1-7: Row limit protection
db-max-rows = 1000

# P2-3: Restrict CORS to the tenant's API domain
server-cors-allowed-origins = "${creds.apiUrl}"

# P2-4: Tenant-specific listen channel for schema cache invalidation
db-channel = "${resolvePgrstChannel(ref)}"
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
GOTRUE_SITE_URL=${creds.siteUrl}
GOTRUE_URI_ALLOW_LIST=${creds.uriAllowList || creds.siteUrl}
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
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
GOTRUE_EXTERNAL_PHONE_ENABLED=true
GOTRUE_WEBAUTHN_ENABLED=true
GOTRUE_WEBAUTHN_RP_ID=${creds.siteUrl.replace('https://', '').replace('http://', '').split('/')[0].split(':')[0]}
GOTRUE_WEBAUTHN_RP_ORIGINS=https://${creds.siteUrl.replace('https://', '').replace('http://', '').split('/')[0].split(':')[0]},${apiExternalUrl}
GOTRUE_PASSWORD_MIN_LENGTH=8
GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true
GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_REUSE_INTERVAL=10
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
# Admin Operator Token (P0-6)
GOTRUE_OPERATOR_TOKEN=${config.masterToken || creds.serviceRoleKey}
`.trim();

        const oauthServerConfig = (creds.authConfig.oauth_server || {}) as Record<string, unknown>;
        if (oauthServerConfig.enabled === true) {
            gotrueEnv += `

# OAuth 2.1 / OIDC Provider Configuration
GOTRUE_OAUTH_SERVER_ENABLED=true
GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=${oauthServerConfig.allow_dynamic_registration === true ? "true" : "false"}
GOTRUE_JWT_ISSUER=${oauthServerConfig.issuer || `${apiExternalUrl}/auth/v1`}
${creds.jwtKeys ? `GOTRUE_JWT_KEYS=${quoteSystemdEnvValue(creds.jwtKeys)}\nJWT_KEYS=${quoteSystemdEnvValue(creds.jwtKeys)}` : ""}
`;
        }

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
            if (creds.authConfig.mailer_autoconfirm) {
                gotrueEnv += `GOTRUE_MAILER_AUTOCONFIRM=true\n`;
            }
        } else {
            // P1-1: Enable auto-confirm if no SMTP is configured so users can register
            gotrueEnv += `
# Local Dev / No-SMTP Configuration
GOTRUE_MAILER_AUTOCONFIRM=true
`;
        }
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`), gotrueEnv);

        logger.info(`Config generated for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
    }

    private async installSystemdTemplate() {
        const pgrstUnitPath = "/etc/systemd/system/supacloud-pgrst@.service";
        const gotrueUnitPath = "/etc/systemd/system/supacloud-gotrue@.service";

        // Avoid redundant disk IO unless upgrading the old 30 MB PostgREST unit.
        const pgrstExists = await Bun.file(pgrstUnitPath).exists();
        const shouldWritePgrstUnit = !pgrstExists || await unitHasLegacyPostgrestMemoryLimit(pgrstUnitPath);
        if (shouldWritePgrstUnit) {
            const pgrstUnit = `
[Unit]
Description=SupaCloud PostgREST for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=nobody
Group=nogroup
EnvironmentFile=${this.TENANT_CONFIG_DIR}/%i.env
Environment="GHCRTS=${this.POSTGREST_RTS}"
ExecStart=${this.POSTGREST_BIN} ${this.TENANT_CONFIG_DIR}/%i.conf +RTS ${this.POSTGREST_RTS} -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${this.TENANT_CONFIG_DIR}
MemoryMax=${this.POSTGREST_MEMORY_MAX}
CPUWeight=${this.POSTGREST_CPU_WEIGHT}

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
Group=nogroup
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

        if (shouldWritePgrstUnit || !gotrueExists) {
            await $`systemctl daemon-reload`.nothrow().quiet();
            logger.info("systemd template units installed");
        }
    }

    private async ensureAuthSchema(ref: string): Promise<void> {
        const dbName = await resolveDbName(ref);
        const dbUrl = `postgres://postgres:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${dbName}`;

        const result = await $`psql ${dbUrl} -t -A -c "SELECT 1 FROM pg_namespace WHERE nspname = 'auth'"`.nothrow().quiet();
        const schemaExists = result.stdout.toString().trim() === "1";

        if (!schemaExists) {
            logger.info(`Creating auth schema in tenant database ${dbName}`);
            await $`psql ${dbUrl} -c "CREATE SCHEMA IF NOT EXISTS auth"`.nothrow().quiet();
            await $`psql ${dbUrl} -c "GRANT ALL ON SCHEMA auth TO supabase_auth_admin"`.nothrow().quiet();
            await $`psql ${dbUrl} -c "GRANT USAGE ON SCHEMA auth TO authenticated"`.nothrow().quiet();
            await $`psql ${dbUrl} -c "GRANT USAGE ON SCHEMA auth TO anon"`.nothrow().quiet();
            await $`psql ${dbUrl} -c "ALTER ROLE supabase_auth_admin SET search_path = auth, public"`.nothrow().quiet();
        }

        const usersTableResult = await $`psql ${dbUrl} -t -A -c "SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'users'"`.nothrow().quiet();
        const usersTableExists = usersTableResult.stdout.toString().trim() === "1";

        if (!usersTableExists) {
            logger.info(`Initializing auth schema tables in tenant database ${dbName}`);
            const initSql = `
CREATE TABLE IF NOT EXISTS auth.users (
    instance_id uuid NULL,
    id uuid NOT NULL UNIQUE,
    aud varchar(255) NULL,
    "role" varchar(255) NULL,
    email varchar(255) NULL UNIQUE,
    encrypted_password varchar(255) NULL,
    email_confirmed_at timestamptz NULL,
    invited_at timestamptz NULL,
    confirmation_token varchar(255) NULL,
    confirmation_sent_at timestamptz NULL,
    recovery_token varchar(255) NULL,
    recovery_sent_at timestamptz NULL,
    email_change_token_new varchar(255) NULL DEFAULT '',
    email_change varchar(255) NULL DEFAULT '',
    email_change_sent_at timestamptz NULL,
    last_sign_in_at timestamptz NULL,
    raw_app_meta_data jsonb NULL,
    raw_user_meta_data jsonb NULL,
    is_super_admin bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    phone varchar(15) NULL UNIQUE DEFAULT NULL,
    phone_confirmed_at timestamptz NULL DEFAULT NULL,
    phone_change varchar(15) NULL DEFAULT '',
    phone_change_token varchar(255) NULL DEFAULT '',
    phone_change_sent_at timestamptz NULL DEFAULT NULL,
    confirmed_at timestamptz NULL,
    email_change_token_current varchar(255) NULL DEFAULT '',
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamptz NULL,
    reauthentication_token varchar(255) NULL DEFAULT '',
    reauthentication_sent_at timestamptz NULL DEFAULT NULL,
    is_anonymous bool NULL DEFAULT FALSE,
    is_sso_user bool NOT NULL DEFAULT FALSE,
    deleted_at timestamptz NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS users_instance_id_email_idx ON auth.users USING btree (instance_id, email);
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users USING btree (instance_id);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id uuid NULL,
    id bigserial NOT NULL,
    "token" varchar(255) NULL,
    user_id uuid NULL,
    revoked bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    parent varchar(255) NULL,
    session_id uuid NULL,
    CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON auth.refresh_tokens USING btree (token);

CREATE TABLE IF NOT EXISTS auth.instances (
    id uuid NOT NULL,
    uuid uuid NULL,
    raw_base_config text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT instances_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
    instance_id uuid NULL,
    id uuid NOT NULL,
    payload json NULL,
    created_at timestamptz NULL,
    CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);

CREATE TABLE IF NOT EXISTS auth.identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id text NOT NULL,
    provider text NOT NULL,
    identity_data jsonb NOT NULL DEFAULT '{}',
    last_sign_in_at timestamptz NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT identities_pkey PRIMARY KEY (id),
    CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities(user_id);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text NULL,
    factor_type text NOT NULL,
    status text NOT NULL,
    secret text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT mfa_factors_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamptz NULL,
    verified_at timestamptz NULL,
    ip_address inet NULL,
    CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_challenges_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.flow_state (
    id uuid NOT NULL,
    user_id uuid NULL,
    auth_code varchar(255) NULL,
    code_challenge_method varchar(255) NULL,
    code_challenge varchar(255) NULL,
    provider_type text NOT NULL,
    provider_access_token text NULL,
    provider_refresh_token text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    authentication_method text NOT NULL,
    CONSTRAINT flow_state_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.sso_providers (
    id uuid NOT NULL,
    resource_id text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT sso_providers_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamptz NULL,
    CONSTRAINT sso_domains_pkey PRIMARY KEY (id),
    CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.schema_migrations (
    "version" varchar(255) NOT NULL,
    CONSTRAINT schema_migrations_pkey PRIMARY KEY ("version")
);

CREATE OR REPLACE FUNCTION auth.uid() returns uuid as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$ language sql stable;
CREATE OR REPLACE FUNCTION auth.role() returns text as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text; $$ language sql stable;

GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA auth TO anon;

INSERT INTO auth.schema_migrations (version) VALUES
    ('00'), ('20210710035447'), ('20210722035447'), ('20210730183235'),
    ('20210909172000'), ('20210927181326'), ('20211122151130'), ('20211124214934'),
    ('20211202183645'), ('20220114185221'), ('20220114185340'), ('20220224000811'),
    ('20220323170000'), ('20220429102000'), ('20220531120530'), ('20220614074123'),
    ('20220811173540'), ('20221003041449'), ('20221007042446'), ('20221020192200'),
    ('20221027105044'), ('20221114183602'), ('20221114183603'), ('20221215193445'),
    ('20230114183602'), ('20230114183603'), ('20230207200153'), ('20230216171608'),
    ('20230417165000'), ('20230526153447'), ('20230529173540'), ('20230710143444'),
    ('20230725155344'), ('20230815173540'), ('20230817143444'), ('20230914161444'),
    ('20231016084244'), ('20231020155344'), ('20231113183444'), ('20231116155344'),
    ('20231201155344'), ('20231208084244'), ('20240313155344'), ('20240417163444'),
    ('20240429155344'), ('20240604084244')
ON CONFLICT DO NOTHING;
`.trim();
            const tmpFile = `/tmp/auth-schema-init-${ref}.sql`;
            await Bun.write(tmpFile, initSql);
            await $`psql ${dbUrl} -f ${tmpFile}`.nothrow().quiet();
            await $`rm -f ${tmpFile}`.nothrow().quiet();
        }
    }

    public async startRuntime(ref: string): Promise<RuntimeStatus> {
        await this.ensureBinaries();
        await this.installSystemdTemplate();
        await this.ensureAuthSchema(ref);

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");

        await this.generateTenantConfig(ref, pgrstPort, gotruePort);

        // Start and enable systemd units
        await this.postgrestController.enable(ref);
        await this.postgrestController.start(ref);

        await $`systemctl enable supacloud-gotrue@${ref}`.nothrow().quiet();
        await $`systemctl start supacloud-gotrue@${ref}`.nothrow().quiet();

        // Wait for service health checks
        logger.info(`Waiting for PostgREST(${pgrstPort}) and GoTrue(${gotruePort}) health checks...`);
        let pgrstOk = false;
        let gotrueOk = false;

        for (let tryIdx = 0; tryIdx < 20; tryIdx++) {
            if (!pgrstOk) {
                const status = await this.postgrestController.observe(ref, pgrstPort);
                pgrstOk = status.health === "healthy";
            }

            if (!gotrueOk) {
                try {
                    const res = await fetch(`http://127.0.0.1:${gotruePort}/health`);
                    if (res.ok) gotrueOk = true;
                } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
            }

            if (pgrstOk && gotrueOk) {
                await this.setPostgrestDesiredState(ref, "running");
                await this.recordPostgrestObservation(ref, {
                    actual: "running",
                    health: "healthy",
                    port: pgrstPort,
                    last_error: null,
                });
                return { status: "running", port: pgrstPort, gotruePort, health: "healthy" };
            }
            await Bun.sleep(1000);
        }

        logger.warn("WARNING: Health check timeout, some services may still be starting");
        await this.setPostgrestDesiredState(ref, "running");
        await this.recordPostgrestObservation(ref, {
            actual: pgrstOk ? "running" : "starting",
            health: pgrstOk ? "healthy" : "unhealthy",
            port: pgrstPort,
            last_error: pgrstOk ? null : "PostgREST health check timeout during runtime start",
        });
        return { status: "starting", port: pgrstPort, gotruePort, health: "degraded" };
    }

    private async stopRuntimeUnits(ref: string): Promise<void> {
        await this.postgrestController.stopAndDisable(ref);

        await $`systemctl stop supacloud-gotrue@${ref}`.nothrow().quiet();
        await $`systemctl disable supacloud-gotrue@${ref}`.nothrow().quiet();
    }

    private async removeRuntimeConfig(ref: string): Promise<void> {
        const pgrstEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`));
        const pgrstConfFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.conf`));
        const gotrueEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`));

        if (await pgrstEnvFile.exists()) await fs.unlink(pgrstEnvFile.name!);
        if (await pgrstConfFile.exists()) await fs.unlink(pgrstConfFile.name!);
        if (await gotrueEnvFile.exists()) await fs.unlink(gotrueEnvFile.name!);
    }

    private getPostgrestDesiredState(project: { status?: unknown; postgrest_desired?: unknown }): RuntimeDesiredState {
        const desired = (project as Record<string, unknown>).postgrest_desired;
        if (desired === "running" || desired === "stopped") {
            return desired;
        }
        return String(project.status || "").toLowerCase() === "active" ? "running" : "stopped";
    }

    private async setPostgrestDesiredState(ref: string, desired: RuntimeDesiredState): Promise<void> {
        await metaSql`
          UPDATE projects
          SET postgrest_desired = ${desired},
              postgrest_updated_at = NOW(),
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async recordPostgrestObservation(
        ref: string,
        status: Pick<PostgrestRuntimeStatus, "actual" | "health" | "port" | "last_error">,
        opts: { reconciled?: boolean } = {},
    ): Promise<void> {
        await metaSql`
          UPDATE projects
          SET postgrest_actual = ${status.actual},
              postgrest_health = ${status.health},
              postgrest_port = ${status.port},
              postgrest_last_error = ${status.last_error},
              postgrest_updated_at = NOW(),
              postgrest_last_reconciled_at = CASE
                WHEN ${opts.reconciled === true} THEN NOW()
                ELSE postgrest_last_reconciled_at
              END,
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async recordPostgrestFailure(
        ref: string,
        error: unknown,
        opts: { reconciled?: boolean } = {},
    ): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await metaSql`
          UPDATE projects
          SET postgrest_actual = 'error',
              postgrest_health = 'unhealthy',
              postgrest_last_error = ${message},
              postgrest_updated_at = NOW(),
              postgrest_last_reconciled_at = CASE
                WHEN ${opts.reconciled === true} THEN NOW()
                ELSE postgrest_last_reconciled_at
              END,
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async readPostgrestRuntimeStatus(ref: string, opts: { persistObservation?: boolean } = {}): Promise<PostgrestRuntimeStatus> {
        const [project] = await metaSql`
          SELECT status,
                 postgrest_desired,
                 postgrest_actual,
                 postgrest_health,
                 postgrest_port,
                 postgrest_last_error,
                 postgrest_updated_at,
                 postgrest_last_reconciled_at,
                 updated_at
          FROM projects
          WHERE ref = ${ref} AND deleted_at IS NULL
          LIMIT 1
        `;

        const desired = this.getPostgrestDesiredState({
            status: project?.status,
            postgrest_desired: project?.postgrest_desired,
        });
        const port = await this.getTenantPort(ref, "pgrst");
        const observation = await this.postgrestController.observe(ref, port);
        const observedError = observation.last_error ??
            (typeof project?.postgrest_last_error === "string" ? project.postgrest_last_error : null);

        const status: PostgrestRuntimeStatus = {
            component: "postgrest",
            desired,
            actual: observation.actual,
            port,
            unit: this.postgrestController.unit(ref),
            health: observation.health,
            last_error: observedError,
            updated_at: project?.postgrest_updated_at
                ? new Date(project.postgrest_updated_at).toISOString()
                : (project?.updated_at ? new Date(project.updated_at).toISOString() : null),
            last_reconciled_at: project?.postgrest_last_reconciled_at
                ? new Date(project.postgrest_last_reconciled_at).toISOString()
                : null,
        };

        if (opts.persistObservation) {
            await this.recordPostgrestObservation(ref, status);
        }

        return status;
    }

    private async preparePostgrestRuntime(ref: string): Promise<void> {
        await this.ensurePostgrestBinary();
        await this.installSystemdTemplate();

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");
        await this.generateTenantConfig(ref, pgrstPort, gotruePort);
    }

    private async persistPostgrestObservation(
        ref: string,
        status: PostgrestRuntimeStatus,
        fallbackError: string | null,
    ): Promise<void> {
        await this.recordPostgrestObservation(ref, {
            actual: status.actual,
            health: status.health,
            port: status.port,
            last_error: status.health === "healthy" || status.actual === "stopped"
                ? null
                : status.last_error || fallbackError,
        });
    }

    private async persistPostgrestFailure(ref: string, error: unknown): Promise<void> {
        await this.recordPostgrestFailure(ref, error);
    }

    private async startPreparedPostgrest(ref: string, mode: "restart" | "repair"): Promise<PostgrestRuntimeStatus> {
        const port = await this.getTenantPort(ref, "pgrst");
        return this.postgrestController.startOrRepair(ref, port, mode);
    }

    private async transitionPostgrest(
        ref: string,
        opts: {
            desired: RuntimeDesiredState;
            mode?: "restart" | "repair";
            logVerb: "paused" | "resumed" | "restarted";
            fallbackError: string;
        },
    ): Promise<PostgrestRuntimeStatus> {
        await this.setPostgrestDesiredState(ref, opts.desired);

        try {
            const status = opts.desired === "stopped"
                ? await (async () => {
                    await this.postgrestController.stopAndDisable(ref);
                    return this.readPostgrestRuntimeStatus(ref);
                })()
                : await (async () => {
                    await this.preparePostgrestRuntime(ref);
                    return this.startPreparedPostgrest(ref, opts.mode || "repair");
                })();

            await this.persistPostgrestObservation(ref, status, opts.fallbackError);
            logger.info(`PostgREST ${opts.logVerb} for ${ref}`);
            return this.readPostgrestRuntimeStatus(ref);
        } catch (error: unknown) {
            await this.persistPostgrestFailure(ref, error);
            throw error;
        }
    }

    public async pauseProjectRuntime(ref: string): Promise<void> {
        await this.stopRuntimeUnits(ref);
        await this.setPostgrestDesiredState(ref, "stopped");
        await this.recordPostgrestObservation(ref, {
            actual: "stopped",
            health: "unknown",
            port: await this.getTenantPort(ref, "pgrst"),
            last_error: null,
        });
        logger.info(`Runtime paused for ${ref}`);
    }

    public async resumeProjectRuntime(ref: string): Promise<RuntimeStatus> {
        return this.startRuntime(ref);
    }

    public async stopRuntime(ref: string): Promise<void> {
        await this.stopRuntimeUnits(ref);
        await this.removeRuntimeConfig(ref);
        await this.setPostgrestDesiredState(ref, "stopped");
        await this.recordPostgrestObservation(ref, {
            actual: "stopped",
            health: "unknown",
            port: await this.getTenantPort(ref, "pgrst"),
            last_error: null,
        });

        logger.info(`Runtime stopped for ${ref}`);
    }

    public async pausePostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "stopped",
            logVerb: "paused",
            fallbackError: "PostgREST did not stop after pause request",
        });
    }

    public async resumePostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "running",
            mode: "repair",
            logVerb: "resumed",
            fallbackError: "PostgREST health check did not become healthy",
        });
    }

    public async restartPostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "running",
            mode: "restart",
            logVerb: "restarted",
            fallbackError: "PostgREST health check did not become healthy",
        });
    }

    public async statusPostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.readPostgrestRuntimeStatus(ref, { persistObservation: true });
    }

    private mapPostgrestServiceStatus(
        ref: string,
        runtime: PostgrestRuntimeStatus,
        opts: { id: string; name: string },
    ): ProjectServiceStatus {
        const serviceStatus =
            runtime.health === "healthy"
                ? "ACTIVE_HEALTHY"
                : runtime.actual === "stopped"
                    ? "INACTIVE"
                    : "UNHEALTHY";

        return {
            id: opts.id,
            name: opts.name,
            status: serviceStatus,
            healthy: serviceStatus === "ACTIVE_HEALTHY",
            service_host_ids: [`${ref}-${opts.id}`],
            component: "postgrest",
            desired_state: runtime.desired,
            actual_state: runtime.actual,
            health: runtime.health,
            port: runtime.port,
            unit: runtime.unit,
            last_error: runtime.last_error,
            updated_at: runtime.updated_at,
            last_reconciled_at: runtime.last_reconciled_at,
        };
    }

    private unhealthyService(ref: string, id: string, name: string): ProjectServiceStatus {
        return {
            id,
            name,
            status: "UNHEALTHY",
            healthy: false,
            service_host_ids: [`${ref}-${id}`],
        };
    }

    private async checkSystemService(unitName: string): Promise<string> {
        try {
            const result = await $`systemctl is-active ${unitName} 2>/dev/null`.nothrow().quiet();
            return result.exitCode === 0 ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch {
            return "INACTIVE";
        }
    }

    private systemServiceEntry(ref: string, id: string, name: string, status: string): ProjectServiceStatus {
        const normalized = status === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : "UNHEALTHY";
        return {
            id,
            name,
            status: normalized,
            healthy: normalized === "ACTIVE_HEALTHY",
            service_host_ids: [`${ref}-${id}`],
        };
    }

    public async getProjectServiceStatuses(
        ref: string,
        mode: "studio" | "detail" = "studio",
    ): Promise<ProjectServiceStatus[]> {
        const serviceDefs = mode === "studio"
            ? [
                { id: "db", name: "db", unit: "patroni" },
                { id: "auth", name: "auth", unit: `supacloud-gotrue@${ref}` },
                { id: "realtime", name: "realtime", unit: "supacloud-realtime" },
                { id: "storage", name: "storage", unit: `supacloud-storage@${ref}` },
            ]
            : [
                { id: "postgresql", name: "PostgreSQL", unit: "patroni" },
                { id: "gotrue", name: "GoTrue", unit: `supacloud-gotrue@${ref}` },
                { id: "realtime", name: "Realtime", unit: "supacloud-realtime" },
                { id: "storage", name: "Storage", unit: `supacloud-storage@${ref}` },
                { id: "kong", name: "Kong", unit: "kong" },
            ];

        const [postgrest, ...systemResults] = await Promise.allSettled([
            this.readPostgrestRuntimeStatus(ref),
            ...serviceDefs.map((service) => this.checkSystemService(service.unit)),
        ]);

        const restId = mode === "studio" ? "rest" : "postgrest";
        const restName = mode === "studio" ? "rest" : "PostgREST";
        const postgrestEntry = postgrest.status === "fulfilled"
            ? this.mapPostgrestServiceStatus(ref, postgrest.value, { id: restId, name: restName })
            : {
                ...this.unhealthyService(ref, restId, restName),
                component: "postgrest" as const,
            };

        const systemEntries = serviceDefs.map((service, idx) => {
            const result = systemResults[idx];
            const serviceStatus = result?.status === "fulfilled" ? result.value : "INACTIVE";
            return this.systemServiceEntry(ref, service.id, service.name, serviceStatus);
        });

        if (mode === "studio") {
            const [db, auth, realtime, storage] = systemEntries;
            return [db, postgrestEntry, auth, realtime, storage];
        }

        const [postgresql, gotrue, realtime, storage, kong] = systemEntries;
        return [postgresql, postgrestEntry, gotrue, realtime, storage, kong];
    }

    public async restartRuntime(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = await this.postgrestController.isActive(ref);
        const gotrueActive = (await $`systemctl is-active supacloud-gotrue@${ref}`.nothrow().quiet()).exitCode === 0;

        if (pgrstActive || gotrueActive) {
            await this.ensureBinaries();
            await this.installSystemdTemplate();

            const pgrstPort = await this.getTenantPort(ref, "pgrst");
            const gotruePort = await this.getTenantPort(ref, "gotrue");
            await this.generateTenantConfig(ref, pgrstPort, gotruePort);

            await this.postgrestController.restart(ref);
            await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();

            const postgrestStatus = await this.statusPostgrest(ref);
            await this.setPostgrestDesiredState(ref, "running");
            await this.recordPostgrestObservation(ref, {
                actual: postgrestStatus.actual,
                health: postgrestStatus.health,
                port: postgrestStatus.port,
                last_error: postgrestStatus.health === "healthy" ? null : "PostgREST health check did not become healthy after runtime restart",
            });
            return await this.checkStatus(ref);
        } else {
            return await this.startRuntime(ref);
        }
    }

    public async checkStatus(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = await this.postgrestController.isActive(ref);
        const gotrueActive = (await $`systemctl is-active supacloud-gotrue@${ref}`.nothrow().quiet()).exitCode === 0;

        const port = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");

        if (pgrstActive || gotrueActive) {
            let pgrstOk = false;
            let gotrueOk = false;

            const postgrestStatus = await this.postgrestController.observe(ref, port);
            pgrstOk = postgrestStatus.health === "healthy";

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

    public async reconcileInactiveRuntimes(): Promise<{ checked: number; stopped: number; started: number; updated: number; errors: number }> {
        const projects = await metaSql`
          SELECT ref, status, postgrest_desired
          FROM projects
          WHERE deleted_at IS NULL
        `;
        const projectByRef = new Map<string, Record<string, unknown>>(
            projects.map((project: Record<string, unknown>) => [
                String(project.ref),
                project,
            ]),
        );
        const projectStatus = new Map<string, string>(
            projects.map((project: Record<string, unknown>) => [
                String(project.ref),
                String(project.status || ""),
            ]),
        );

        const units = await $`systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --plain --no-pager`
            .nothrow()
            .quiet();
        const unitOutput = units.text();
        const serviceRegex = /supacloud-(?:gotrue|pgrst)@([^.]+)\.service/g;
        const refs = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = serviceRegex.exec(unitOutput)) !== null) {
            refs.add(match[1]);
        }
        for (const project of projects as Record<string, unknown>[]) {
            refs.add(String(project.ref));
        }

        let stopped = 0;
        let started = 0;
        let updated = 0;
        let errors = 0;
        for (const ref of refs) {
            const status = projectStatus.get(ref);
            const project = projectByRef.get(ref);

            try {
                if (!project) {
                    await this.stopRuntime(ref);
                    stopped++;
                    continue;
                }

                if (status !== "active" && status !== "creating") {
                    await this.pauseProjectRuntime(ref);
                    stopped++;
                    continue;
                }

                const desired = this.getPostgrestDesiredState(project);
                const actual = await this.statusPostgrest(ref);

                if (desired === "stopped" && actual.actual !== "stopped") {
                    await this.pausePostgrest(ref);
                    stopped++;
                    continue;
                }

                if (desired === "running" && status === "active" && actual.health !== "healthy") {
                    await this.resumePostgrest(ref);
                    started++;
                    continue;
                }

                await this.setPostgrestDesiredState(ref, desired);
                await this.recordPostgrestObservation(ref, {
                    actual: actual.actual,
                    health: actual.health,
                    port: actual.port,
                    last_error: actual.health === "healthy" ? null : actual.last_error,
                }, { reconciled: true });
                updated++;
            } catch (error: unknown) {
                errors++;
                if (status) {
                    await this.recordPostgrestFailure(ref, error, { reconciled: true }).catch(() => {});
                }
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[TenantRuntime] Failed to reconcile PostgREST runtime ${ref}`, {
                    status: status || "missing",
                    error: message,
                });
            }
        }

        return { checked: refs.size, stopped, started, updated, errors };
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

async function unitHasLegacyPostgrestMemoryLimit(unitPath: string): Promise<boolean> {
    const content = await Bun.file(unitPath).text();
    return content.includes("-M30m") || content.includes("MemoryMax=45M");
}
