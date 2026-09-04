-- ============================================================
-- Supabase Core Schema Initialization
-- Based on supabase/postgres official migrations
-- ============================================================

-- 1. Create Supabase Dedicated Roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        CREATE ROLE supabase_admin LOGIN NOINHERIT BYPASSRLS REPLICATION;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
        CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
    END IF;
END
$$;

-- Ensure existing clusters also grant replication to supabase_admin
ALTER ROLE supabase_admin WITH REPLICATION;

-- Grant roles to postgres/authenticator
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;
GRANT supabase_admin TO postgres;

-- Set supabase_auth_admin default search_path (required by GoTrue)
ALTER ROLE supabase_auth_admin SET search_path TO auth, public;

-- 2. Auth Schema
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- GoTrue internal tracking tables (P0-6, P1-4)
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
GRANT ALL ON TABLE auth.schema_migrations TO supabase_auth_admin;
GRANT ALL ON TABLE auth.audit_log_entries TO supabase_auth_admin;

CREATE TABLE IF NOT EXISTS auth.users (
    instance_id UUID,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aud VARCHAR(255),
    role VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    encrypted_password VARCHAR(255),
    email_confirmed_at TIMESTAMPTZ,
    invited_at TIMESTAMPTZ,
    confirmation_token VARCHAR(255) NOT NULL DEFAULT '',
    confirmation_sent_at TIMESTAMPTZ,
    recovery_token VARCHAR(255) NOT NULL DEFAULT '',
    recovery_sent_at TIMESTAMPTZ,
    email_change_token_new VARCHAR(255) NOT NULL DEFAULT '',
    email_change VARCHAR(255) NOT NULL DEFAULT '',
    email_change_sent_at TIMESTAMPTZ,
    last_sign_in_at TIMESTAMPTZ,
    raw_app_meta_data JSONB,
    raw_user_meta_data JSONB,
    is_super_admin BOOLEAN,
    phone VARCHAR(15) UNIQUE DEFAULT NULL,
    phone_confirmed_at TIMESTAMPTZ,
    phone_change VARCHAR(15) NOT NULL DEFAULT '',
    phone_change_token VARCHAR(255) NOT NULL DEFAULT '',
    phone_change_sent_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current VARCHAR(255) NOT NULL DEFAULT '',
    email_change_confirm_status SMALLINT DEFAULT 0,
    banned_until TIMESTAMPTZ,
    reauthentication_token VARCHAR(255) NOT NULL DEFAULT '',
    reauthentication_sent_at TIMESTAMPTZ,
    is_sso_user BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    is_anonymous BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users (instance_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON auth.users (email);

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id UUID,
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(255),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    parent VARCHAR(255),
    session_id UUID
);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON auth.refresh_tokens (token);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON auth.refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    factor_id UUID,
    aal VARCHAR(10),
    not_after TIMESTAMPTZ,
    refreshed_at TIMESTAMPTZ,
    user_agent TEXT,
    ip TEXT,
    tag VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE IF NOT EXISTS auth.identities (
    id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data JSONB NOT NULL,
    provider TEXT NOT NULL,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT GENERATED ALWAYS AS (lower(identity_data->>'email')) STORED,
    CONSTRAINT identities_pkey PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);
CREATE INDEX IF NOT EXISTS identities_email_idx ON auth.identities (email);

-- MFA Definitions
DO $$ BEGIN
    CREATE TYPE auth.factor_type AS ENUM('totp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE auth.factor_status AS ENUM('unverified', 'verified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE auth.aal_level AS ENUM('aal1', 'aal2', 'aal3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

-- SSO Definitions
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

-- Historical WebAuthn artifacts, when present, are left untouched but are not
-- created or consumed by the GoTrue-only TOTP runtime.

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

-- Flow State Definition
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

-- One Time Tokens Definition
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

-- Grants
GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO service_role;

-- supacloud:sql-module:auth-jwt-helpers:start
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
BEGIN
  RETURN COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$ LANGUAGE SQL STABLE;
-- supacloud:sql-module:auth-jwt-helpers:end

-- 3. Storage Schema
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    public BOOLEAN DEFAULT false,
    avif_autodetection BOOLEAN DEFAULT false,
    file_size_limit BIGINT,
    allowed_mime_types TEXT[],
    owner_id TEXT
);

CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id TEXT REFERENCES storage.buckets(id),
    name TEXT,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB,
    path_tokens TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
    version TEXT DEFAULT gen_random_uuid(),
    owner_id TEXT,
    user_metadata JSONB
);
CREATE INDEX IF NOT EXISTS objects_bucket_id_idx ON storage.objects (bucket_id);
CREATE UNIQUE INDEX IF NOT EXISTS objects_bucket_name_idx ON storage.objects (bucket_id, name);
CREATE INDEX IF NOT EXISTS btree_path_tokens ON storage.objects USING GIN (path_tokens);

-- supacloud:sql-module:storage-path-helpers:start
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[1:array_length(arr, 1)-1] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[array_length(arr, 1)] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  ),
  filename AS (
    SELECT arr[array_length(arr, 1)] AS f FROM parts
  )
  SELECT substring(f FROM '\.([^\.]*)$') FROM filename;
$$ LANGUAGE SQL STABLE;
-- supacloud:sql-module:storage-path-helpers:end

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

-- Grants
GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
-- service_role has BYPASSRLS and needs full DML for runtime uploads/deletes
GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO service_role;
-- authenticated needs DML grants but is constrained by RLS policies
GRANT ALL ON ALL TABLES IN SCHEMA storage TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO authenticated;
-- anon only needs SELECT; writes are gated by RLS which has no anon INSERT/UPDATE/DELETE policies
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA storage TO anon;

-- Enable RLS
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;

-- ── storage.buckets policies ──
CREATE POLICY "Public buckets are viewable by everyone." ON storage.buckets FOR SELECT USING (true);
CREATE POLICY "Authenticated users can view all buckets." ON storage.buckets FOR SELECT TO authenticated USING (true);

