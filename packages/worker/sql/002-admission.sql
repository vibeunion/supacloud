-- Optional, explicit installation after the pinned pgflow migrations.
-- This stores budgets only, never job state or a second task ledger.
CREATE TABLE IF NOT EXISTS supacloud_worker.admission_limits (
  scope text PRIMARY KEY CHECK (scope = 'project' OR scope ~ '^scw_[a-z0-9_]{1,40}$'),
  max_pending integer NOT NULL CHECK (max_pending BETWEEN 1 AND 1000000),
  max_per_second integer NOT NULL CHECK (max_per_second BETWEEN 1 AND 100000),
  window_start timestamptz NOT NULL DEFAULT '-infinity',
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);
REVOKE ALL ON supacloud_worker.admission_limits FROM PUBLIC;

CREATE OR REPLACE FUNCTION supacloud_worker.enqueue_bounded(
  expected_project text, target_queue text, task_key text, operation_key text, input jsonb
) RETURNS text LANGUAGE plpgsql SET search_path = '' AS $enqueue$
DECLARE
  project_limit supacloud_worker.admission_limits;
  queue_limit supacloud_worker.admission_limits;
  queue_depth bigint;
  total_depth bigint := 0;
  name text;
  payload jsonb;
  tick timestamptz;
  message_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supacloud_worker.installation WHERE project_ref = expected_project)
    OR target_queue !~ '^scw_[a-z0-9_]{1,40}$'
    OR task_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
    OR operation_key !~ '^[A-Za-z0-9_.:@/-]{1,200}$'
    OR expected_project IS NULL OR target_queue IS NULL OR task_key IS NULL
    OR operation_key IS NULL OR input IS NULL THEN
    RAISE EXCEPTION 'WORKER_ADMISSION_INVALID';
  END IF;
  payload := jsonb_build_object('schemaVersion',1,'projectRef',expected_project,
    'taskKey',task_key,'idempotencyKey',operation_key,'input',input);
  IF octet_length(payload::text) > 65536 THEN RAISE EXCEPTION 'WORKER_PAYLOAD_TOO_LARGE'; END IF;

  -- All producers acquire the project row before the queue row. Locks live through
  -- the caller's domain transaction, so intent and enqueue commit or roll back together.
  SELECT * INTO project_limit FROM supacloud_worker.admission_limits WHERE scope='project' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_NOT_CONFIGURED'; END IF;
  SELECT * INTO queue_limit FROM supacloud_worker.admission_limits WHERE scope=target_queue FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_NOT_CONFIGURED'; END IF;
  tick := clock_timestamp();
  FOR name IN SELECT queue_name FROM pgmq.meta WHERE queue_name ~ '^scw_[a-z0-9_]{1,40}$' LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM pgmq.%I LIMIT $1) pending', 'q_'||name)
      INTO queue_depth USING project_limit.max_pending;
    total_depth := total_depth + queue_depth;
    IF name=target_queue AND queue_depth >= queue_limit.max_pending THEN
      RAISE EXCEPTION 'WORKER_QUEUE_FULL';
    END IF;
    IF total_depth >= project_limit.max_pending THEN RAISE EXCEPTION 'WORKER_PROJECT_FULL'; END IF;
  END LOOP;
  IF (project_limit.window_start > tick - interval '1 second' AND project_limit.used >= project_limit.max_per_second)
    OR (queue_limit.window_start > tick - interval '1 second' AND queue_limit.used >= queue_limit.max_per_second) THEN
    RAISE EXCEPTION 'WORKER_RATE_LIMITED';
  END IF;
  UPDATE supacloud_worker.admission_limits
    SET used = CASE WHEN window_start <= tick - interval '1 second' THEN 1 ELSE used+1 END,
        window_start = CASE WHEN window_start <= tick - interval '1 second' THEN tick ELSE window_start END
    WHERE scope IN ('project',target_queue);
  SELECT pgmq.send(target_queue,payload) INTO message_id;
  RETURN message_id::text;
END $enqueue$;
REVOKE ALL ON FUNCTION supacloud_worker.enqueue_bounded(text,text,text,text,jsonb) FROM PUBLIC;
