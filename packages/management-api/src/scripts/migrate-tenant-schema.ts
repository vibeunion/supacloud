import { sql } from '../db';
import { databaseService } from '../services/database.service';
import { logger } from '../utils/logger';

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

-- 10. Functions Schema (Webhooks)
CREATE SCHEMA IF NOT EXISTS supabase_functions;
GRANT USAGE ON SCHEMA supabase_functions TO postgres, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
    id BIGSERIAL PRIMARY KEY,
    hook_table_id INTEGER NOT NULL,
    hook_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    request_id BIGINT,
    is_rls_enabled BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS supabase_functions.migrations (
    version TEXT PRIMARY KEY,
    inserted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Native Bun Realtime LISTEN/NOTIFY Emulation Triggers
CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes() RETURNS trigger AS $
DECLARE
  payload jsonb;
BEGIN
  payload = jsonb_build_object(
    'topic', 'realtime:public',
    'event', 'postgres_changes',
    'payload', jsonb_build_object(
      'type', TG_OP,
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'record', row_to_json(NEW),
      'old_record', row_to_json(OLD)
    )
  );
  PERFORM pg_notify('realtime_changes', payload::text);
  RETURN NEW;
END;
$ LANGUAGE plpgsql;

-- Apply notify trigger to common public tables automatically (Example: only to public.profiles if exists)
-- An advanced Implementation would use an Event Trigger on ddl_command_end to attach it to all tables.
-- For SupaCloud native Edge WAL, we just create the function so users can manually attach it or we build a UI!
`;

async function main() {
  logger.info("[migrate-tenant-schema] Starting tenant migration process...");
  
  try {
    const projects = await sql`SELECT id, ref FROM projects WHERE is_deleted = false`;
    logger.info(`[migrate-tenant-schema] Found ${projects.length} active projects to migrate.`);

    for (const project of projects) {
       const dbName = `supa_${project.ref}`;
       const tenantDb = (databaseService as any).getTenantDb(dbName);
       try {
          await tenantDb.unsafe(ALTER_TENANT_SQL);
          logger.info(`[migrate-tenant-schema] Successfully migrated tenant ${project.ref}`);
       } catch (err: unknown) {
          logger.error(`[migrate-tenant-schema] Failed to migrate tenant ${project.ref}`, { error: err instanceof Error ? err.message : String(err) });
       }
    }
    logger.info("[migrate-tenant-schema] Done!");
  } catch (err: unknown) {
    logger.error("[migrate-tenant-schema] Fatal error:", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    process.exit(0);
  }
}

main();