-- ── storage.objects policies ──
-- Public objects: anyone can SELECT from public buckets
CREATE POLICY "Allow public read on storage.objects" ON storage.objects
    FOR SELECT USING (bucket_id IN (SELECT id FROM storage.buckets WHERE public = true));
-- Authenticated users can SELECT their own objects in private buckets
CREATE POLICY "Allow authenticated read on storage.objects" ON storage.objects
    FOR SELECT TO authenticated USING (auth.uid() = owner);
-- Authenticated users can INSERT objects they own
CREATE POLICY "Allow authenticated insert on storage.objects" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (bucket_id IN (SELECT id FROM storage.buckets) AND auth.uid() = owner);
-- Authenticated users can UPDATE objects they own
CREATE POLICY "Allow authenticated update on storage.objects" ON storage.objects
    FOR UPDATE TO authenticated USING (auth.uid() = owner) WITH CHECK (auth.uid() = owner);
-- Authenticated users can DELETE objects they own
CREATE POLICY "Allow authenticated delete on storage.objects" ON storage.objects
    FOR DELETE TO authenticated USING (auth.uid() = owner);

-- ── storage.s3_multipart_uploads policies ──
CREATE POLICY "Allow authenticated multipart uploads" ON storage.s3_multipart_uploads
    FOR ALL TO authenticated USING (owner_id = auth.uid()::text) WITH CHECK (owner_id = auth.uid()::text);

-- ── storage.s3_multipart_uploads_parts policies ──
CREATE POLICY "Allow authenticated multipart upload parts" ON storage.s3_multipart_uploads_parts
    FOR ALL TO authenticated USING (owner_id = auth.uid()::text) WITH CHECK (owner_id = auth.uid()::text);

-- 4. Realtime Schema
CREATE SCHEMA IF NOT EXISTS realtime;
ALTER SCHEMA realtime OWNER TO supabase_admin;
GRANT USAGE, CREATE ON SCHEMA realtime TO supabase_admin, supabase_realtime_admin;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;

-- Official Realtime migrations own the schema's tables, types, and protocol functions.
-- SupaCloud only installs its LISTEN/NOTIFY and task-publication helpers here.

-- supacloud:sql-module:realtime-notify-payload:start
CREATE OR REPLACE FUNCTION realtime.notify_change_payload(payload jsonb)
RETURNS void AS $fn$
DECLARE
  payload_text text := payload::text;
BEGIN
  IF pg_catalog.octet_length(payload_text) >= 8000 THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM pg_catalog.pg_notify('realtime_changes', payload_text);
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN;
  END;
END;
$fn$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog;
-- supacloud:sql-module:realtime-notify-payload:end

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
        ALTER PUBLICATION supabase_realtime OWNER TO supabase_admin;
    END IF;
END
$$;

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

CREATE OR REPLACE FUNCTION realtime.auto_publish_tasks_table() RETURNS event_trigger AS $fn$
BEGIN
  PERFORM realtime.ensure_tasks_publication();
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'realtime_auto_publish_tasks_trigger') THEN
    CREATE EVENT TRIGGER realtime_auto_publish_tasks_trigger ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE')
      EXECUTE FUNCTION realtime.auto_publish_tasks_table();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;

-- 5. Public Schema Permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO service_role;
-- New public tables are intentionally not exposed to the Data API by default.
-- Tenants must grant anon/authenticated/service_role privileges explicitly in migrations.

-- 6. Supabase SQL Helpers

-- PostgREST pre-request function: sets JWT claims for RLS context
-- supacloud:sql-module:postgrest-request-context:start
CREATE OR REPLACE FUNCTION public.set_request_context() RETURNS void AS $$
DECLARE
  claims jsonb;
  role_claim text;
