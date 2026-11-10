-- GoTrue/PostgREST/Storage expect the Supabase roles and auth namespace to exist
-- before their first migrations. Tenant-specific setup may extend this bootstrap.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin'
  ) THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE CREATEDB;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA IF NOT EXISTS graphql_public;
ALTER ROLE supabase_auth_admin SET search_path TO auth, public;
ALTER ROLE postgres SET search_path TO auth, public;
GRANT USAGE, CREATE ON SCHEMA auth TO supabase_auth_admin;
GRANT anon, authenticated, service_role, supabase_admin TO postgres;
