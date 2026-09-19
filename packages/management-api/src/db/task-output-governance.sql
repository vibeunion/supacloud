-- Apply after task-output-journal.sql, in the SAME explicit migration transaction.
-- Freeze producers/retention in their normal lock order before reconciling usage.
LOCK TABLE public.project_tasks, public.project_task_output_streams,
  public.project_task_output_events IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.project_task_output_quotas (
  project_ref text PRIMARY KEY,
  max_retained_bytes bigint NOT NULL DEFAULT 67108864 CHECK (max_retained_bytes BETWEEN 1 AND 1099511627776),
  max_retained_events integer NOT NULL DEFAULT 100000 CHECK (max_retained_events BETWEEN 1 AND 10000000),
  max_events_per_minute integer NOT NULL DEFAULT 6000 CHECK (max_events_per_minute BETWEEN 1 AND 1000000),
  max_bytes_per_minute bigint NOT NULL DEFAULT 8388608 CHECK (max_bytes_per_minute BETWEEN 1 AND 1073741824),
  retained_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_bytes >= 0),
  retained_events bigint NOT NULL DEFAULT 0 CHECK (retained_events >= 0),
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', clock_timestamp()),
  window_events integer NOT NULL DEFAULT 0 CHECK (window_events >= 0),
  window_bytes bigint NOT NULL DEFAULT 0 CHECK (window_bytes >= 0)
);
ALTER TABLE public.project_task_output_quotas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_task_output_quotas FROM PUBLIC;

-- Reapplying preserves configured limits and rate counters. Existing retained
-- history is charged, including projects already above their new storage limit.
UPDATE public.project_task_output_quotas SET retained_bytes = 0, retained_events = 0;
INSERT INTO public.project_task_output_quotas(project_ref, retained_bytes, retained_events)
  SELECT project_ref, sum(octet_length(payload::text)), count(*)
  FROM public.project_task_output_events
  WHERE type IN ('output.delta', 'output.snapshot', 'progress', 'warning')
  GROUP BY project_ref
ON CONFLICT (project_ref) DO UPDATE SET
  retained_bytes = EXCLUDED.retained_bytes, retained_events = EXCLUDED.retained_events;

CREATE OR REPLACE FUNCTION public.supacloud_charge_task_output()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_quota public.project_task_output_quotas%ROWTYPE;
  v_now timestamptz;
  v_window timestamptz;
  v_bytes integer := octet_length(NEW.payload::text);
BEGIN
  -- Lifecycle is deliberately exempt: saturation must not prevent settlement.
  IF NEW.type NOT IN ('output.delta', 'output.snapshot', 'progress', 'warning') THEN RETURN NEW; END IF;
  INSERT INTO public.project_task_output_quotas(project_ref) VALUES (NEW.project_ref)
    ON CONFLICT (project_ref) DO NOTHING;
  SELECT * INTO STRICT v_quota FROM public.project_task_output_quotas
    WHERE project_ref = NEW.project_ref FOR UPDATE;
  -- Different task locks converge on this shared project row. Sample time AFTER
  -- the quota lock, not at transaction start or before a potentially slow wait.
  v_now := clock_timestamp();
  PERFORM 1 FROM public.project_tasks WHERE id = NEW.task_id AND project_ref = NEW.project_ref
    AND attempt = NEW.attempt AND status IN ('leased', 'running')
    AND cancel_requested_at IS NULL AND lease_until > v_now;
  IF NOT FOUND THEN
    RAISE SQLSTATE 'PQT03' USING MESSAGE = 'TASK_OUTPUT_STALE_ATTEMPT';
  END IF;
  v_window := date_trunc('minute', v_now);
  IF v_window > v_quota.window_start THEN
    v_quota.window_start := v_window;
    v_quota.window_events := 0;
    v_quota.window_bytes := 0;
  END IF;
  IF v_quota.retained_bytes + v_bytes > v_quota.max_retained_bytes
    OR v_quota.retained_events + 1 > v_quota.max_retained_events THEN
    RAISE SQLSTATE 'PQT02' USING MESSAGE = 'TASK_OUTPUT_PROJECT_STORAGE_LIMIT';
  END IF;
  IF v_quota.window_events + 1 > v_quota.max_events_per_minute
    OR v_quota.window_bytes + v_bytes > v_quota.max_bytes_per_minute THEN
    RAISE SQLSTATE 'PQT01' USING MESSAGE = 'TASK_OUTPUT_PROJECT_RATE_LIMIT';
  END IF;
  UPDATE public.project_task_output_quotas SET
    retained_bytes = retained_bytes + v_bytes, retained_events = retained_events + 1,
    window_start = v_quota.window_start, window_events = v_quota.window_events + 1,
    window_bytes = v_quota.window_bytes + v_bytes WHERE project_ref = NEW.project_ref;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supacloud_task_output_charge ON public.project_task_output_events;
