DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();
DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();
DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);
DROP TABLE IF EXISTS public.background_task_mirrors;

NOTIFY pgrst, 'reload schema';
