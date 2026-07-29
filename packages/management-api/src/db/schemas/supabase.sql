-- ============================================================
-- Supabase Core Schema Initialization
-- Based on supabase/postgres official migrations
-- ============================================================

-- 1. 创建 Supabase 专用 Role
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

-- 授予 authenticator 可以切换到各角色
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;
GRANT supabase_admin TO postgres;

-- 设置 supabase_auth_admin 默认 search_path (GoTrue 需要)
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
    confirmation_token VARCHAR(255),
    confirmation_sent_at TIMESTAMPTZ,
    recovery_token VARCHAR(255),
    recovery_sent_at TIMESTAMPTZ,
    email_change_token_new VARCHAR(255),
    email_change VARCHAR(255),
    email_change_sent_at TIMESTAMPTZ,
    last_sign_in_at TIMESTAMPTZ,
    raw_app_meta_data JSONB,
    raw_user_meta_data JSONB,
    is_super_admin BOOLEAN,
    phone VARCHAR(15) UNIQUE DEFAULT NULL,
    phone_confirmed_at TIMESTAMPTZ,
    phone_change VARCHAR(15) DEFAULT '',
    phone_change_token VARCHAR(255) DEFAULT '',
    phone_change_sent_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current VARCHAR(255) DEFAULT '',
    email_change_confirm_status SMALLINT DEFAULT 0,
    banned_until TIMESTAMPTZ,
    reauthentication_token VARCHAR(255) DEFAULT '',
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

-- 授权
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

-- 授权
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

-- 启用 RLS
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

-- 5. Public Schema 权限
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
-- supacloud:sql-module:pgmq-public:end

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