BEGIN
  BEGIN
    claims := COALESCE(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    claims := '{}'::jsonb;
  END;

  PERFORM set_config('request.jwt.claims', claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(claims ->> 'sub', ''), true);
  PERFORM set_config('request.jwt.claim.email', coalesce(claims ->> 'email', ''), true);

  role_claim := COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    claims ->> 'role',
    'anon'
  );

  PERFORM set_config('request.jwt.claim.role', role_claim, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;

GRANT EXECUTE ON FUNCTION public.set_request_context() TO anon, authenticated, service_role;
-- supacloud:sql-module:postgrest-request-context:end

-- 7. GraphQL Schema
CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

-- 7a. GraphQL fallback stub. Never replace the real pg_graphql RPC when it exists.
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

-- 7b. Supabase Queues compatibility via the official PGMQ extension.
-- supacloud:sql-module:pgmq-public:start
DO $pgmq_extension$
BEGIN
  IF to_regprocedure('pgmq.send(text,jsonb,integer)') IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgmq';
  END IF;
END
$pgmq_extension$;

CREATE SCHEMA IF NOT EXISTS pgmq_public;
GRANT USAGE ON SCHEMA pgmq_public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION pgmq_public.require_public_queue(queue_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  normalized_queue_name text := lower(btrim(queue_name));
BEGIN
  IF normalized_queue_name IS NULL
     OR left(normalized_queue_name, char_length('supacloud_internal_')) = 'supacloud_internal_' THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_NAME_RESERVED' USING ERRCODE = '42501';
  END IF;
  RETURN normalized_queue_name;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.send(pgmq_public.require_public_queue(queue_name), message, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.send_batch(pgmq_public.require_public_queue(queue_name), messages, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.read(pgmq_public.require_public_queue(queue_name), sleep_seconds, n); $$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.pop(pgmq_public.require_public_queue(queue_name)); $$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.archive(pgmq_public.require_public_queue(queue_name), message_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.delete(pgmq_public.require_public_queue(queue_name), message_id); $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role;
-- supacloud:sql-module:pgmq-public:end

-- supacloud:sql-module:workflows-public:start
DO $pgmq_extension$
BEGIN
  IF to_regprocedure('pgmq.send(text,jsonb,integer)') IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgmq';
  END IF;
END
$pgmq_extension$;
CREATE SCHEMA IF NOT EXISTS supacloud_workflows;
REVOKE ALL ON SCHEMA supacloud_workflows FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_workflows TO service_role;

SELECT pgmq.create('supacloud_internal_workflows');

CREATE TABLE IF NOT EXISTS supacloud_workflows.runs (
  id uuid PRIMARY KEY,
  workflow_name text NOT NULL
    CHECK (workflow_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  workflow_version text NOT NULL
    CHECK (char_length(workflow_version) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input) = 'object'),
  output jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output) = 'object'),
  error_message text NOT NULL DEFAULT ''
    CHECK (char_length(error_message) <= 4000),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supacloud_workflows.steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES supacloud_workflows.runs(id) ON DELETE CASCADE,
  step_key text NOT NULL
    CHECK (step_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_lettered', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input) = 'object'),
  output jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output) = 'object'),
  error_message text NOT NULL DEFAULT ''
    CHECK (char_length(error_message) <= 4000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  retry_delay_seconds integer NOT NULL DEFAULT 0
    CHECK (retry_delay_seconds BETWEEN 0 AND 86400),
  queue_message_id bigint NOT NULL UNIQUE,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  next_step_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key)
);

ALTER TABLE supacloud_workflows.steps
  ADD COLUMN IF NOT EXISTS retry_delay_seconds integer NOT NULL DEFAULT 0
    CHECK (retry_delay_seconds BETWEEN 0 AND 86400);

CREATE UNIQUE INDEX IF NOT EXISTS supacloud_workflows_one_active_step_idx
  ON supacloud_workflows.steps (run_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS supacloud_workflows_runs_status_idx
  ON supacloud_workflows.runs (status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS supacloud_workflows_steps_run_idx
  ON supacloud_workflows.steps (run_id, created_at, id);

CREATE TABLE IF NOT EXISTS supacloud_workflows.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES supacloud_workflows.runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES supacloud_workflows.steps(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN (
      'run_started', 'step_claimed', 'step_retried', 'step_completed',
      'step_failed', 'step_dead_lettered', 'run_completed', 'run_cancelled'
    )),
  attempt integer CHECK (attempt IS NULL OR attempt > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supacloud_workflows_events_run_idx
  ON supacloud_workflows.events (run_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS supacloud_workflows_retry_receipt_idx
  ON supacloud_workflows.events (step_id, attempt)
  WHERE event_type IN ('step_retried', 'step_dead_lettered')
    AND details ->> 'operation' = 'retry';

CREATE OR REPLACE FUNCTION supacloud_workflows.snapshot(
  p_run_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'runId', run.id,
    'workflowName', run.workflow_name,
    'workflowVersion', run.workflow_version,
    'status', run.status,
    'input', run.input,
    'output', run.output,
    'errorMessage', run.error_message,
    'rowVersion', run.row_version::text,
    'createdAt', run.created_at,
    'startedAt', run.started_at,
    'completedAt', run.completed_at,
    'updatedAt', run.updated_at,
    'idempotent', p_idempotent,
    'steps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'stepId', step.id,
        'stepKey', step.step_key,
        'status', step.status,
        'input', step.input,
        'output', step.output,
        'errorMessage', step.error_message,
        'attempts', step.attempts,
        'maxAttempts', step.max_attempts,
        'retryDelaySeconds', step.retry_delay_seconds,
        'queueMessageId', step.queue_message_id::text,
        'claimedBy', step.claimed_by,
        'claimedAt', step.claimed_at,
        'completedAt', step.completed_at,
        'nextStepKey', step.next_step_key,
        'createdAt', step.created_at,
        'updatedAt', step.updated_at
      ) ORDER BY step.created_at, step.id)
      FROM supacloud_workflows.steps step
      WHERE step.run_id = run.id
    ), '[]'::jsonb)
  )
  FROM supacloud_workflows.runs run
  WHERE run.id = p_run_id
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.enqueue_step(
  p_run_id uuid,
  p_step_key text,
  p_input jsonb,
  p_max_attempts integer
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_step_key text := nullif(btrim(p_step_key), '');
  step_id uuid := gen_random_uuid();
  message_id bigint;
  created_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF normalized_step_key IS NULL
     OR normalized_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supacloud_workflows.runs run
    WHERE run.id = p_run_id AND run.status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT queued_id INTO message_id
  FROM pgmq.send(
    'supacloud_internal_workflows',
    jsonb_build_object('run_id', p_run_id, 'step_id', step_id),
    0
  ) AS queued_id;

  INSERT INTO supacloud_workflows.steps (
    id, run_id, step_key, input, max_attempts, queue_message_id
  ) VALUES (
    step_id, p_run_id, normalized_step_key, p_input, p_max_attempts, message_id
  ) RETURNING * INTO created_step;

  RETURN created_step;
END;
$$;

-- Clean-code exception: private transitions keep typed PostgreSQL arguments and
-- the complete lock/queue/ledger/event mutation in one transaction. The public
-- contract already uses one JSON request; revisit if a private routine gains a
-- second caller or any transition can be decomposed without weakening atomicity.
CREATE OR REPLACE FUNCTION supacloud_workflows.start_run(
  p_run_id uuid,
  p_workflow_name text,
  p_workflow_version text,
  p_first_step_key text,
  p_input jsonb,
  p_max_attempts integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_name text := nullif(btrim(p_workflow_name), '');
  normalized_version text := nullif(btrim(p_workflow_version), '');
  normalized_first_step_key text := nullif(btrim(p_first_step_key), '');
  existing_run supacloud_workflows.runs%ROWTYPE;
  existing_step supacloud_workflows.steps%ROWTYPE;
  first_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF p_run_id IS NULL
     OR normalized_name IS NULL
     OR normalized_name !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_version IS NULL
     OR char_length(normalized_version) > 80
     OR normalized_first_step_key IS NULL
     OR normalized_first_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_START_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id::text, 0));
  SELECT * INTO existing_run FROM supacloud_workflows.runs WHERE id = p_run_id;
  IF FOUND THEN
    SELECT * INTO existing_step
    FROM supacloud_workflows.steps
    WHERE run_id = p_run_id
    ORDER BY created_at, id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    IF existing_run.workflow_name <> normalized_name
       OR existing_run.workflow_version <> normalized_version
       OR existing_run.input <> p_input
       OR existing_step.step_key <> normalized_first_step_key
       OR existing_step.input <> p_input
       OR existing_step.max_attempts <> p_max_attempts THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(p_run_id, true);
  END IF;

  INSERT INTO supacloud_workflows.runs (
    id, workflow_name, workflow_version, input
  ) VALUES (
    p_run_id, normalized_name, normalized_version, p_input
  );
  first_step := supacloud_workflows.enqueue_step(
    p_run_id, normalized_first_step_key, p_input, p_max_attempts
  );
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type)
  VALUES (p_run_id, first_step.id, 'run_started');
  RETURN supacloud_workflows.snapshot(p_run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.claim_step(
  p_worker_id text,
  p_visibility_timeout_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
  queued_message pgmq.message_record;
  message_run_id text;
  message_step_id text;
  candidate_run_id uuid;
  claimed_step supacloud_workflows.steps%ROWTYPE;
  claimed_run supacloud_workflows.runs%ROWTYPE;
BEGIN
  IF normalized_worker_id IS NULL
     OR char_length(normalized_worker_id) > 200
     OR p_visibility_timeout_seconds NOT BETWEEN 15 AND 3600 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO queued_message
  FROM pgmq.read('supacloud_internal_workflows', p_visibility_timeout_seconds, 1)
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  message_run_id := queued_message.message ->> 'run_id';
  message_step_id := queued_message.message ->> 'step_id';
  IF jsonb_typeof(queued_message.message) IS DISTINCT FROM 'object'
     OR message_run_id IS NULL
     OR message_step_id IS NULL
     OR message_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR message_step_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'invalid_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  SELECT step.run_id INTO candidate_run_id
  FROM supacloud_workflows.steps step
  WHERE step.id::text = lower(message_step_id)
    AND step.run_id::text = lower(message_run_id)
    AND step.queue_message_id = queued_message.msg_id;
  IF NOT FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'orphaned_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate_run_id::text, 0)) THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_RETRY' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO claimed_step
  FROM supacloud_workflows.steps
  WHERE id::text = lower(message_step_id)
    AND run_id = candidate_run_id
    AND queue_message_id = queued_message.msg_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'orphaned_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  SELECT * INTO claimed_run
  FROM supacloud_workflows.runs
  WHERE id = claimed_step.run_id
  FOR UPDATE;
  IF claimed_run.status NOT IN ('queued', 'running')
     OR claimed_step.status NOT IN ('queued', 'running') THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'step_not_claimable',
      'runId', claimed_step.run_id,
      'stepId', claimed_step.id,
      'messageId', queued_message.msg_id::text
    );
  END IF;

  IF queued_message.read_ct > claimed_step.max_attempts THEN
    UPDATE supacloud_workflows.steps
    SET status = 'dead_lettered', attempts = queued_message.read_ct,
        error_message = 'maximum attempts exceeded', completed_at = now(), updated_at = now()
    WHERE id = claimed_step.id;
    UPDATE supacloud_workflows.runs
    SET status = 'failed', error_message = 'maximum attempts exceeded',
        completed_at = now(), updated_at = now(), row_version = row_version + 1
    WHERE id = claimed_step.run_id;
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    INSERT INTO supacloud_workflows.events (
      run_id, step_id, event_type, attempt, details
    ) VALUES (
      claimed_step.run_id, claimed_step.id, 'step_dead_lettered', queued_message.read_ct,
      jsonb_build_object('errorMessage', 'maximum attempts exceeded')
    );
    RETURN jsonb_build_object(
      'status', 'dead_lettered',
      'runId', claimed_step.run_id,
      'stepId', claimed_step.id,
      'stepKey', claimed_step.step_key,
      'messageId', queued_message.msg_id::text,
      'attempt', queued_message.read_ct,
      'maxAttempts', claimed_step.max_attempts
    );
  END IF;

  UPDATE supacloud_workflows.steps
  SET status = 'running', attempts = queued_message.read_ct,
      retry_delay_seconds = 0, claimed_by = normalized_worker_id,
      claimed_at = now(), updated_at = now()
  WHERE id = claimed_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'running', started_at = coalesce(started_at, now()),
      updated_at = now(), row_version = row_version + 1
  WHERE id = claimed_step.run_id;
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt, details)
  VALUES (
    claimed_step.run_id, claimed_step.id, 'step_claimed', queued_message.read_ct,
    jsonb_build_object('workerId', normalized_worker_id)
  );

  RETURN jsonb_build_object(
    'status', 'claimed',
    'runId', claimed_step.run_id,
    'workflowName', claimed_run.workflow_name,
    'workflowVersion', claimed_run.workflow_version,
    'stepId', claimed_step.id,
    'stepKey', claimed_step.step_key,
    'input', claimed_step.input,
    'messageId', queued_message.msg_id::text,
    'attempt', queued_message.read_ct,
    'maxAttempts', claimed_step.max_attempts,
    'workerId', normalized_worker_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.lock_step(
  p_step_id uuid
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  candidate_run_id uuid;
  active_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  SELECT step.run_id INTO candidate_run_id
  FROM supacloud_workflows.steps step
  WHERE step.id = p_step_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(candidate_run_id::text, 0));
  SELECT * INTO active_step
  FROM supacloud_workflows.steps
  WHERE id = p_step_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN active_step;
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.lock_step_attempt(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  active_step supacloud_workflows.steps%ROWTYPE;
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
BEGIN
  active_step := supacloud_workflows.lock_step(p_step_id);
  IF normalized_worker_id IS NULL
     OR p_message_id IS NULL
     OR p_attempt IS NULL
     OR active_step.queue_message_id IS DISTINCT FROM p_message_id
     OR active_step.attempts IS DISTINCT FROM p_attempt
     OR active_step.claimed_by IS DISTINCT FROM normalized_worker_id THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  RETURN active_step;
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.advance_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_output jsonb,
  p_next_step_key text,
  p_next_input jsonb,
  p_next_max_attempts integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  next_step supacloud_workflows.steps%ROWTYPE;
  normalized_next_step_key text := nullif(btrim(p_next_step_key), '');
  archived boolean;
BEGIN
  IF jsonb_typeof(p_output) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_next_input) IS DISTINCT FROM 'object'
     OR normalized_next_step_key IS NULL
     OR normalized_next_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_next_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );

  IF current_step.status = 'completed' THEN
    SELECT * INTO next_step
    FROM supacloud_workflows.steps
    WHERE run_id = current_step.run_id AND step_key = normalized_next_step_key;
    IF NOT FOUND
       OR current_step.output IS DISTINCT FROM p_output
       OR current_step.next_step_key IS DISTINCT FROM normalized_next_step_key
       OR next_step.input IS DISTINCT FROM p_next_input
       OR next_step.max_attempts IS DISTINCT FROM p_next_max_attempts THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'completed', output = p_output, error_message = '',
      completed_at = now(), next_step_key = normalized_next_step_key, updated_at = now()
  WHERE id = current_step.id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_completed', p_attempt,
    jsonb_build_object('nextStepKey', normalized_next_step_key)
  );
  next_step := supacloud_workflows.enqueue_step(
    current_step.run_id, normalized_next_step_key, p_next_input, p_next_max_attempts
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.complete_run(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_step_output jsonb,
  p_run_output jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  current_run supacloud_workflows.runs%ROWTYPE;
  archived boolean;
BEGIN
  IF jsonb_typeof(p_step_output) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_run_output) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );
  SELECT * INTO current_run
  FROM supacloud_workflows.runs
  WHERE id = current_step.run_id
  FOR UPDATE;

  IF current_step.status = 'completed' THEN
    IF current_step.next_step_key IS NOT NULL
       OR current_step.output IS DISTINCT FROM p_step_output
       OR current_run.status IS DISTINCT FROM 'completed'
       OR current_run.output IS DISTINCT FROM p_run_output THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  IF current_run.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'completed', output = p_step_output, error_message = '',
      completed_at = now(), updated_at = now()
  WHERE id = current_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'completed', output = p_run_output, error_message = '',
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = current_step.run_id AND status = 'running';
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt)
  VALUES (current_step.run_id, current_step.id, 'step_completed', p_attempt);
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt)
  VALUES (current_step.run_id, current_step.id, 'run_completed', p_attempt);
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.retry_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_error_message text,
  p_delay_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  normalized_error text := nullif(btrim(p_error_message), '');
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
  retry_receipt jsonb;
  queue_message_updated boolean;
  archived boolean;
