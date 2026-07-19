DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.has_active_background_tasks(uuid)')
      AND p.prorettype <> 'text'::regtype
  ) THEN
    DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
    DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();
    DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();
    DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);
  END IF;
END
$migration$;

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
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.has_active_background_tasks(UUID) FROM PUBLIC;

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
    RETURN OLD;
  END IF;

  UPDATE auth.users SET deleted_at = NOW() WHERE id = OLD.id;

  IF v_task_state = 'unknown' THEN
    RAISE NOTICE 'soft_delete_user_if_no_active_tasks: degraded/unknown for user %, blocking hard delete', OLD.id;
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.soft_delete_user_if_no_active_tasks() FROM PUBLIC;

DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
CREATE TRIGGER auth_users_delete_fence
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.soft_delete_user_if_no_active_tasks();

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.hard_delete_soft_deleted_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hard_delete_soft_deleted_users() TO service_role;

NOTIFY pgrst, 'reload schema';
