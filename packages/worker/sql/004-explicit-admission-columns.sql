-- Name the admission row scans without changing migrations 002 or 003.
CREATE OR REPLACE FUNCTION supacloud_worker.admit_operation(
  project text, group_id text, operation text, input_fingerprint text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE quota supacloud_worker.admission_limits; token supacloud_worker.admission_tokens;
BEGIN
  IF NOT EXISTS (SELECT FROM supacloud_worker.installation WHERE project_ref=project AND singleton) THEN
    RAISE EXCEPTION 'WORKER_PROJECT_MISMATCH';
  END IF;
  SELECT group_name, max_outstanding, outstanding, accepting, updated_at INTO quota FROM supacloud_worker.admission_limits WHERE group_name=group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_UNCONFIGURED'; END IF;
  SELECT group_name, operation_id, fingerprint, released, created_at INTO token FROM supacloud_worker.admission_tokens WHERE group_name=group_id AND operation_id=operation;
  IF FOUND THEN
    IF token.fingerprint IS DISTINCT FROM input_fingerprint THEN RAISE EXCEPTION 'WORKER_OPERATION_CONFLICT'; END IF;
    RETURN false;
  END IF;
  IF NOT quota.accepting THEN RAISE EXCEPTION 'WORKER_ADMISSION_PAUSED'; END IF;
  IF quota.outstanding >= quota.max_outstanding THEN RAISE EXCEPTION 'WORKER_ADMISSION_LIMIT'; END IF;
  INSERT INTO supacloud_worker.admission_tokens(group_name,operation_id,fingerprint)
    VALUES(group_id,operation,input_fingerprint);
  UPDATE supacloud_worker.admission_limits SET outstanding=outstanding+1,updated_at=clock_timestamp()
    WHERE group_name=group_id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION supacloud_worker.enqueue_bounded(
  expected_project text, target_queue text, expected_task_key text,
  operation_key text, input jsonb
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $enqueue$
DECLARE
  project_limit supacloud_worker.bounded_project_limits;
  binding supacloud_worker.queue_bindings;
  queue_depth bigint;
  total_depth bigint := 0;
  name text;
  payload jsonb;
  tick timestamptz;
  message_id bigint;
BEGIN
  IF expected_project IS NULL OR target_queue IS NULL OR expected_task_key IS NULL
    OR operation_key IS NULL OR input IS NULL
    OR expected_project !~ '^[a-z0-9][a-z0-9-]{0,99}$'
    OR target_queue !~ '^scw_[a-z0-9_]{1,40}$'
    OR expected_task_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
    OR operation_key !~ '^[A-Za-z0-9_.:@/-]{1,200}$' THEN
    RAISE EXCEPTION 'WORKER_ADMISSION_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supacloud_worker.installation
    WHERE singleton AND project_ref=expected_project
  ) THEN
    RAISE EXCEPTION 'WORKER_PROJECT_MISMATCH';
  END IF;
  -- Lock the project budget before the queue row.  Every producer follows this
  -- order, so concurrent submissions cannot bypass either limit.
  SELECT project_ref, max_pending, max_per_second, window_start, used INTO project_limit
    FROM supacloud_worker.bounded_project_limits
    WHERE project_ref=expected_project FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_NOT_CONFIGURED'; END IF;
  SELECT queue_name, project_ref, task_key, max_pending, max_per_second, window_start, used INTO binding
    FROM supacloud_worker.queue_bindings
    WHERE queue_name=target_queue AND project_ref=expected_project
      AND task_key=expected_task_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_QUEUE_OWNERSHIP'; END IF;
  IF to_regclass('pgmq.q_' || target_queue) IS NULL THEN
    RAISE EXCEPTION 'WORKER_QUEUE_NOT_FOUND';
  END IF;
  payload := jsonb_build_object('schemaVersion',1,'projectRef',expected_project,
    'taskKey',expected_task_key,'idempotencyKey',operation_key,'input',input);
  IF octet_length(payload::text) > 65536 THEN RAISE EXCEPTION 'WORKER_PAYLOAD_TOO_LARGE'; END IF;

  FOR name IN SELECT queue_name FROM supacloud_worker.queue_bindings
    WHERE project_ref=expected_project ORDER BY queue_name LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM pgmq.%I LIMIT $1) pending', 'q_'||name)
      INTO queue_depth USING project_limit.max_pending;
    total_depth := total_depth + queue_depth;
    IF name=target_queue AND queue_depth >= binding.max_pending THEN
      RAISE EXCEPTION 'WORKER_QUEUE_FULL';
    END IF;
  END LOOP;
  IF total_depth >= project_limit.max_pending THEN RAISE EXCEPTION 'WORKER_PROJECT_FULL'; END IF;
  tick := clock_timestamp();
  IF (project_limit.window_start > tick - interval '1 second' AND project_limit.used >= project_limit.max_per_second)
    OR (binding.window_start > tick - interval '1 second' AND binding.used >= binding.max_per_second) THEN
    RAISE EXCEPTION 'WORKER_RATE_LIMITED';
  END IF;
  UPDATE supacloud_worker.bounded_project_limits
    SET used=CASE WHEN window_start <= tick - interval '1 second' THEN 1 ELSE used+1 END,
        window_start=CASE WHEN window_start <= tick - interval '1 second' THEN tick ELSE window_start END
    WHERE project_ref=expected_project;
  UPDATE supacloud_worker.queue_bindings
    SET used=CASE WHEN window_start <= tick - interval '1 second' THEN 1 ELSE used+1 END,
        window_start=CASE WHEN window_start <= tick - interval '1 second' THEN tick ELSE window_start END
    WHERE queue_name=target_queue;
  SELECT pgmq.send(target_queue,payload) INTO message_id;
  RETURN message_id::text;
END $enqueue$;
