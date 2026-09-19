-- Optional CONTROL-PLANE extension. Apply in a transaction after initDatabase.
-- No tenant schema, Auth grants, Realtime protocol, or function invocation changes.
CREATE TABLE IF NOT EXISTS public.project_task_output_streams (
  task_id uuid PRIMARY KEY REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  project_ref text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  retained_after bigint NOT NULL DEFAULT 0 CHECK (retained_after >= 0 AND retained_after <= last_sequence),
  output_count integer NOT NULL DEFAULT 0 CHECK (output_count >= 0 AND output_count <= 4096),
  output_bytes bigint NOT NULL DEFAULT 0 CHECK (output_bytes >= 0 AND output_bytes <= 1048576),
  UNIQUE (task_id, project_ref)
);
CREATE TABLE IF NOT EXISTS public.project_task_output_events (
  task_id uuid NOT NULL,
  project_ref text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, sequence),
  UNIQUE (task_id, attempt, event_id),
  FOREIGN KEY (task_id, project_ref) REFERENCES public.project_task_output_streams(task_id, project_ref) ON DELETE CASCADE
);
ALTER TABLE public.project_task_output_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_task_output_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_task_output_streams, public.project_task_output_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.supacloud_append_task_output(
  p_project_ref text, p_task_id uuid, p_attempt integer,
  p_event_id uuid, p_type text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_task public.project_tasks%ROWTYPE;
  v_stream public.project_task_output_streams%ROWTYPE;
  v_event public.project_task_output_events%ROWTYPE;
  v_bytes integer;
BEGIN
  -- All append, lifecycle, read and retention paths lock task THEN stream.
  SELECT * INTO v_task FROM public.project_tasks
    WHERE id = p_task_id AND project_ref = p_project_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('_error', 404, 'code', 'TASK_OUTPUT_NOT_FOUND');
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 OR p_event_id IS NULL OR p_type IS NULL
    OR p_type NOT IN ('output.delta', 'output.snapshot', 'progress', 'warning')
    OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('_error', 400, 'code', 'TASK_OUTPUT_INVALID_INPUT');
  END IF;
  v_bytes := octet_length(p_payload::text);
  IF v_bytes > 16384 THEN
    RETURN jsonb_build_object('_error', 413, 'code', 'TASK_OUTPUT_LIMIT');
  END IF;
  -- Retried writes of a committed event can be acknowledged after completion.
  -- They may not mutate the event or create output for an old attempt.
  SELECT * INTO v_event FROM public.project_task_output_events
    WHERE task_id = p_task_id AND attempt = p_attempt AND event_id = p_event_id;
  IF FOUND THEN
    IF v_event.type <> p_type OR v_event.payload <> p_payload THEN
      RETURN jsonb_build_object('_error', 409, 'code', 'TASK_OUTPUT_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object('schema_version', 1, 'task_id', p_task_id, 'project_ref', p_project_ref,
      'event_id', v_event.event_id, 'sequence', v_event.sequence::text, 'attempt', v_event.attempt,
      'type', v_event.type, 'payload', v_event.payload, 'created_at', v_event.created_at);
  END IF;
  IF v_task.attempt IS DISTINCT FROM p_attempt OR v_task.status NOT IN ('leased', 'running')
    OR v_task.lease_until IS NULL OR v_task.lease_until <= clock_timestamp()
    OR v_task.cancel_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('_error', 409, 'code', 'TASK_OUTPUT_STALE_ATTEMPT');
  END IF;
  INSERT INTO public.project_task_output_streams(task_id, project_ref)
    VALUES (p_task_id, p_project_ref) ON CONFLICT (task_id) DO NOTHING;
  SELECT * INTO v_stream FROM public.project_task_output_streams WHERE task_id = p_task_id FOR UPDATE;
  IF v_stream.output_count >= 4096 OR v_stream.output_bytes + v_bytes > 1048576 THEN
    RETURN jsonb_build_object('_error', 413, 'code', 'TASK_OUTPUT_LIMIT');
  END IF;
  -- Sequence allocation is transactional and serialized per task, NOT nextval().
  UPDATE public.project_task_output_streams
    SET last_sequence = last_sequence + 1, output_count = output_count + 1, output_bytes = output_bytes + v_bytes
    WHERE task_id = p_task_id RETURNING * INTO v_stream;
  INSERT INTO public.project_task_output_events(task_id, project_ref, sequence, event_id, attempt, type, payload)
    VALUES (p_task_id, p_project_ref, v_stream.last_sequence, p_event_id, p_attempt, p_type, p_payload)
    RETURNING * INTO v_event;
  RETURN jsonb_build_object('schema_version', 1, 'task_id', p_task_id, 'project_ref', p_project_ref,
    'event_id', v_event.event_id, 'sequence', v_event.sequence::text, 'attempt', v_event.attempt,
    'type', v_event.type, 'payload', v_event.payload, 'created_at', v_event.created_at);
END $$;

CREATE OR REPLACE FUNCTION public.supacloud_capture_task_output_lifecycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_sequence bigint;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.attempt IS NOT DISTINCT FROM NEW.attempt THEN
    RETURN NEW;
  END IF;
  -- Tasks opt in only after their first output append. Ordinary tasks are untouched.
  UPDATE public.project_task_output_streams SET last_sequence = last_sequence + 1
    WHERE task_id = NEW.id RETURNING last_sequence INTO v_sequence;
  IF FOUND THEN
    INSERT INTO public.project_task_output_events(task_id, project_ref, sequence, event_id, attempt, type, payload)
      VALUES (NEW.id, NEW.project_ref, v_sequence, gen_random_uuid(), COALESCE(NEW.attempt, 0),
        'task.' || NEW.status, jsonb_build_object('status', NEW.status));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supacloud_task_output_lifecycle ON public.project_tasks;
CREATE TRIGGER supacloud_task_output_lifecycle AFTER UPDATE OF status, attempt ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.supacloud_capture_task_output_lifecycle();

CREATE OR REPLACE FUNCTION public.supacloud_read_task_output(
  p_project_ref text, p_task_id uuid, p_after bigint DEFAULT 0,
  p_limit integer DEFAULT 50, p_invoker_user_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_task public.project_tasks%ROWTYPE;
  v_stream public.project_task_output_streams%ROWTYPE;
  v_events jsonb;
  v_next bigint;
  v_enabled boolean;
BEGIN
  IF p_after IS NULL OR p_after < 0 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RETURN jsonb_build_object('_error', 400, 'code', 'TASK_OUTPUT_INVALID_INPUT');
  END IF;
  -- Owner authorization and the page snapshot are checked under the same lock.
  SELECT * INTO v_task FROM public.project_tasks
    WHERE id = p_task_id AND project_ref = p_project_ref
      AND (p_invoker_user_id IS NULL OR invoker_user_id = p_invoker_user_id) FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('_error', 404, 'code', 'TASK_OUTPUT_NOT_FOUND'); END IF;
  SELECT * INTO v_stream FROM public.project_task_output_streams WHERE task_id = p_task_id;
  v_enabled := FOUND;
  IF NOT v_enabled THEN
    v_stream.last_sequence := 0;
    v_stream.retained_after := 0;
  END IF;
  IF p_after > v_stream.last_sequence THEN
    RETURN jsonb_build_object('_error', 400, 'code', 'TASK_OUTPUT_CURSOR_AHEAD');
  END IF;
  IF p_after < v_stream.retained_after THEN
    RETURN jsonb_build_object('schema_version', 1, 'project_ref', p_project_ref, 'task_id', p_task_id,
      'enabled', v_enabled, 'task_status', v_task.status, 'attempt', COALESCE(v_task.attempt, 0),
      'events', '[]'::jsonb, 'next_cursor', p_after::text, 'last_sequence', v_stream.last_sequence::text,
      'retained_after', v_stream.retained_after::text, 'has_more', false, 'replay_available', false);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('schema_version', 1, 'task_id', task_id,
      'project_ref', project_ref, 'event_id', event_id, 'sequence', sequence::text,
      'attempt', attempt, 'type', type, 'payload', payload, 'created_at', created_at) ORDER BY sequence), '[]'::jsonb),
    COALESCE(max(sequence), p_after)
    INTO v_events, v_next
    FROM (SELECT * FROM public.project_task_output_events
      WHERE task_id = p_task_id AND project_ref = p_project_ref AND sequence > p_after
      ORDER BY sequence LIMIT p_limit) AS page;
  RETURN jsonb_build_object('schema_version', 1, 'project_ref', p_project_ref, 'task_id', p_task_id,
    'enabled', v_enabled, 'task_status', v_task.status, 'attempt', COALESCE(v_task.attempt, 0),
    'events', v_events, 'next_cursor', v_next::text, 'last_sequence', v_stream.last_sequence::text,
    'retained_after', v_stream.retained_after::text, 'has_more', v_next < v_stream.last_sequence, 'replay_available', true);
END $$;

-- Retention removes completed history only. The watermark and lifetime quotas survive.
CREATE OR REPLACE FUNCTION public.supacloud_prune_task_output(
  p_before timestamptz DEFAULT clock_timestamp() - interval '7 days', p_limit integer DEFAULT 100
) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_task record; v_count integer := 0;
BEGIN
  IF p_before IS NULL OR p_before > clock_timestamp() OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid task output retention parameters';
  END IF;
  FOR v_task IN
    SELECT task.id FROM public.project_tasks AS task
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

REVOKE ALL ON FUNCTION public.supacloud_append_task_output(text, uuid, integer, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supacloud_read_task_output(text, uuid, bigint, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supacloud_prune_task_output(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supacloud_capture_task_output_lifecycle() FROM PUBLIC;
-- Control-plane storage is never directly exposed to tenant PostgreSQL roles.
DO $$ DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.project_task_output_streams, public.project_task_output_events FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.supacloud_append_task_output(text,uuid,integer,uuid,text,jsonb), public.supacloud_read_task_output(text,uuid,bigint,integer,uuid), public.supacloud_prune_task_output(timestamptz,integer), public.supacloud_capture_task_output_lifecycle() FROM %I', v_role);
    END IF;
  END LOOP;
END $$;
