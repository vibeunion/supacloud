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

NOTIFY pgrst, 'reload schema';
