import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import { sql as metaSql, resolveDbName, resolveAuthenticatorName, resolvePgrstChannel } from "../db";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";
import { tenantOAuthService } from "./tenant-oauth.service";
import { resolveProjectApiUrl, resolveProjectAuthUrl, resolveProjectStudioUrl } from "../utils/project-routing";
import { normalizeOAuthServerConfig, normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectJwtJwks, normalizeProjectJwtKeys } from "../utils/project-jwt";
import { uniqueStrings } from "../utils/strings";
import { quoteSystemdEnvValue } from "../utils/systemd-env";
import { renderGoTrueEmailTemplateEnv } from "../utils/auth-email-templates";

function stringifyJsonConfig(value: unknown): string | null {
    if (!value) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
}

function pickPositivePort(value: unknown): number | null {
    const port = Number(value);
    if (!Number.isFinite(port) || port <= 0) return null;
    return Math.trunc(port);
}

const DEFAULT_POSTGREST_SCHEMAS = ["public", "storage", "graphql_public"] as const;

export function renderPostgrestDbSchemas(includePgmqPublic = false): string {
    const schemas: string[] = [...DEFAULT_POSTGREST_SCHEMAS];
    if (includePgmqPublic) schemas.push("pgmq_public");
    return schemas.join(", ");
}

function readBooleanSetting(
    authConfig: Record<string, unknown>,
    key: string,
    defaultValue: boolean,
): boolean {
    const value = authConfig[key];
    return typeof value === "boolean" ? value : defaultValue;
}

