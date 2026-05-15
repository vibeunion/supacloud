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

export interface RuntimeStatus {
    status: "running" | "stopped" | "starting" | "error";
    port: number;
    gotruePort: number;
    health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

class TenantRuntimeService {
    private readonly TENANT_CONFIG_DIR = config.tenantConfigDir;
    private readonly POSTGREST_BIN = config.postgrestBin;
    private readonly POSTGREST_RTS = config.postgrestRts;
    private readonly POSTGREST_MEMORY_MAX = config.postgrestMemoryMax;
    private readonly POSTGREST_CPU_WEIGHT = config.postgrestCpuWeight;
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
        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
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
            authConfig: (projectConfig.auth as Record<string, unknown>) || {}
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
`.trim();
        await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`), pgrstEnv);

        // Generate PostgREST .conf configuration (single source of truth for all settings)
        const pgrstConf = `
# PostgREST config for tenant: ${ref}
db-uri = "postgres://${resolveAuthenticatorName(ref)}:${creds.dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}"
db-schemas = "public, storage, graphql_public"
db-extra-search-path = "public, extensions, auth"
db-anon-role = "anon"
jwt-secret = "${creds.jwtSecret}"
server-port = ${pgrstPort}
server-host = "0.0.0.0"
db-pool = 10
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

        if (!pgrstExists || !gotrueExists) {
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

async function unitHasLegacyPostgrestMemoryLimit(unitPath: string): Promise<boolean> {
    const content = await Bun.file(unitPath).text();
    return content.includes("-M30m") || content.includes("MemoryMax=45M");
}