-- AFTER INSERT charges only rows actually inserted, not ON CONFLICT candidates.
CREATE TRIGGER supacloud_task_output_charge AFTER INSERT ON public.project_task_output_events
  FOR EACH ROW EXECUTE FUNCTION public.supacloud_charge_task_output();

CREATE OR REPLACE FUNCTION public.supacloud_release_task_output()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_usage record;
BEGIN
  -- One update per affected project, including FK cascades. Do not refund rate
  -- usage: deletion must not permit an unlimited publish/delete loop.
  FOR v_usage IN SELECT project_ref, sum(octet_length(payload::text)) AS bytes, count(*) AS events
    FROM removed_output WHERE type IN ('output.delta', 'output.snapshot', 'progress', 'warning')
    GROUP BY project_ref ORDER BY project_ref
  LOOP
    UPDATE public.project_task_output_quotas SET
      retained_bytes = retained_bytes - v_usage.bytes,
      retained_events = retained_events - v_usage.events WHERE project_ref = v_usage.project_ref;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS supacloud_task_output_release ON public.project_task_output_events;
CREATE TRIGGER supacloud_task_output_release AFTER DELETE ON public.project_task_output_events
  REFERENCING OLD TABLE AS removed_output FOR EACH STATEMENT
  EXECUTE FUNCTION public.supacloud_release_task_output();

CREATE OR REPLACE FUNCTION public.supacloud_protect_task_output()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Task output is immutable; use the retention function, not UPDATE or TRUNCATE';
END $$;
DROP TRIGGER IF EXISTS supacloud_task_output_immutable ON public.project_task_output_events;
CREATE TRIGGER supacloud_task_output_immutable BEFORE UPDATE OR TRUNCATE ON public.project_task_output_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.supacloud_protect_task_output();

-- The exception subtransaction rolls back sequence allocation AND all counters.
-- No driver-specific SQL error parsing, message matching, or blind write retry.
CREATE OR REPLACE FUNCTION public.supacloud_append_task_output_governed(
  p_project_ref text, p_task_id uuid, p_attempt integer,
  p_event_id uuid, p_type text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.supacloud_append_task_output(p_project_ref, p_task_id, p_attempt, p_event_id, p_type, p_payload);
EXCEPTION
  WHEN SQLSTATE 'PQT01' THEN RETURN jsonb_build_object('_error', 429, 'code', 'TASK_OUTPUT_PROJECT_RATE_LIMIT');
  WHEN SQLSTATE 'PQT02' THEN RETURN jsonb_build_object('_error', 413, 'code', 'TASK_OUTPUT_PROJECT_STORAGE_LIMIT');
  WHEN SQLSTATE 'PQT03' THEN RETURN jsonb_build_object('_error', 409, 'code', 'TASK_OUTPUT_STALE_ATTEMPT');
END $$;

CREATE INDEX IF NOT EXISTS idx_task_output_retention_candidates ON public.project_tasks(completed_at, id)
  WHERE status IN ('succeeded', 'failed', 'dead_lettered', 'cancelled') AND completed_at IS NOT NULL;

-- Preserve the existing seven-day, terminal-only, watermark-preserving contract.
-- Serialize only cleanup batches; ordinary writers do not use this global lock.
CREATE OR REPLACE FUNCTION public.supacloud_prune_task_output(
  p_before timestamptz DEFAULT clock_timestamp() - interval '7 days', p_limit integer DEFAULT 100
) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_task record; v_count integer := 0;
BEGIN
  IF p_before IS NULL OR p_before > clock_timestamp() OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid task output retention parameters';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('supacloud.task-output-retention.v1', 0)) THEN RETURN 0; END IF;
  FOR v_task IN SELECT task.id FROM public.project_tasks AS task
    JOIN public.project_task_output_streams AS stream ON stream.task_id = task.id
    WHERE task.status IN ('succeeded', 'failed', 'dead_lettered', 'cancelled')
      AND task.completed_at < p_before AND stream.retained_after < stream.last_sequence
    ORDER BY task.completed_at, task.id LIMIT p_limit FOR UPDATE OF task SKIP LOCKED
  LOOP
    UPDATE public.project_task_output_streams SET retained_after = last_sequence WHERE task_id = v_task.id;
    DELETE FROM public.project_task_output_events WHERE task_id = v_task.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.supacloud_charge_task_output(), public.supacloud_release_task_output(),
  public.supacloud_protect_task_output(), public.supacloud_append_task_output_governed(text,uuid,integer,uuid,text,jsonb),
  public.supacloud_prune_task_output(timestamptz,integer) FROM PUBLIC;
DO $$ DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.project_task_output_quotas FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.supacloud_charge_task_output(), public.supacloud_release_task_output(), public.supacloud_protect_task_output(), public.supacloud_append_task_output_governed(text,uuid,integer,uuid,text,jsonb), public.supacloud_prune_task_output(timestamptz,integer) FROM %I', v_role);
    END IF;
  END LOOP;
END $$;
