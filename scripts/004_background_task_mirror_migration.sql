-- Background task mirror schema migration
--
-- Separates the platform background task mirror from the business `public.tasks` table,
-- which has incompatible column names and status semantics (AoristCross uses `name`,
-- `type`, `created_by`, status `queued/processing/completed/failed/cancelled`).
--
-- The new `background_task_mirrors` table stores platform background invocation mirrors
-- with the correct column contract and is the sole source for deletion fence checks.
--
-- Usage:
--   1. Run the "Tenant database" section against each tenant database.
--   2. The migrate-tenant-schema.ts and tenant-runtime.service.ts inline DDL will
--      be updated to emit the same schema during new-project bootstrap.

-- migrate:up

-- Tenant database

-- Platform background task mirror table
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

-- Grant access to platform roles (postgres, supabase_auth_admin, supabase_admin)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.background_task_mirrors
  TO postgres, supabase_auth_admin, supabase_admin;

-- Index for fence lookups: find active tasks by invoker user
CREATE INDEX IF NOT EXISTS idx_bg_task_mirrors_invoker_active
  ON public.background_task_mirrors(invoker_user_id, status)
  WHERE status IN ('pending','leased','running','retry_scheduled');

-- Index for task status lookups
CREATE INDEX IF NOT EXISTS idx_bg_task_mirrors_status
  ON public.background_task_mirrors(status);

-- Drop the old mirror function that queried the incompatible public.tasks
-- (will be replaced below)
CREATE OR REPLACE FUNCTION public.has_active_background_tasks(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Check whether the platform mirror table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'background_task_mirrors'
  ) THEN
    -- Mirror table not yet provisioned — report unknown, do NOT silently return FALSE
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
  -- Do NOT silently return FALSE. Log the error and return 'unknown' so callers
  -- can make an informed decision (e.g., prevent hard deletion).
  RAISE NOTICE 'has_active_background_tasks: exception for user % — %', p_user_id, SQLERRM;
  RETURN 'unknown';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Update soft_delete trigger to handle three-state result
CREATE OR REPLACE FUNCTION public.soft_delete_user_if_no_active_tasks()
RETURNS TRIGGER AS $$
DECLARE
  v_task_state TEXT;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  v_task_state := public.has_active_background_tasks(OLD.id);

  IF v_task_state = 'inactive' THEN
    -- No active tasks: allow the original DELETE without touching the row first.
    RETURN OLD;
  END IF;

  -- Active or unknown state: soft-delete and cancel the original hard DELETE.
  UPDATE auth.users SET deleted_at = NOW() WHERE id = OLD.id;

  IF v_task_state = 'unknown' THEN
    -- Degraded state: DB error or mirror table missing. Conservative choice: block hard deletion
    -- and log a degraded-warning so operators can investigate.
    RAISE NOTICE 'soft_delete_user_if_no_active_tasks: degraded/unknown for user %, blocking hard delete', OLD.id;
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure the trigger exists (idempotent)
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

-- Update hard_delete cleanup to handle three-state result
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
    -- 'active' or 'unknown' → skip, keep soft-deleted
  END LOOP;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';

-- migrate:down
-- Rollback: restore original two-state function on public.tasks and drop mirror table.
-- WARNING: rollback loses mirror data; fence will query the incompatible public.tasks again.

DROP TABLE IF EXISTS public.background_task_mirrors;

CREATE OR REPLACE FUNCTION public.has_active_background_tasks(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tasks') THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.tasks
    WHERE created_by = p_user_id
      AND status IN ('pending', 'leased', 'running', 'retry_scheduled')
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.soft_delete_user_if_no_active_tasks()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  IF NOT public.has_active_background_tasks(OLD.id) THEN
    RETURN OLD;
  END IF;

  UPDATE auth.users SET deleted_at = NOW() WHERE id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.hard_delete_soft_deleted_users()
RETURNS INT AS $$
DECLARE
  deleted_count INT := 0;
  user_record RECORD;
BEGIN
  FOR user_record IN
    SELECT id FROM auth.users
    WHERE deleted_at IS NOT NULL
      AND NOT public.has_active_background_tasks(id)
      AND deleted_at < NOW() - INTERVAL '1 hour'
  LOOP
    DELETE FROM auth.users WHERE id = user_record.id;
    deleted_count := deleted_count + 1;
  END LOOP;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';
