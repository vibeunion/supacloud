import { sql, resolveDbName, resolveSlotName } from '../db';
import { databaseService } from '../services/database.service';
import { logger } from '../utils/logger';

const ALTER_TENANT_SQL = `
-- 1. auth.users adds
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 2. auth.sessions adds
-- Rename legacy columns to match current GoTrue binary schema
-- Older GoTrue versions used aal_level/ip_address; current binary expects aal/ip
-- sqlx StructScan fails on unrecognized columns, so we must rename them
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name = 'aal_level') THEN
    ALTER TABLE auth.sessions RENAME COLUMN aal_level TO aal;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name = 'ip_address') THEN
    ALTER TABLE auth.sessions RENAME COLUMN ip_address TO ip;
  END IF;
END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN tag VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN refreshed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN user_agent TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN ip TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN aal auth.aal_level; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.sessions ADD COLUMN not_after TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
-- Drop columns not recognized by current GoTrue binary (causes sqlx StructScan "missing destination name" errors)
DO $$ BEGIN ALTER TABLE auth.sessions DROP COLUMN IF EXISTS oauth_client_id; EXCEPTION WHEN OTHERS THEN NULL; END $$;

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

-- Add missing columns for current GoTrue version (CREATE TABLE IF NOT EXISTS skips if table exists)
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS phone TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS last_challenged_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS web_authn_credential JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS web_authn_aaguid UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

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

-- Add missing columns for current GoTrue version (CREATE TABLE IF NOT EXISTS skips if table exists)
DO $$ BEGIN ALTER TABLE auth.mfa_amr_claims ADD COLUMN IF NOT EXISTS id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.mfa_amr_claims ADD COLUMN IF NOT EXISTS factor_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

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

-- Add missing columns for current GoTrue version (CREATE TABLE IF NOT EXISTS skips if table exists)
DO $$ BEGIN ALTER TABLE auth.refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS email VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS phone VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_sso_user BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

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

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO anon, authenticated, service_role;

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

-- 10b. GraphQL Public Schema (required by PostgREST v12+ for GraphQL endpoint)
CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO postgres, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION graphql_public.graphql(
  "operationName" text DEFAULT null,
  query text DEFAULT null,
  variables jsonb DEFAULT null,
  extensions jsonb DEFAULT null
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT null::jsonb;
$$;
GRANT EXECUTE ON FUNCTION graphql_public.graphql(text, text, jsonb, jsonb) TO anon, authenticated, service_role;

-- 11. Native Bun Realtime LISTEN/NOTIFY Emulation Triggers (P0-16 enrichment)
-- This function emulates WAL-level postgres_changes by serializing full OLD/NEW records
CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes() RETURNS trigger AS $fn$
DECLARE
  payload jsonb;
  changed_columns text[];
  col text;
BEGIN
  -- Detect which columns changed (for UPDATE events only)
  IF TG_OP = 'UPDATE' THEN
    FOR col IN SELECT column_name FROM information_schema.columns 
      WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
    LOOP
      BEGIN
        EXECUTE format('SELECT ($1).%I IS DISTINCT FROM ($2).%I', col, col)
          INTO STRICT changed_columns[array_length(changed_columns, 1) + 1]
          USING NEW, OLD;
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

`;


async function main() {
  logger.info("[migrate-tenant-schema] Starting tenant migration process...");
  
  try {
    const projects = await sql`SELECT id, ref FROM projects WHERE deleted_at IS NULL AND COALESCE(status, '') <> 'deleted'`;
    logger.info(`[migrate-tenant-schema] Found ${projects.length} active projects to migrate.`);

    for (const project of projects) {
       const dbName = await resolveDbName(project.ref);
       const tenantDb = (databaseService as any).getTenantDb(dbName);
       try {
          await tenantDb.unsafe(ALTER_TENANT_SQL);
          const slotName = resolveSlotName(project.ref);
          try {
            const [wal2json] = await tenantDb`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'wal2json') AS available`;
            if (wal2json?.available) {
              const [slot] = await tenantDb`SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = ${slotName}) AS exists`;
              if (!slot?.exists) {
                await tenantDb`SELECT pg_create_logical_replication_slot(${slotName}, 'wal2json')`;
              }
            }
          } catch {}
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
