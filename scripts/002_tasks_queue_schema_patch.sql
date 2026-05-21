-- ============================================================
-- AoristCross — tasks queue compatibility patch
-- Safe to run repeatedly on existing tenant databases.
-- ============================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.tasks
SET payload = '{}'::jsonb
WHERE payload IS NULL;

DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_def
  FROM pg_constraint
  WHERE conrelid = 'public.tasks'::regclass
    AND conname = 'tasks_type_check';

  IF current_def IS NOT NULL
     AND current_def NOT LIKE '%crop%'
  THEN
    ALTER TABLE public.tasks DROP CONSTRAINT tasks_type_check;
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_type_check
      CHECK (type IN ('pattern', 'mockup', 'title', 'video', 'export', 'agent', 'crop', 'matting'));
  END IF;
END $$;

DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_def
  FROM pg_constraint
  WHERE conrelid = 'public.tasks'::regclass
    AND conname = 'tasks_status_check';

  IF current_def IS NOT NULL
     AND current_def NOT LIKE '%cancelled%'
  THEN
    ALTER TABLE public.tasks DROP CONSTRAINT tasks_status_check;
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_user_created_desc
  ON public.tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_created_desc
  ON public.tasks (user_id, status, created_at DESC);

NOTIFY pgrst, 'reload schema';