BEGIN
  IF normalized_error IS NULL OR char_length(normalized_error) > 4000
     OR p_delay_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step(p_step_id);
  SELECT event.details INTO retry_receipt
  FROM supacloud_workflows.events event
  WHERE event.step_id = current_step.id
    AND event.attempt = p_attempt
    AND event.event_type IN ('step_retried', 'step_dead_lettered')
    AND event.details ->> 'operation' = 'retry'
  ORDER BY event.id DESC
  LIMIT 1;
  IF FOUND THEN
    IF retry_receipt ->> 'messageId' IS DISTINCT FROM p_message_id::text
       OR retry_receipt ->> 'workerId' IS DISTINCT FROM normalized_worker_id
       OR retry_receipt ->> 'errorMessage' IS DISTINCT FROM normalized_error
       OR (retry_receipt ->> 'delaySeconds')::integer IS DISTINCT FROM p_delay_seconds THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF normalized_worker_id IS NULL
     OR p_message_id IS NULL
     OR p_attempt IS NULL
     OR current_step.queue_message_id IS DISTINCT FROM p_message_id
     OR current_step.attempts IS DISTINCT FROM p_attempt
     OR current_step.claimed_by IS DISTINCT FROM normalized_worker_id
     OR current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;

  IF current_step.attempts >= current_step.max_attempts THEN
    SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
    IF archived IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
    END IF;
    UPDATE supacloud_workflows.steps
    SET status = 'dead_lettered', error_message = normalized_error,
        completed_at = now(), updated_at = now()
    WHERE id = current_step.id;
    UPDATE supacloud_workflows.runs
    SET status = 'failed', error_message = normalized_error,
        completed_at = now(), updated_at = now(), row_version = row_version + 1
    WHERE id = current_step.run_id AND status = 'running';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
    END IF;
    INSERT INTO supacloud_workflows.events (
      run_id, step_id, event_type, attempt, details
    ) VALUES (
      current_step.run_id, current_step.id, 'step_dead_lettered', p_attempt,
      jsonb_build_object(
        'operation', 'retry',
        'messageId', p_message_id::text,
        'workerId', normalized_worker_id,
        'errorMessage', normalized_error,
        'delaySeconds', p_delay_seconds
      )
    );
    RETURN supacloud_workflows.snapshot(current_step.run_id, false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pgmq.set_vt('supacloud_internal_workflows', p_message_id, p_delay_seconds)
  ) INTO queue_message_updated;
  IF queue_message_updated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'queued', error_message = normalized_error,
      retry_delay_seconds = p_delay_seconds, updated_at = now()
  WHERE id = current_step.id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_retried', p_attempt,
    jsonb_build_object(
      'operation', 'retry',
      'messageId', p_message_id::text,
      'workerId', normalized_worker_id,
      'errorMessage', normalized_error,
      'delaySeconds', p_delay_seconds
    )
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.fail_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_error_message text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  current_run supacloud_workflows.runs%ROWTYPE;
  normalized_error text := nullif(btrim(p_error_message), '');
  archived boolean;
