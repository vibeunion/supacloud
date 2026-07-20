DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;
DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();
DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();
DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);

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

NOTIFY pgrst, 'reload schema';
