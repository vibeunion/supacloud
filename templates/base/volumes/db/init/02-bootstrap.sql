-- Optimizations for Supacloud / Pigsty-Supabase
-- Generated automated initialization script

-- 1. Implicit Casts for UUID <-> TEXT
-- Fixes "operator does not exist: uuid = text" in migrations
CREATE OR REPLACE FUNCTION public.uuid_to_text(uuid) RETURNS text AS $$
  SELECT $1::text;
$$ LANGUAGE SQL IMMUTABLE STRICT;

DROP CAST IF EXISTS (uuid AS text);
CREATE CAST (uuid AS text) WITH FUNCTION public.uuid_to_text(uuid) AS IMPLICIT;

CREATE OR REPLACE FUNCTION public.text_to_uuid(text) RETURNS uuid AS $$
  SELECT $1::uuid;
$$ LANGUAGE SQL IMMUTABLE STRICT;

DROP CAST IF EXISTS (text AS uuid);
CREATE CAST (text AS uuid) WITH FUNCTION public.text_to_uuid(text) AS IMPLICIT;

-- 2. Create Validation/Auth Schemas
-- Ensure these exist to prevent start-up errors
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS edge_wrapper;

-- 3. Configure Roles and Search Path
-- Use DO block to avoid errors if roles don't exist yet (though they should be created by other init scripts)
DO $$
BEGIN
  IF EXISTS ( SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    ALTER ROLE supabase_auth_admin SET search_path TO auth, public, extensions;
    GRANT USAGE ON SCHEMA auth TO supabase_auth_admin;
    GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
    -- Ensure future tables are accessible
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO supabase_auth_admin;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_auth_admin;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON ROUTINES TO supabase_auth_admin;
  END IF;

  IF EXISTS ( SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER ROLE postgres SET search_path TO public, auth, extensions;
  END IF;
  
  IF EXISTS ( SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    ALTER ROLE supabase_admin SET search_path TO public, auth, extensions;
  END IF;
END
$$;

-- 4. Ensure Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA extensions;
