-- Security hardening migration for the management metadata database and existing tenant databases.
--
-- Usage:
--   1. Run the "Management metadata database" section on the SupaCloud metadata DB.
--   2. For each existing project in projects(ref, db_name, db_user), run the
--      "Existing tenant database" section against that project's db_name.
--
-- migrate:up

-- Management metadata database
-- gen_random_uuid() is built into newer PostgreSQL builds. If your build lacks it,
-- install/enable pgcrypto before running this migration.

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref VARCHAR(50),
  actor TEXT NOT NULL DEFAULT 'unknown',
  action TEXT NOT NULL,
  method VARCHAR(16) NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created
  ON audit_logs(project_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS db_password_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS jwt_secret_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_role_key_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS s3_secret_key_encrypted TEXT;

ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Existing tenant database
-- Replace :db_user with the tenant role from projects.db_user, then run this section
-- while connected to the tenant database from projects.db_name.
--
-- REVOKE CONNECT ON DATABASE must be run by a role with database ownership/superuser rights.
-- Example:
--   REVOKE CONNECT ON DATABASE "supa_projectref" FROM PUBLIC;
--   GRANT CONNECT, TEMPORARY ON DATABASE "supa_projectref" TO "role_projectref";
--   GRANT CONNECT, TEMPORARY ON DATABASE "supa_projectref" TO supabase_auth_admin;
--   GRANT CONNECT, TEMPORARY ON DATABASE "supa_projectref" TO supabase_admin;
--   GRANT ALL PRIVILEGES ON DATABASE "supa_projectref" TO postgres;
--
-- Run inside the tenant database:
--   REVOKE ALL ON SCHEMA public FROM PUBLIC;
--   GRANT USAGE, CREATE ON SCHEMA public TO "role_projectref";
--   GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "role_projectref";
--   GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "role_projectref";
--   GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO "role_projectref";
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO "role_projectref";
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "role_projectref";
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON ROUTINES TO "role_projectref";
--   GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
--   GRANT ALL ON SCHEMA public TO authenticated, service_role;
--   GRANT ALL ON SCHEMA public TO supabase_auth_admin;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

-- Helper query to list tenant patch commands from the metadata DB:
-- SELECT
--   ref,
--   db_name,
--   db_user,
--   format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC;', db_name) AS revoke_db_connect,
--   format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I;', db_name, db_user) AS grant_db_connect,
--   format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO supabase_auth_admin;', db_name) AS grant_auth_connect,
--   format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO supabase_admin;', db_name) AS grant_supabase_admin_connect,
--   format('GRANT ALL PRIVILEGES ON DATABASE %I TO postgres;', db_name) AS grant_admin_db
-- FROM projects
-- WHERE deleted_at IS NULL
-- ORDER BY ref;

-- migrate:down
-- This rollback intentionally leaves audit_logs data and encrypted shadow columns in place.
-- To relax existing tenant restrictions manually:
--   GRANT CONNECT ON DATABASE "supa_projectref" TO PUBLIC;
--   GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