BEGIN
  IF normalized_error IS NULL OR char_length(normalized_error) > 4000 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );
  SELECT * INTO current_run
  FROM supacloud_workflows.runs
  WHERE id = current_step.run_id
  FOR UPDATE;

  IF current_step.status = 'failed' THEN
    IF current_step.error_message IS DISTINCT FROM normalized_error
       OR current_run.status IS DISTINCT FROM 'failed'
       OR current_run.error_message IS DISTINCT FROM normalized_error THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  IF current_run.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'failed', error_message = normalized_error,
      completed_at = now(), updated_at = now()
  WHERE id = current_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'failed', error_message = normalized_error,
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = current_step.run_id AND status = 'running';
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_failed', p_attempt,
    jsonb_build_object('errorMessage', normalized_error)
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.cancel_run(
  p_run_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_reason text := nullif(btrim(p_reason), '');
  locked_run supacloud_workflows.runs%ROWTYPE;
  active_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR normalized_reason IS NULL OR char_length(normalized_reason) > 4000 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CANCEL_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id::text, 0));
  SELECT * INTO locked_run FROM supacloud_workflows.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF locked_run.status = 'cancelled' THEN
    IF locked_run.error_message IS DISTINCT FROM normalized_reason THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(p_run_id, true);
  END IF;
  IF locked_run.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO active_step
  FROM supacloud_workflows.steps
  WHERE run_id = p_run_id AND status IN ('queued', 'running')
  FOR UPDATE;
  IF FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', active_step.queue_message_id);
    UPDATE supacloud_workflows.steps
    SET status = 'cancelled', error_message = normalized_reason,
        completed_at = now(), updated_at = now()
    WHERE id = active_step.id;
  END IF;
  UPDATE supacloud_workflows.runs
  SET status = 'cancelled', error_message = normalized_reason,
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = p_run_id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, details
  ) VALUES (
    p_run_id, active_step.id, 'run_cancelled',
    jsonb_build_object('reason', normalized_reason)
  );
  RETURN supacloud_workflows.snapshot(p_run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.run_events(
  p_run_id uuid,
  p_after_event_id bigint,
  p_limit integer
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'eventId', page.id::text,
    'runId', page.run_id,
    'stepId', page.step_id,
    'eventType', page.event_type,
    'attempt', page.attempt,
    'details', page.details,
    'createdAt', page.created_at
  ) ORDER BY page.id), '[]'::jsonb)
  FROM (
    SELECT event.*
    FROM supacloud_workflows.events event
    WHERE event.run_id = p_run_id AND event.id > p_after_event_id
    ORDER BY event.id
    LIMIT p_limit
  ) page
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.request_uuid(
  request jsonb,
  key text
) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  uuid_text text;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  uuid_text := request ->> key;
  IF uuid_text IS NULL
     OR uuid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN uuid_text::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_start(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  max_attempts integer;
BEGIN
  max_attempts := coalesce((request ->> 'maxAttempts')::integer, 3);
  RETURN supacloud_workflows.start_run(
    supacloud_workflows.request_uuid(request, 'runId'),
    request ->> 'workflowName',
    request ->> 'workflowVersion',
    request ->> 'firstStepKey',
    coalesce(request -> 'input', '{}'::jsonb),
    max_attempts
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_START_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_claim(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  visibility_timeout_seconds integer;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  visibility_timeout_seconds := coalesce((request ->> 'visibilityTimeoutSeconds')::integer, 300);
  RETURN supacloud_workflows.claim_step(
    request ->> 'workerId', visibility_timeout_seconds
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_advance(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
  next_max_attempts integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  next_max_attempts := coalesce((request ->> 'nextMaxAttempts')::integer, 3);
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.advance_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    coalesce(request -> 'output', '{}'::jsonb),
    request ->> 'nextStepKey',
    coalesce(request -> 'nextInput', '{}'::jsonb),
    next_max_attempts
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_complete(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.complete_run(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    coalesce(request -> 'stepOutput', '{}'::jsonb),
    coalesce(request -> 'runOutput', '{}'::jsonb)
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_retry(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
  delay_seconds integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  delay_seconds := coalesce((request ->> 'delaySeconds')::integer, 0);
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.retry_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    request ->> 'errorMessage',
    delay_seconds
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_fail(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.fail_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    request ->> 'errorMessage'
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_cancel(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_workflows.cancel_run(
    supacloud_workflows.request_uuid(request, 'runId'),
    request ->> 'reason'
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CANCEL_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_get(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_workflows.snapshot(
    supacloud_workflows.request_uuid(request, 'runId'), false
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_events(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  after_event_id bigint;
  event_limit integer;
BEGIN
  after_event_id := coalesce((request ->> 'afterEventId')::bigint, 0);
  event_limit := coalesce((request ->> 'limit')::integer, 100);
  IF after_event_id < 0 OR event_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_EVENTS_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.run_events(
    supacloud_workflows.request_uuid(request, 'runId'), after_event_id, event_limit
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_EVENTS_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.supacloud_workflow_start(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_claim(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_advance(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_complete(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_retry(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_fail(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_cancel(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_get(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_events(jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.supacloud_workflow_start(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_claim(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_advance(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_complete(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_retry(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_fail(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_cancel(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_get(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_events(jsonb) TO service_role;
-- supacloud:sql-module:workflows-public:end

-- supacloud:sql-module:commands-public:start
CREATE SCHEMA IF NOT EXISTS supacloud_commands;
REVOKE ALL ON SCHEMA supacloud_commands FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_commands TO service_role;

CREATE TABLE IF NOT EXISTS supacloud_commands.receipts (
  id uuid PRIMARY KEY,
  command_type text NOT NULL
    CHECK (command_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  target_type text NOT NULL
    CHECK (target_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 500),
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  payload_fingerprint text NOT NULL CHECK (char_length(payload_fingerprint) = 36),
  workflow_run_id uuid NOT NULL UNIQUE
    REFERENCES supacloud_workflows.runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supacloud_commands_target_idx
  ON supacloud_commands.receipts (target_type, target_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION supacloud_commands.snapshot(
  p_command_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'commandId', receipt.id,
    'commandType', receipt.command_type,
    'targetType', receipt.target_type,
    'targetId', receipt.target_id,
    'actorId', receipt.actor_id,
    'payloadFingerprint', receipt.payload_fingerprint,
    'createdAt', receipt.created_at,
    'idempotent', p_idempotent,
    'workflow', supacloud_workflows.snapshot(receipt.workflow_run_id, false)
  )
  FROM supacloud_commands.receipts receipt
  WHERE receipt.id = p_command_id
$$;

-- Application-owned SECURITY DEFINER RPCs may call this after their domain
-- mutation. PostgreSQL commits the domain write, receipt, and workflow enqueue
-- together, so a lost response can be replayed with the same command ID.
DROP FUNCTION IF EXISTS supacloud_commands.submit(uuid, text, text, text, uuid, jsonb, integer);
CREATE OR REPLACE FUNCTION supacloud_commands.submit(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  command_id_text text;
  command_id uuid;
  actor_id uuid;
  max_attempts integer;
  payload jsonb;
  normalized_command_type text;
  normalized_target_type text;
  normalized_target_id text;
  fingerprint text;
  existing supacloud_commands.receipts%ROWTYPE;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;
  command_id_text := request ->> 'commandId';
  IF command_id_text IS NULL
     OR command_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;
  command_id := command_id_text::uuid;
  IF request ? 'actorId' AND request ->> 'actorId' IS NOT NULL THEN
    actor_id := (request ->> 'actorId')::uuid;
  END IF;
  max_attempts := coalesce((request ->> 'maxAttempts')::integer, 3);
  payload := coalesce(request -> 'payload', '{}'::jsonb);
  normalized_command_type := nullif(btrim(request ->> 'commandType'), '');
  normalized_target_type := nullif(btrim(request ->> 'targetType'), '');
  normalized_target_id := nullif(btrim(request ->> 'targetId'), '');
  IF normalized_command_type IS NULL
     OR normalized_command_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_target_type IS NULL
     OR normalized_target_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_target_id IS NULL
     OR char_length(normalized_target_id) > 500
     OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;

  fingerprint := 'md5:' || md5(payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(command_id::text, 0));
  SELECT * INTO existing FROM supacloud_commands.receipts WHERE id = command_id;
  IF FOUND THEN
    IF existing.command_type <> normalized_command_type
       OR existing.target_type <> normalized_target_type
       OR existing.target_id <> normalized_target_id
       OR existing.actor_id IS DISTINCT FROM actor_id
       OR existing.payload <> payload
       OR existing.payload_fingerprint <> fingerprint THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_commands.snapshot(command_id, true);
  END IF;

  PERFORM supacloud_workflows.start_run(
    command_id,
    'command.' || normalized_command_type,
    '1',
    'execute',
    jsonb_build_object(
      'commandId', command_id,
      'commandType', normalized_command_type,
      'targetType', normalized_target_type,
      'targetId', normalized_target_id,
      'actorId', actor_id,
      'payload', payload,
      'payloadFingerprint', fingerprint
    ),
    max_attempts
  );

  INSERT INTO supacloud_commands.receipts (
    id, command_type, target_type, target_id, actor_id, payload,
    payload_fingerprint, workflow_run_id
  ) VALUES (
    command_id, normalized_command_type, normalized_target_type,
    normalized_target_id, actor_id, payload, fingerprint, command_id
  );
  RETURN supacloud_commands.snapshot(command_id, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_command_submit(request jsonb)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT supacloud_commands.submit(request)
$$;

CREATE OR REPLACE FUNCTION public.supacloud_command_get(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  command_id_text text;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
  END IF;
  command_id_text := request ->> 'commandId';
  IF command_id_text IS NULL
     OR command_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_commands.snapshot(command_id_text::uuid, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_commands
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_commands
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.supacloud_command_submit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_command_get(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supacloud_command_submit(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_command_get(jsonb) TO service_role;
-- supacloud:sql-module:commands-public:end

-- supacloud:sql-module:artifacts-public:start
CREATE SCHEMA IF NOT EXISTS supacloud_artifacts;
REVOKE ALL ON SCHEMA supacloud_artifacts FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_artifacts TO service_role;

CREATE TABLE IF NOT EXISTS supacloud_artifacts.artifacts (
  id uuid PRIMARY KEY,
  storage_object_id uuid NOT NULL UNIQUE REFERENCES storage.objects(id) ON DELETE RESTRICT,
  bucket_id text NOT NULL,
  object_path text NOT NULL,
  object_version text NOT NULL,
  artifact_type text NOT NULL
    CHECK (artifact_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 255),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_until IS NULL OR retention_until >= created_at),
  UNIQUE (bucket_id, object_path, object_version)
);

CREATE INDEX IF NOT EXISTS supacloud_artifacts_lookup_idx
  ON supacloud_artifacts.artifacts (artifact_type, created_at DESC, id);

CREATE TABLE IF NOT EXISTS supacloud_artifacts.lineage (
  parent_artifact_id uuid NOT NULL REFERENCES supacloud_artifacts.artifacts(id) ON DELETE RESTRICT,
  child_artifact_id uuid NOT NULL REFERENCES supacloud_artifacts.artifacts(id) ON DELETE RESTRICT,
  relation_type text NOT NULL
    CHECK (relation_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_artifact_id, child_artifact_id, relation_type),
  CHECK (parent_artifact_id <> child_artifact_id)
);

CREATE INDEX IF NOT EXISTS supacloud_artifacts_lineage_child_idx
  ON supacloud_artifacts.lineage (child_artifact_id, created_at, parent_artifact_id);

CREATE OR REPLACE FUNCTION supacloud_artifacts.guard_storage_object()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supacloud_artifacts.artifacts artifact
    WHERE artifact.storage_object_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS supacloud_artifact_storage_fence ON storage.objects;
CREATE TRIGGER supacloud_artifact_storage_fence
BEFORE UPDATE OR DELETE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION supacloud_artifacts.guard_storage_object();

CREATE OR REPLACE FUNCTION supacloud_artifacts.snapshot(
  p_artifact_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'artifactId', artifact.id,
    'bucketId', artifact.bucket_id,
    'objectPath', artifact.object_path,
    'objectVersion', artifact.object_version,
    'artifactType', artifact.artifact_type,
    'sha256', artifact.sha256,
    'sizeBytes', artifact.size_bytes::text,
    'mimeType', artifact.mime_type,
    'metadata', artifact.metadata,
    'retentionUntil', artifact.retention_until,
    'createdBy', artifact.created_by,
    'createdAt', artifact.created_at,
    'idempotent', p_idempotent,
    'parents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'artifactId', edge.parent_artifact_id,
        'relationType', edge.relation_type,
        'metadata', edge.metadata,
        'createdAt', edge.created_at
      ) ORDER BY edge.created_at, edge.parent_artifact_id)
      FROM supacloud_artifacts.lineage edge
      WHERE edge.child_artifact_id = artifact.id
    ), '[]'::jsonb)
  )
  FROM supacloud_artifacts.artifacts artifact
  WHERE artifact.id = p_artifact_id
$$;

DROP FUNCTION IF EXISTS supacloud_artifacts.register(uuid, text, text, text, text, bigint, text, jsonb, timestamptz, uuid);
CREATE OR REPLACE FUNCTION supacloud_artifacts.register(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  artifact_id uuid;
  size_bytes bigint;
  metadata jsonb;
  retention_until timestamptz;
  created_by uuid;
  normalized_bucket text;
  normalized_path text;
  normalized_type text;
  normalized_sha256 text;
  normalized_mime text;
  object_row storage.objects%ROWTYPE;
  existing supacloud_artifacts.artifacts%ROWTYPE;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
  END IF;
  artifact_id := (request ->> 'artifactId')::uuid;
  size_bytes := (request ->> 'sizeBytes')::bigint;
  metadata := coalesce(request -> 'metadata', '{}'::jsonb);
  retention_until := (request ->> 'retentionUntil')::timestamptz;
  created_by := (request ->> 'createdBy')::uuid;
  normalized_bucket := nullif(btrim(request ->> 'bucketId'), '');
  normalized_path := nullif(btrim(request ->> 'objectPath'), '');
  normalized_type := nullif(btrim(request ->> 'artifactType'), '');
  normalized_sha256 := lower(nullif(btrim(request ->> 'sha256'), ''));
  normalized_mime := lower(nullif(btrim(request ->> 'mimeType'), ''));
  IF artifact_id IS NULL OR normalized_bucket IS NULL OR normalized_path IS NULL
     OR normalized_path LIKE '/%' OR normalized_path LIKE '%\\%'
     OR normalized_path ~ '(^|/)(\.|\.\.)(/|$)'
     OR normalized_type IS NULL
     OR normalized_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_sha256 IS NULL OR normalized_sha256 !~ '^[0-9a-f]{64}$'
     OR size_bytes IS NULL OR size_bytes < 0
     OR normalized_mime IS NULL OR char_length(normalized_mime) > 255
     OR jsonb_typeof(metadata) IS DISTINCT FROM 'object'
     OR (retention_until IS NOT NULL AND retention_until < now()) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO object_row FROM storage.objects
  WHERE bucket_id = normalized_bucket AND name = normalized_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_OBJECT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(artifact_id::text, 0));
  SELECT * INTO existing FROM supacloud_artifacts.artifacts WHERE id = artifact_id;
  IF FOUND THEN
    IF existing.storage_object_id <> object_row.id
       OR existing.artifact_type <> normalized_type
       OR existing.sha256 <> normalized_sha256
       OR existing.size_bytes <> size_bytes
       OR existing.mime_type <> normalized_mime
       OR existing.metadata <> metadata
       OR existing.retention_until IS DISTINCT FROM retention_until
       OR existing.created_by IS DISTINCT FROM created_by THEN
      RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_artifacts.snapshot(artifact_id, true);
  END IF;

  INSERT INTO supacloud_artifacts.artifacts (
    id, storage_object_id, bucket_id, object_path, object_version,
    artifact_type, sha256, size_bytes, mime_type, metadata,
    retention_until, created_by
  ) VALUES (
    artifact_id, object_row.id, normalized_bucket, normalized_path,
    object_row.version::text, normalized_type, normalized_sha256,
    size_bytes, normalized_mime, metadata, retention_until, created_by
  );
  RETURN supacloud_artifacts.snapshot(artifact_id, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_artifacts.link(
  p_parent_artifact_id uuid,
  p_child_artifact_id uuid,
  p_relation_type text,
  p_metadata jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_relation text := nullif(btrim(p_relation_type), '');
  inserted_count integer;
BEGIN
  IF p_parent_artifact_id IS NULL OR p_child_artifact_id IS NULL
     OR p_parent_artifact_id = p_child_artifact_id
     OR normalized_relation IS NULL
     OR normalized_relation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH RECURSIVE descendants(artifact_id) AS (
      SELECT edge.child_artifact_id
      FROM supacloud_artifacts.lineage edge
      WHERE edge.parent_artifact_id = p_child_artifact_id
      UNION
      SELECT edge.child_artifact_id
      FROM supacloud_artifacts.lineage edge
      JOIN descendants current ON edge.parent_artifact_id = current.artifact_id
    )
    SELECT 1 FROM descendants WHERE artifact_id = p_parent_artifact_id
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_CYCLE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO supacloud_artifacts.lineage (
    parent_artifact_id, child_artifact_id, relation_type, metadata
  ) VALUES (
    p_parent_artifact_id, p_child_artifact_id, normalized_relation, p_metadata
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 AND NOT EXISTS (
    SELECT 1 FROM supacloud_artifacts.lineage
    WHERE parent_artifact_id = p_parent_artifact_id
      AND child_artifact_id = p_child_artifact_id
      AND relation_type = normalized_relation
      AND metadata = p_metadata
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN supacloud_artifacts.snapshot(p_child_artifact_id, inserted_count = 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_register(request jsonb)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT supacloud_artifacts.register(request)
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_get(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_artifacts.snapshot((request ->> 'artifactId')::uuid, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_link(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_artifacts.link(
    (request ->> 'parentArtifactId')::uuid,
    (request ->> 'childArtifactId')::uuid,
    request ->> 'relationType',
    coalesce(request -> 'metadata', '{}'::jsonb)
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_artifacts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_artifacts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.supacloud_artifact_register(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_artifact_get(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_artifact_link(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_register(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_get(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_link(jsonb) TO service_role;
-- supacloud:sql-module:artifacts-public:end

-- 8. Functions Schema (Webhooks)
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