export function renderGoTrueAuthEnv(authConfig: Record<string, unknown>): string {
    const disableSignup = readBooleanSetting(authConfig, "disable_signup", false)
        || readBooleanSetting(authConfig, "enable_signup", true) === false;
    const externalAnonymousUsersEnabled = readBooleanSetting(authConfig, "external_anonymous_users_enabled", true);
    const externalEmailEnabled = readBooleanSetting(authConfig, "external_email_enabled", true);
    const externalPhoneEnabled = readBooleanSetting(authConfig, "external_phone_enabled", true);

    return [
`
GOTRUE_DISABLE_SIGNUP=${disableSignup ? "true" : "false"}
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=${externalAnonymousUsersEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_EMAIL_ENABLED=${externalEmailEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_PHONE_ENABLED=${externalPhoneEnabled ? "true" : "false"}
`.trim(),
        renderGoTrueEmailTemplateEnv(authConfig),
    ].filter(Boolean).join("\n");
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

export interface GotrueRuntimeStatus {
    component: "gotrue";
    desired: RuntimeDesiredState;
    actual: RuntimeStatus["status"];
    port: number;
    unit: string;
    health: "healthy" | "unhealthy" | "unknown";
    last_error: string | null;
    updated_at: string | null;
    last_reconciled_at: string | null;
}

class GotrueRuntimeController {
    unit(ref: string): string {
        return `supacloud-gotrue@${ref}`;
    }

    async isActive(ref: string): Promise<boolean> {
        return (await $`systemctl is-active ${this.unit(ref)}`.nothrow().quiet()).exitCode === 0;
    }

    async isFailed(ref: string): Promise<boolean> {
        return (await $`systemctl is-failed ${this.unit(ref)}`.nothrow().quiet()).exitCode === 0;
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

    async resetFailed(ref: string): Promise<void> {
        await $`systemctl reset-failed ${this.unit(ref)}`.nothrow().quiet();
    }

    async observe(ref: string, port: number): Promise<Pick<GotrueRuntimeStatus, "actual" | "health" | "last_error">> {
        if (!(await this.isActive(ref))) {
            return { actual: "stopped", health: "unknown", last_error: null };
        }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
                return { actual: "running", health: "healthy", last_error: null };
            }
            return {
                actual: "error",
                health: "unhealthy",
                last_error: `GoTrue health check failed with HTTP ${res.status}`,
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
    ): Promise<GotrueRuntimeStatus> {
        const active = await this.isActive(ref);
        const shouldRestart = active && (
            mode === "restart" ||
            (mode === "repair" && (await this.observe(ref, port)).health !== "healthy")
        );

        if (await this.isFailed(ref)) {
            await this.resetFailed(ref);
        }

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
    ): Promise<GotrueRuntimeStatus> {
        let status = await this.observe(ref, port);
        for (let tryIdx = 0; tryIdx < attempts && status.health !== "healthy"; tryIdx++) {
            await Bun.sleep(delayMs);
            status = await this.observe(ref, port);
        }
        return {
            component: "gotrue",
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

// Tenant schema migration SQL (sourced from migrate-tenant-schema.ts)
const ALTER_TENANT_SQL = `
-- 1. auth.users adds
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 2. auth.sessions adds
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN tag VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN refreshed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN user_agent TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN ip TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. storage.objects adds
DO $$ BEGIN ALTER TABLE storage.objects ADD COLUMN user_metadata JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE storage.objects ADD COLUMN version UUID NOT NULL DEFAULT gen_random_uuid(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 4. MFA schemas
DO $$ BEGIN CREATE TYPE auth.factor_type AS ENUM('totp', 'webauthn'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE auth.factor_status AS ENUM('unverified', 'verified'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE auth.aal_level AS ENUM('aal1', 'aal2', 'aal3'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.mfa_factors(
       id UUID NOT NULL,
       user_id UUID NOT NULL,
       friendly_name TEXT NULL,
       factor_type auth.factor_type NOT NULL,
       status auth.factor_status NOT NULL,
       created_at TIMESTAMPTZ NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL,
       secret TEXT NULL,
       CONSTRAINT mfa_factors_pkey PRIMARY KEY(id),
       CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_user_friendly_name_unique ON auth.mfa_factors (friendly_name, user_id) WHERE trim(friendly_name) <> '';
CREATE INDEX IF NOT EXISTS mfa_factors_user_id_idx ON auth.mfa_factors (user_id);

CREATE TABLE IF NOT EXISTS auth.mfa_challenges(
       id UUID NOT NULL,
       factor_id UUID NOT NULL,
       created_at TIMESTAMPTZ NOT NULL,
       verified_at TIMESTAMPTZ NULL,
       ip_address INET NOT NULL,
       CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id),
       CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.mfa_amr_claims(
    session_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    authentication_method TEXT NOT NULL,
    CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE(session_id, authentication_method),
    CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY(session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE
);

-- 5. SSO schemas
CREATE TABLE IF NOT EXISTS auth.sso_providers (
	id UUID NOT NULL,
	resource_id TEXT NULL,
	created_at TIMESTAMPTZ NULL,
	updated_at TIMESTAMPTZ NULL,
	PRIMARY KEY (id),
	CONSTRAINT "resource_id not empty" CHECK (resource_id IS NULL OR char_length(resource_id) > 0)
);

CREATE TABLE IF NOT EXISTS auth.sso_domains (
	id UUID NOT NULL,
	sso_provider_id UUID NOT NULL,
	domain TEXT NOT NULL,
	created_at TIMESTAMPTZ NULL,
	updated_at TIMESTAMPTZ NULL,
	PRIMARY KEY (id),
	FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers (id) ON DELETE CASCADE,
	CONSTRAINT "domain not empty" CHECK (char_length(domain) > 0)
);
CREATE INDEX IF NOT EXISTS sso_domains_sso_provider_id_idx ON auth.sso_domains (sso_provider_id);

CREATE TABLE IF NOT EXISTS auth.saml_providers (
	id UUID NOT NULL,
	sso_provider_id UUID NOT NULL,
	entity_id TEXT NOT NULL UNIQUE,
	metadata_xml TEXT NOT NULL,
	metadata_url TEXT NULL,
	attribute_mapping JSONB NULL,
	created_at TIMESTAMPTZ NULL,
	updated_at TIMESTAMPTZ NULL,
	PRIMARY KEY (id),
	FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers (id) ON DELETE CASCADE,
	CONSTRAINT "metadata_xml not empty" CHECK (char_length(metadata_xml) > 0),
	CONSTRAINT "metadata_url not empty" CHECK (metadata_url IS NULL OR char_length(metadata_url) > 0),
	CONSTRAINT "entity_id not empty" CHECK (char_length(entity_id) > 0)
);
CREATE INDEX IF NOT EXISTS saml_providers_sso_provider_id_idx ON auth.saml_providers (sso_provider_id);

CREATE TABLE IF NOT EXISTS auth.saml_relay_states (
	id UUID NOT NULL,
	sso_provider_id UUID NOT NULL,
	request_id TEXT NOT NULL,
	for_email TEXT NULL,
	redirect_to TEXT NULL,
	from_ip_address INET NULL,
	created_at TIMESTAMPTZ NULL,
	updated_at TIMESTAMPTZ NULL,
	PRIMARY KEY (id),
	FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers (id) ON DELETE CASCADE,
	CONSTRAINT "request_id not empty" CHECK(char_length(request_id) > 0)
);
CREATE INDEX IF NOT EXISTS saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states (sso_provider_id);

CREATE TABLE IF NOT EXISTS auth.sso_sessions (
	id UUID NOT NULL,
	session_id UUID NOT NULL,
	sso_provider_id UUID NULL,
	not_before TIMESTAMPTZ NULL,
	not_after TIMESTAMPTZ NULL,
	idp_initiated BOOLEAN DEFAULT false,
	created_at TIMESTAMPTZ NULL,
	updated_at TIMESTAMPTZ NULL,
	PRIMARY KEY (id),
	FOREIGN KEY (session_id) REFERENCES auth.sessions (id) ON DELETE CASCADE,
	FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers (id) ON DELETE CASCADE
);

-- 6. Flow state
DO $$ BEGIN
    CREATE TYPE auth.code_challenge_method AS ENUM('s256', 'plain');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.flow_state(
       id UUID PRIMARY KEY,
       user_id UUID NULL,
       auth_code TEXT NOT NULL,
       code_challenge_method auth.code_challenge_method NOT NULL,
       code_challenge TEXT NOT NULL,
       provider_type TEXT NOT NULL,
       provider_access_token TEXT NULL,
       provider_refresh_token TEXT NULL,
       created_at TIMESTAMPTZ NULL,
       updated_at TIMESTAMPTZ NULL,
       authentication_method TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_code ON auth.flow_state(auth_code);

-- 7. One Time Tokens
DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type auth.one_time_token_type NOT NULL,
    token_hash TEXT NOT NULL,
    relates_to TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CHECK (char_length(token_hash) > 0)
);


-- Post-CREATE TABLE column additions for existing tables with missing columns
-- These handle the case where CREATE TABLE IF NOT EXISTS skips because the table
-- already exists but with an older schema that lacks new columns.

-- auth.mfa_factors: add columns needed by GoTrue v2.x
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS phone TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS last_challenged_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS web_authn_credential JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS web_authn_aaguid UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- auth.mfa_amr_claims: add id and factor_id columns (old schema only had session_id + authentication_method composite PK)
DO $$
BEGIN
  ALTER TABLE auth.mfa_amr_claims ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
  UPDATE auth.mfa_amr_claims SET id = gen_random_uuid() WHERE id IS NULL;
  ALTER TABLE auth.mfa_amr_claims ALTER COLUMN id SET NOT NULL;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'auth.mfa_amr_claims'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE auth.mfa_amr_claims ADD CONSTRAINT mfa_amr_claims_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE auth.mfa_amr_claims ADD COLUMN IF NOT EXISTS factor_id UUID;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'auth.mfa_amr_claims'::regclass
      AND conname = 'mfa_amr_claims_factor_id_fkey'
  ) THEN
    ALTER TABLE auth.mfa_amr_claims
      ADD CONSTRAINT mfa_amr_claims_factor_id_fkey
      FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;
  END IF;
END $$;

-- auth.sessions: add aal and not_after columns (old schema had aal_level instead of aal)
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS aal VARCHAR(10); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS not_after TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- auth.one_time_tokens: add user_id column (old schema may lack this)
DO $$ BEGIN ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'auth.one_time_tokens'::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.one_time_tokens'::regclass AND attname = 'user_id')]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.users'::regclass AND attname = 'id')]
  ) THEN
    ALTER TABLE auth.one_time_tokens
      ADD CONSTRAINT one_time_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- auth.identities: add email and phone columns (old schema may lack these)
DO $$ BEGIN ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS email TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS phone TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- auth.users: add is_sso_user and deleted_at columns
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_sso_user BOOLEAN DEFAULT FALSE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- auth.refresh_tokens: add session_id column (newer GoTrue needs this)
DO $$ BEGIN ALTER TABLE auth.refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES auth.sessions(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

-- 8. Storage
CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads (
    id TEXT PRIMARY KEY,
    in_progress_size BIGINT NOT NULL DEFAULT 0,
    upload_signature TEXT NOT NULL,
    bucket_id TEXT NOT NULL REFERENCES storage.buckets(id),
    key TEXT COLLATE "C" NOT NULL,
    version TEXT NOT NULL,
    owner_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_metadata JSONB NULL
);

CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads_parts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     upload_id TEXT NOT NULL REFERENCES storage.s3_multipart_uploads(id) ON DELETE CASCADE,
     size BIGINT NOT NULL DEFAULT 0,
     part_number INT NOT NULL,
     bucket_id TEXT NOT NULL REFERENCES storage.buckets(id),
     key TEXT COLLATE "C" NOT NULL,
     etag TEXT NOT NULL,
     owner_id TEXT NULL,
     version TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_multipart_uploads_list ON storage.s3_multipart_uploads (bucket_id, (key COLLATE "C"), created_at ASC);
GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;

-- 9. Realtime
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
    id BIGSERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    extension TEXT NOT NULL,
    payload JSONB NULL,
    event TEXT NULL,
    private BOOLEAN NULL DEFAULT false,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    inserted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;

-- 10a. service_role must be able to administer existing application tables.
-- BYPASSRLS is not enough when PostgREST checks table privileges first.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO service_role;

-- 10. Functions Schema (Webhooks)
CREATE SCHEMA IF NOT EXISTS supabase_functions;
GRANT USAGE ON SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
    id BIGSERIAL PRIMARY KEY,
    hook_table_id INTEGER NOT NULL,
    hook_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    request_id BIGINT,
    is_rls_enabled BOOLEAN DEFAULT FALSE,
    hook_schema TEXT,
    hook_table TEXT,
    request_url TEXT,
    request_headers JSONB DEFAULT '{}',
    events TEXT[] DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS supabase_functions.migrations (
    version TEXT PRIMARY KEY,
    inserted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Native Bun Realtime LISTEN/NOTIFY Emulation Triggers (P0-16 enrichment)
-- This function emulates WAL-level postgres_changes by serializing full OLD/NEW records
CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes() RETURNS trigger AS $fn$
DECLARE
  payload jsonb;
  changed_columns text[] := '{}';
  col text;
  is_distinct boolean;
BEGIN
  -- Detect which columns changed (for UPDATE events only)
  IF TG_OP = 'UPDATE' THEN
    FOR col IN SELECT column_name FROM information_schema.columns 
      WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
    LOOP
      BEGIN
        EXECUTE format('SELECT ($1).%I IS DISTINCT FROM ($2).%I', col, col)
          INTO STRICT is_distinct
          USING NEW, OLD;
        IF is_distinct THEN
          changed_columns := array_append(changed_columns, col);
        END IF;
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END LOOP;
  END IF;

  payload = jsonb_build_object(
    'topic', 'realtime:' || TG_TABLE_SCHEMA,
    'event', 'postgres_changes',
    'payload', jsonb_build_object(
      'type', TG_OP,
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'commit_timestamp', now()::text,
      'record', CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN row_to_json(NEW)::jsonb ELSE null END,
      'old_record', CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN row_to_json(OLD)::jsonb ELSE null END,
      'columns', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('name', column_name, 'type', udt_name)), '[]'::jsonb)
        FROM (
          SELECT column_name, udt_name 
          FROM information_schema.columns 
          WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME 
          ORDER BY ordinal_position
        ) cols
      )
    )
  );
  PERFORM pg_notify('realtime_changes', payload::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-attach the trigger to ALL existing public tables
DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS realtime_notify_trigger ON public.%I; '
      'CREATE TRIGGER realtime_notify_trigger AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION realtime.notify_postgres_changes()',
      tbl.tablename, tbl.tablename
    );
  END LOOP;
END $$;

-- Ensure the tenant-facing background task table can be consumed through
-- Supabase-compatible postgres_changes channels.
CREATE OR REPLACE FUNCTION realtime.ensure_tasks_publication() RETURNS void AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF to_regclass('public.tasks') IS NOT NULL THEN
    ALTER TABLE public.tasks REPLICA IDENTITY FULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'tasks'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
    END IF;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN insufficient_privilege THEN NULL;
  WHEN undefined_table THEN NULL;
  WHEN OTHERS THEN NULL;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

SELECT realtime.ensure_tasks_publication();

-- Event Trigger: automatically attach realtime triggers to NEW tables created in public schema
CREATE OR REPLACE FUNCTION realtime.auto_attach_notify_trigger() RETURNS event_trigger AS $fn$
DECLARE
  obj RECORD;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() 
    WHERE object_type = 'table' AND schema_name = 'public'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER realtime_notify_trigger AFTER INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH ROW EXECUTE FUNCTION realtime.notify_postgres_changes()',
      obj.object_identity
    );
  END LOOP;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

-- Event Trigger: automatically publish public.tasks when applications create it later.
CREATE OR REPLACE FUNCTION realtime.auto_publish_tasks_table() RETURNS event_trigger AS $fn$
BEGIN
  PERFORM realtime.ensure_tasks_publication();
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

-- Register the event trigger (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'realtime_auto_attach_trigger') THEN
    CREATE EVENT TRIGGER realtime_auto_attach_trigger ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE')
      EXECUTE FUNCTION realtime.auto_attach_notify_trigger();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  -- Event triggers require superuser; skip if not available
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'realtime_auto_publish_tasks_trigger') THEN
    CREATE EVENT TRIGGER realtime_auto_publish_tasks_trigger ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE')
      EXECUTE FUNCTION realtime.auto_publish_tasks_table();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  -- Event triggers require superuser; skip if not available
  NULL;
END $$;

-- 12. PostgREST db-pre-request function (P0-11)
-- Sets RLS context variables from the JWT claims passed by PostgREST
CREATE OR REPLACE FUNCTION public.set_request_context() RETURNS void AS $$
DECLARE
  claims json;
  role_claim text;
BEGIN
  BEGIN
    claims := current_setting('request.jwt.claims', true)::json;
  EXCEPTION WHEN OTHERS THEN
    claims := '{}'::json;
  END;

  PERFORM set_config('request.jwt.claim.sub', coalesce(claims->>'sub', ''), true);
  PERFORM set_config('request.jwt.claim.role', coalesce(claims->>'role', 'anon'), true);
  PERFORM set_config('request.jwt.claim.email', coalesce(claims->>'email', ''), true);

  role_claim := coalesce(claims->>'role', 'anon');
  IF role_claim = 'service_role' THEN
    SET LOCAL ROLE service_role;
  ELSIF role_claim = 'authenticated' THEN
    SET LOCAL ROLE authenticated;
  ELSE
    SET LOCAL ROLE anon;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant execute to API roles
GRANT EXECUTE ON FUNCTION public.set_request_context() TO anon, authenticated, service_role;

-- 13. GoTrue internal tracking tables (P1-4, P2-5)
CREATE TABLE IF NOT EXISTS auth.schema_migrations (
  version varchar(255) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
  instance_id uuid,
  id uuid NOT NULL PRIMARY KEY,
  payload json,
  created_at timestamptz,
  ip_address varchar(64) NOT NULL DEFAULT '',
  action text
);
-- Ensure auth admin has access to these newly created tables
GRANT ALL ON TABLE auth.schema_migrations TO supabase_auth_admin;
GRANT ALL ON TABLE auth.audit_log_entries TO supabase_auth_admin;

-- 14. supabase_migrations schema (required by supabase CLI db push)
-- The CLI needs this table to track applied migrations
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
GRANT USAGE ON SCHEMA supabase_migrations TO postgres, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text NOT NULL PRIMARY KEY,
  statements text[],
  name text
);
GRANT ALL ON ALL TABLES IN SCHEMA supabase_migrations TO postgres;

-- Backfill from legacy schema_migrations table if it exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    SELECT version, version FROM public.schema_migrations
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- 15. seed.sql support schema for CLI
CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (
    path text NOT NULL PRIMARY KEY,
    hash text NOT NULL
);
GRANT ALL ON ALL TABLES IN SCHEMA supabase_migrations TO postgres;

-- 16. Realtime WAL logical replication support
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'wal2json') THEN
    CREATE EXTENSION IF NOT EXISTS wal2json;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Grant replication role to supabase_admin if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    ALTER ROLE supabase_admin WITH REPLICATION;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 18. Platform background task mirror table + User deletion fence
-- Mirror table stores platform background invocation state separately from
-- the business public.tasks table (which has incompatible columns/statuses).
CREATE TABLE IF NOT EXISTS public.background_task_mirrors (
  id               UUID PRIMARY KEY,
  project_ref      TEXT NOT NULL,
  task_type        TEXT NOT NULL DEFAULT 'edge_function',
  function_slug    TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','leased','running','retry_scheduled',
                                     'succeeded','failed','dead_lettered','cancelled')),
  invoker_user_id  UUID,
  attempt          INTEGER NOT NULL DEFAULT 1,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  trace_id         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.background_task_mirrors ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.background_task_mirrors
  TO postgres, supabase_auth_admin, supabase_admin;

CREATE INDEX IF NOT EXISTS idx_bg_task_mirrors_invoker_active
  ON public.background_task_mirrors(invoker_user_id, status)
  WHERE status IN ('pending','leased','running','retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_bg_task_mirrors_status
  ON public.background_task_mirrors(status);

-- 辅助函数：检查用户是否有未终态的 platform background tasks
-- Returns 'active' | 'inactive' | 'unknown' (three-state to avoid silent false on errors)
CREATE OR REPLACE FUNCTION public.has_active_background_tasks(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'background_task_mirrors'
  ) THEN
    RAISE NOTICE 'has_active_background_tasks: background_task_mirrors table missing for user %', p_user_id;
    RETURN 'unknown';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.background_task_mirrors
  WHERE invoker_user_id = p_user_id
    AND status IN ('pending','leased','running','retry_scheduled');

  IF v_count > 0 THEN
    RETURN 'active';
  END IF;

  RETURN 'inactive';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'has_active_background_tasks: exception for user % — %', p_user_id, SQLERRM;
  RETURN 'unknown';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 辅助函数：安全软删除用户（标记 deleted_at，但不硬删）
-- 在 GoTrue DELETE 触发之前，检查是否有活跃任务
CREATE OR REPLACE FUNCTION public.soft_delete_user_if_no_active_tasks()
RETURNS TRIGGER AS $$
DECLARE
  v_task_state TEXT;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  UPDATE auth.users SET deleted_at = NOW() WHERE id = OLD.id;

  v_task_state := public.has_active_background_tasks(OLD.id);

  IF v_task_state = 'active' THEN
    RETURN NULL;
  END IF;

  IF v_task_state = 'unknown' THEN
    RAISE NOTICE 'soft_delete_user_if_no_active_tasks: degraded/unknown for user %, blocking hard delete', OLD.id;
    RETURN NULL;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 仅在 auth.users 上无此触发器时创建
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'auth_users_delete_fence'
  ) THEN
    CREATE TRIGGER auth_users_delete_fence
      BEFORE DELETE ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.soft_delete_user_if_no_active_tasks();
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 辅助函数：清理已无活跃任务的软删用户（定期调用）
CREATE OR REPLACE FUNCTION public.hard_delete_soft_deleted_users()
RETURNS INT AS $$
DECLARE
  deleted_count INT := 0;
  user_record RECORD;
  v_task_state TEXT;
BEGIN
  FOR user_record IN
    SELECT id FROM auth.users
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '1 hour'
  LOOP
    v_task_state := public.has_active_background_tasks(user_record.id);
    IF v_task_state = 'inactive' THEN
      DELETE FROM auth.users WHERE id = user_record.id;
      deleted_count := deleted_count + 1;
    END IF;
  END LOOP;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

`;

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
    private readonly gotrueController = new GotrueRuntimeController();

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

    private deriveAuthUrl(ref: string, projectConfig: Record<string, unknown> | null | undefined): string {
        return resolveProjectAuthUrl(ref, projectConfig);
    }

    private async readPersistedTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number | null> {
        const [project] = await metaSql`
          SELECT config
          FROM projects
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        const projectConfig = normalizeProjectConfig(project?.config);
        const key = type === "pgrst" ? "postgrest_port" : "gotrue_port";
        return pickPositivePort(projectConfig[key]);
    }

    private async findTenantPortConflict(ref: string, type: "pgrst" | "gotrue", port: number): Promise<string | null> {
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true });
        const files = await fs.readdir(this.TENANT_CONFIG_DIR);

        for (const file of files) {
            let existingRef = "";
            let content = "";
            let matches = false;

            if (type === "gotrue" && file.endsWith("_gotrue.env")) {
                existingRef = file.replace(/_gotrue\.env$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = content.includes(`GOTRUE_API_PORT=${port}`);
            } else if (type === "pgrst" && file.endsWith(".conf")) {
                existingRef = file.replace(/\.conf$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = new RegExp(`(^|\\n)\\s*server-port\\s*=\\s*${port}\\s*(\\n|$)`).test(content);
            } else if (type === "pgrst" && file.endsWith(".env") && !file.endsWith("_gotrue.env")) {
                existingRef = file.replace(/\.env$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = content.includes(`PGRST_SERVER_PORT=${port}`);
            }

            if (existingRef && existingRef !== ref && matches) return existingRef;
        }

        return null;
    }

    private async persistTenantPortConfig(ref: string, pgrstPort: number, gotruePort: number): Promise<void> {
        const [project] = await metaSql`
          SELECT config
          FROM projects
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        if (!project) return;

        const current = normalizeProjectConfig(project.config);
        if (current.postgrest_port === pgrstPort && current.gotrue_port === gotruePort) return;

        const next = {
            ...current,
            postgrest_port: pgrstPort,
            gotrue_port: gotruePort,
        };
        await metaSql`
          UPDATE projects
          SET config=${JSON.stringify(next)}::jsonb, updated_at=NOW()
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        logger.info(`Persisted tenant runtime ports for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
    }

    /**
     * 优先使用已持久化端口，让网关路由和 systemd env 保持一致。
     * 端口缺失或已被其他租户占用时，再回退到 hash 分配。
     */
    private async getTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number> {
        const basePort = type === "pgrst" ? this.PGRST_PORT_BASE : this.GOTRUE_PORT_BASE;
        const persistedPort = await this.readPersistedTenantPort(ref, type);
        if (persistedPort) {
            const conflictingRef = await this.findTenantPortConflict(ref, type, persistedPort);
            if (!conflictingRef) return persistedPort;
            logger.warn(`[TenantRuntime] Ignoring persisted ${type} port ${persistedPort} for ${ref}; already used by ${conflictingRef}`);
        }

        // 使用 bun:hash 保持原有确定性分配逻辑。
        const hash = Bun.hash(ref);
        // BigInt modulo 避免大整数取模溢出。
        let port = basePort + Number(BigInt(hash) % BigInt(this.PORT_RANGE));

        // 继续沿用最多 100 次的线性探测碰撞处理。
        const maxTries = 100;
        for (let tryIdx = 0; tryIdx < maxTries; tryIdx++) {
            if (!(await this.findTenantPortConflict(ref, type, port))) return port;
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
        const oauthServerConfig = normalizeOAuthServerConfig(authConfig.oauth_server);
        const jwtKeys = stringifyJsonConfig(normalizeProjectJwtKeys(oauthServerConfig.jwt_keys));
        const jwtJwks = stringifyJsonConfig(normalizeProjectJwtJwks(oauthServerConfig.jwt_jwks));
        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
            jwtKeys,
            jwtJwks,
            dbName: await resolveDbName(ref),
            apiUrl: this.deriveApiUrl(ref, projectConfig),
            authUrl: this.deriveAuthUrl(ref, projectConfig),
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
     * PostgREST and GoTrue must be pre-installed; no container fallback.
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

    private async hasPgmqPublicSchema(ref: string, dbName: string, dbPassword: string): Promise<boolean> {
        const dbUrl = `postgres://${resolveAuthenticatorName(ref)}:${dbPassword}@${this.PG_HOST}:${this.PG_PORT}/${dbName}`;
        const query = "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmq_public') THEN 1 ELSE 0 END;";
        const result = await $`psql ${dbUrl} -Atqc ${query}`.nothrow().quiet();
        if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim();
            logger.warn(`[tenant-runtime] Failed to detect pgmq_public schema for ${ref}; falling back to base PostgREST schemas`, {
                error: stderr || `psql exited with code ${result.exitCode}`,
            });
            return false;
        }
        return result.stdout.toString().trim() === "1";
    }

    private async generateTenantConfig(ref: string, pgrstPort: number, gotruePort: number) {
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true });

        const creds = await this.getTenantCredentials(ref);
        const includePgmqPublic = await this.hasPgmqPublicSchema(ref, creds.dbName, creds.dbPassword);
        const dbSchemas = renderPostgrestDbSchemas(includePgmqPublic);

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
db-schemas = "${dbSchemas}"
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
        const hasDedicatedAuthUrl = Boolean(creds.authUrl && creds.authUrl !== creds.apiUrl);
        const apiExternalUrl = hasDedicatedAuthUrl ? creds.authUrl : creds.apiUrl;
        const siteExternalUrl = hasDedicatedAuthUrl ? creds.authUrl : creds.siteUrl;
        const siteHost = siteExternalUrl.replace('https://', '').replace('http://', '').split('/')[0].split(':')[0];
        const webAuthnOrigins = uniqueStrings([siteExternalUrl, creds.apiUrl, creds.siteUrl]
            .map((value) => this.toWebAuthnOrigin(value)));
        const redirectOrigins = uniqueStrings([
            creds.uriAllowList,
            creds.siteUrl,
            creds.apiUrl,
            creds.authUrl,
        ].flatMap((value) => String(value || "").split(",")));
        const gotrueSender = config.gotrueSmtpAdminEmail || `noreply@${apiExternalUrl.replace('https://', '').replace('http://', '')}`;

        let gotrueEnv = `
# SupaCloud Tenant GoTrue Runtime: ${ref}
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=${gotruePort}
API_EXTERNAL_URL=${apiExternalUrl}
GOTRUE_SITE_URL=${siteExternalUrl}
GOTRUE_URI_ALLOW_LIST=${redirectOrigins.join(",")}
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${creds.dbName}
GOTRUE_JWT_SECRET=${creds.jwtSecret}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_RELOADING_SIGNAL_ENABLED=true
GOTRUE_RELOADING_POLLER_ENABLED=true
GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true
${renderGoTrueAuthEnv(creds.authConfig)}
GOTRUE_WEBAUTHN_ENABLED=true
GOTRUE_WEBAUTHN_RP_ID=${siteHost}
GOTRUE_WEBAUTHN_RP_ORIGINS=${webAuthnOrigins.join(",")}
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

        const oauthServerConfig = normalizeOAuthServerConfig(creds.authConfig.oauth_server);
        if (oauthServerConfig.enabled === true) {
            const authorizationPath = typeof oauthServerConfig.authorization_path === "string"
                ? oauthServerConfig.authorization_path
                : "";
            gotrueEnv += `

# OAuth 2.1 / OIDC Provider Configuration
GOTRUE_OAUTH_SERVER_ENABLED=true
GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=${oauthServerConfig.allow_dynamic_registration === true ? "true" : "false"}
GOTRUE_JWT_ISSUER=${oauthServerConfig.issuer || `${apiExternalUrl}/auth/v1`}
${authorizationPath ? `GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH=${authorizationPath}\n` : ""}${creds.jwtKeys ? `GOTRUE_JWT_KEYS=${quoteSystemdEnvValue(creds.jwtKeys)}\nJWT_KEYS=${quoteSystemdEnvValue(creds.jwtKeys)}` : ""}
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
        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);
        const gotrueConfigDir = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);
        await fs.mkdir(gotrueConfigDir, { recursive: true });
        await Bun.write(path.join(gotrueConfigDir, "runtime.env"), gotrueEnv);
        // Keep the legacy flat env file for older units and diagnostics.
        await Bun.write(gotrueEnvPath, gotrueEnv);
        await this.persistTenantPortConfig(ref, pgrstPort, gotruePort);

        logger.info(`Config generated for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
    }

    private toWebAuthnOrigin(value: string | undefined | null): string | null {
        const raw = String(value || "").trim();
        if (!raw) return null;

        try {
            const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
            const hostname = parsed.hostname.toLowerCase();
            const protocol = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
                ? parsed.protocol
                : "https:";
            return `${protocol}//${parsed.host}`;
        } catch {
            return null;
        }
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
        const currentGotrueUnit = gotrueExists
            ? await Bun.file(gotrueUnitPath).text().catch(() => "")
            : "";
        const shouldWriteGotrueUnit = !gotrueExists
            || !currentGotrueUnit.includes("--config-dir")
            || !currentGotrueUnit.includes("ExecReload=/bin/kill -USR1 $MAINPID");
        if (shouldWriteGotrueUnit) {
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
ExecStart=${this.GOTRUE_BIN} --config-dir ${this.TENANT_CONFIG_DIR}/%i_gotrue.d
ExecReload=/bin/kill -USR1 $MAINPID
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

        if (shouldWritePgrstUnit || shouldWriteGotrueUnit) {
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

DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type auth.one_time_token_type NOT NULL,
    token_hash TEXT NOT NULL,
    relates_to TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CHECK (char_length(token_hash) > 0)
);
CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

DO $graphql_fallback$
BEGIN
  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NULL
     AND to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION graphql_public.graphql(
        "operationName" text DEFAULT NULL,
        query text DEFAULT NULL,
        variables jsonb DEFAULT NULL,
        extensions jsonb DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      STABLE
      AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql') THEN
          RETURN jsonb_build_object(
            'errors', jsonb_build_array(
              jsonb_build_object(
                'message', 'pg_graphql is installed but the graphql function was not properly created. Re-run: CREATE EXTENSION pg_graphql CASCADE;'
              )
            )
          );
        END IF;

        RETURN jsonb_build_object(
          'errors', jsonb_build_array(
            jsonb_build_object(
              'message', 'GraphQL is not available on this project. The pg_graphql PostgreSQL extension is not installed on the host cluster.'
            )
          )
        );
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO anon, authenticated, service_role';
  ELSIF to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO anon, authenticated, service_role';
  END IF;
END;
$graphql_fallback$;

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

    private async ensureOneTimeTokensAndGraphQL(ref: string): Promise<void> {
        const dbName = await resolveDbName(ref);
        const dbUrl = `postgres://postgres:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${dbName}`;

        const migrationSql = `
DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type auth.one_time_token_type NOT NULL,
    token_hash TEXT NOT NULL,
    relates_to TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CHECK (char_length(token_hash) > 0)
);

DO $$ BEGIN ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

UPDATE auth.one_time_tokens t
SET user_id = u.id
FROM auth.users u
WHERE t.user_id IS NULL
  AND u.email = t.relates_to;

DELETE FROM auth.one_time_tokens WHERE user_id IS NULL;

DO $$ BEGIN
  ALTER TABLE auth.one_time_tokens ALTER COLUMN user_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'auth.one_time_tokens'::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.one_time_tokens'::regclass AND attname = 'user_id')]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.users'::regclass AND attname = 'id')]
  ) THEN
    ALTER TABLE auth.one_time_tokens
      ADD CONSTRAINT one_time_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

DO $graphql_fallback$
BEGIN
  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NULL
     AND to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION graphql_public.graphql(
        "operationName" text DEFAULT NULL,
        query text DEFAULT NULL,
        variables jsonb DEFAULT NULL,
        extensions jsonb DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      STABLE
      AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql') THEN
          RETURN jsonb_build_object(
            'errors', jsonb_build_array(
              jsonb_build_object(
                'message', 'pg_graphql is installed but the graphql function was not properly created. Re-run: CREATE EXTENSION pg_graphql CASCADE;'
              )
            )
          );
        END IF;

        RETURN jsonb_build_object(
          'errors', jsonb_build_array(
            jsonb_build_object(
              'message', 'GraphQL is not available on this project. The pg_graphql PostgreSQL extension is not installed on the host cluster.'
            )
          )
        );
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO anon, authenticated, service_role';
  ELSIF to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO anon, authenticated, service_role';
  END IF;
END;
$graphql_fallback$;

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE SCHEMA IF NOT EXISTS pgmq_public;
GRANT USAGE ON SCHEMA pgmq_public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.send(queue_name, message, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.send_batch(queue_name, messages, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.read(queue_name, sleep_seconds, n); $$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.pop(queue_name); $$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT pgmq.archive(queue_name, message_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT pgmq.delete(queue_name, message_id); $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role;
`.trim();
        const tmpFile = `/tmp/ott-graphql-migration-${ref}.sql`;
        try {
            await Bun.write(tmpFile, migrationSql);
            const result = await $`psql ${dbUrl} -v ON_ERROR_STOP=1 -f ${tmpFile}`.nothrow();
            if (result.exitCode !== 0) {
                const stderr = result.stderr.toString().trim();
                const stdout = result.stdout.toString().trim();
                const detail = stderr || stdout || "psql exited without output";
                throw new Error(`psql exited with code ${result.exitCode}: ${detail}`);
            }
            logger.info(`[tenant-runtime] Ensured one_time_tokens + graphql_public.graphql() for ${ref}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[tenant-runtime] one_time_tokens/graphql migration error for ${ref}: ${msg}`);
            throw error;
        } finally {
            try { await $`rm -f ${tmpFile}`.nothrow().quiet(); } catch {}
        }
    }

    private async ensurePostgrestPrerequest(ref: string): Promise<void> {
        const dbName = await resolveDbName(ref);
        const dbUrl = `postgres://postgres:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${dbName}`;

        const fnSql = `
CREATE OR REPLACE FUNCTION public.set_request_context() RETURNS void AS $$
DECLARE
  role_claim text;
BEGIN
  IF current_setting('request.jwt.claims', true) = '' THEN
    PERFORM set_config('request.jwt.claims', '{}', true);
  END IF;
  role_claim := COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
  PERFORM set_config('request.jwt.claim.role', role_claim, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`.trim();
        const tmpFile = `/tmp/pgrst-prerequest-${ref}.sql`;
        await Bun.write(tmpFile, fnSql);
        await $`psql ${dbUrl} -f ${tmpFile}`.nothrow().quiet();
        await $`rm -f ${tmpFile}`.nothrow().quiet();
        logger.info(`[tenant-runtime] Ensured public.set_request_context() for ${ref}`);
    }

    public async startRuntime(ref: string): Promise<RuntimeStatus> {
        await this.ensureBinaries();
        await this.installSystemdTemplate();
        await this.ensureAuthSchema(ref);
        await this.ensureOneTimeTokensAndGraphQL(ref);
        await this.ensureTenantSchemaMigrations(ref);
        await this.ensurePostgrestPrerequest(ref);

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");

        await this.generateTenantConfig(ref, pgrstPort, gotruePort);

        // Start and enable systemd units
        await this.postgrestController.enable(ref);
        await this.postgrestController.start(ref);

        await this.gotrueController.enable(ref);
        await this.gotrueController.start(ref);

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

        await this.gotrueController.stopAndDisable(ref);

    }

    private async removeRuntimeConfig(ref: string): Promise<void> {
        const pgrstEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`));
        const pgrstConfFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.conf`));
        const gotrueEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`));
        const gotrueConfigDir = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);

        if (await pgrstEnvFile.exists()) await fs.unlink(pgrstEnvFile.name!);
        if (await pgrstConfFile.exists()) await fs.unlink(pgrstConfFile.name!);
        if (await gotrueEnvFile.exists()) await fs.unlink(gotrueEnvFile.name!);
        await fs.rm(gotrueConfigDir, { recursive: true, force: true });
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


    private async ensureTenantSchemaMigrations(ref: string): Promise<void> {
        const dbName = await resolveDbName(ref);
        const dbUrl = `postgres://postgres:${config.pgPassword}@${this.PG_HOST}:${this.PG_PORT}/${dbName}`;
        const tmpFile = `/tmp/tenant-schema-migration-${ref}.sql`;

        try {
            await Bun.write(tmpFile, ALTER_TENANT_SQL);
            const result = await $`psql ${dbUrl} -v ON_ERROR_STOP=1 -f ${tmpFile}`.nothrow();
            if (result.exitCode !== 0) {
                const stderr = result.stderr.toString().trim();
                const stdout = result.stdout.toString().trim();
                const detail = stderr || stdout || "psql exited without output";
                throw new Error(`psql exited with code ${result.exitCode}: ${detail}`);
            }
            logger.info(`[tenant-runtime] Ensured tenant schema migrations for ${ref}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[tenant-runtime] Tenant schema migration error for ${ref}: ${msg}`);
            throw error;
        } finally {
            try { await $`rm -f ${tmpFile}`.nothrow().quiet(); } catch {}
        }
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
                : runtime.actual === "starting"
                    ? "COMING_UP"
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

    /** Check DB health: try systemd first, then SQL probe as fallback */
    private async checkDbHealth(ref: string): Promise<string> {
        const systemdResult = await this.checkSystemService("patroni");
        if (systemdResult === "ACTIVE_HEALTHY") return "ACTIVE_HEALTHY";
        // Fallback: try a lightweight SQL query on the meta database
        try {
            await metaSql`SELECT 1`;
            return "ACTIVE_HEALTHY";
        } catch {
            return "INACTIVE";
        }
    }

    /** Check storage health: try systemd first, then S3 endpoint as fallback */
    private async checkStorageHealth(): Promise<string> {
        const systemdResult = await this.checkSystemService("supacloud-storage");
        if (systemdResult === "ACTIVE_HEALTHY") return "ACTIVE_HEALTHY";
        // Fallback: probe the S3 health endpoint (accept any response, not just 2xx)
        try {
            const res = await fetch(`${config.s3Endpoint}/minio/health/live`, {
                signal: AbortSignal.timeout(3000),
            });
            // Any response (even 4xx) means the storage service is reachable
            return "ACTIVE_HEALTHY";
        } catch { /* ignore */ }
        // Final fallback: for juicefs mode, check the mount directory
        if (config.storageType === "juicefs") {
            try {
                const result = await $`test -d /var/lib/juicefs`.nothrow().quiet();
                if (result.exitCode === 0) return "ACTIVE_HEALTHY";
            } catch { /* ignore */ }
        }
        return "INACTIVE";
    }

    private systemServiceEntry(ref: string, id: string, name: string, status: string): ProjectServiceStatus {
        const normalized = status === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : status === "COMING_UP" ? "COMING_UP" : "UNHEALTHY";
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
                { id: "storage", name: "storage", unit: "supacloud-storage" },
            ]
            : [
                { id: "postgresql", name: "PostgreSQL", unit: "patroni" },
                { id: "gotrue", name: "GoTrue", unit: `supacloud-gotrue@${ref}` },
                { id: "realtime", name: "Realtime", unit: "supacloud-realtime" },
                { id: "storage", name: "Storage", unit: "supacloud-storage" },
                {
                    id: "caddy",
                    name: "Caddy",
                    unit: "supacloud-caddy",
                },
            ];

        const [postgrest, dbHealth, storageHealth, ...otherSystemResults] = await Promise.allSettled([
            this.readPostgrestRuntimeStatus(ref),
            this.checkDbHealth(ref),
            this.checkStorageHealth(),
            ...serviceDefs.filter(s => s.id !== "db" && s.id !== "storage" && s.id !== "postgresql")
                .map((service) => this.checkSystemService(service.unit)),
        ]);

        const restId = mode === "studio" ? "rest" : "postgrest";
        const restName = mode === "studio" ? "rest" : "PostgREST";
        const postgrestEntry = postgrest.status === "fulfilled"
            ? this.mapPostgrestServiceStatus(ref, postgrest.value, { id: restId, name: restName })
            : {
                ...this.unhealthyService(ref, restId, restName),
                component: "postgrest" as const,
            };

        const dbStatus = dbHealth.status === "fulfilled" ? dbHealth.value : "INACTIVE";
        const storageStatus = storageHealth.status === "fulfilled" ? storageHealth.value : "INACTIVE";
        const otherEntries = serviceDefs
            .filter(s => s.id !== "db" && s.id !== "storage" && s.id !== "postgresql")
            .map((service, idx) => {
                const result = otherSystemResults[idx];
                const serviceStatus = result?.status === "fulfilled" ? result.value : "INACTIVE";
                return this.systemServiceEntry(ref, service.id, service.name, serviceStatus);
            });

        if (mode === "studio") {
            const db = this.systemServiceEntry(ref, "db", "db", dbStatus);
            const storage = this.systemServiceEntry(ref, "storage", "storage", storageStatus);
            const [auth, realtime] = otherEntries;
            return [db, postgrestEntry, auth, realtime, storage];
        }

        const postgresql = this.systemServiceEntry(ref, "postgresql", "PostgreSQL", dbStatus);
        const storage = this.systemServiceEntry(ref, "storage", "Storage", storageStatus);
        const [gotrue, realtime, gateway] = otherEntries;
        return [postgresql, postgrestEntry, gotrue, realtime, storage, gateway];
    }

    public async restartRuntime(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = await this.postgrestController.isActive(ref);
        const gotrueActive = await this.gotrueController.isActive(ref);

        if (pgrstActive || gotrueActive) {
            await this.ensureBinaries();
            await this.installSystemdTemplate();

            const pgrstPort = await this.getTenantPort(ref, "pgrst");
            const gotruePort = await this.getTenantPort(ref, "gotrue");
            await this.generateTenantConfig(ref, pgrstPort, gotruePort);

            await this.postgrestController.restart(ref);
            await this.gotrueController.restart(ref);

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
        const gotrueActive = await this.gotrueController.isActive(ref);

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
                    // Also pause GoTrue for inactive projects
                    await this.pauseGoTrueRuntime(ref);
                    stopped++;
                    continue;
                }

                const desired = this.getPostgrestDesiredState(project);
                const actual = await this.statusPostgrest(ref);

                // --- PostgREST reconcile ---
                if (desired === "stopped" && actual.actual !== "stopped") {
                    await this.pausePostgrest(ref);
                    stopped++;
                    continue;
                }

                if (desired === "running" && status === "active" && actual.health !== "healthy") {
                    await this.resumePostgrest(ref);
                    started++;
                }

                // --- GoTrue reconcile ---
                const gotrueActive = await this.gotrueController.isActive(ref);
                const gotruePort = await this.getTenantPort(ref, "gotrue");
                const gotrueObserved = await this.gotrueController.observe(ref, gotruePort);

                if (desired === "running" && status === "active") {
                    // Active project: ensure GoTrue is running and healthy
                    if (!gotrueActive || gotrueObserved.health !== "healthy") {
                        // Ensure config exists before starting
                        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);
                        if (!(await Bun.file(gotrueEnvPath).exists())) {
                            const pgrstPort = await this.getTenantPort(ref, "pgrst");
                            await this.generateTenantConfig(ref, pgrstPort, gotruePort);
                        }
                        // Ensure systemd template is installed
                        await this.installSystemdTemplate();
                        await this.gotrueController.startOrRepair(ref, gotruePort, "repair");
                        logger.info(`[TenantRuntime] GoTrue reconciled and started for ${ref}`);
                        started++;
                    }
                } else if (desired === "stopped") {
                    // Stopped project: ensure GoTrue is stopped
                    if (gotrueActive) {
                        await this.pauseGoTrueRuntime(ref);
                        stopped++;
                    }
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
                logger.warn(`[TenantRuntime] Failed to reconcile runtime ${ref}`, {
                    status: status || "missing",
                    error: message,
                });
            }
        }

        return { checked: refs.size, stopped, started, updated, errors };
    }

    private async pauseGoTrueRuntime(ref: string): Promise<void> {
        await this.gotrueController.stopAndDisable(ref);
        logger.info(`[TenantRuntime] GoTrue paused for ${ref}`);
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
