DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();
DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();
DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);
DROP TABLE IF EXISTS public.background_task_mirrors;

CREATE OR REPLACE FUNCTION public.has_active_background_tasks(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tasks'
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.tasks
    WHERE created_by = p_user_id
      AND status IN ('pending', 'leased', 'running', 'retry_scheduled', 'queued', 'processing')
  );
EXCEPTION WHEN OTHERS THEN
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.has_active_background_tasks(UUID) FROM PUBLIC;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.soft_delete_user_if_no_active_tasks() FROM PUBLIC;

CREATE TRIGGER auth_users_delete_fence
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.soft_delete_user_if_no_active_tasks();

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION public.hard_delete_soft_deleted_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hard_delete_soft_deleted_users() TO service_role;

NOTIFY pgrst, 'reload schema';
