-- Optional bounded-admission routing for the runtime recipes.
-- Migration 002 remains the canonical execution-group admission API.  This
-- migration adds queue budgets without changing that API or its checksum.
CREATE TABLE supacloud_worker.bounded_project_limits (
  project_ref text PRIMARY KEY CHECK (project_ref ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  max_pending integer NOT NULL CHECK (max_pending BETWEEN 1 AND 1000000),
  max_per_second integer NOT NULL CHECK (max_per_second BETWEEN 1 AND 100000),
  window_start timestamptz NOT NULL DEFAULT '-infinity',
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);

-- A queue is globally owned by one project.  The binding is the authority for
-- routing; callers cannot select a queue belonging to another project.
CREATE TABLE supacloud_worker.queue_bindings (
  queue_name text PRIMARY KEY CHECK (queue_name ~ '^scw_[a-z0-9_]{1,40}$'),
  project_ref text NOT NULL CHECK (project_ref ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  task_key text NOT NULL CHECK (task_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  max_pending integer NOT NULL CHECK (max_pending BETWEEN 1 AND 1000000),
  max_per_second integer NOT NULL CHECK (max_per_second BETWEEN 1 AND 100000),
  window_start timestamptz NOT NULL DEFAULT '-infinity',
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  UNIQUE (project_ref, queue_name)
);
CREATE INDEX queue_bindings_project ON supacloud_worker.queue_bindings(project_ref);
REVOKE ALL ON supacloud_worker.bounded_project_limits, supacloud_worker.queue_bindings FROM PUBLIC;

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
  SELECT * INTO project_limit
    FROM supacloud_worker.bounded_project_limits
    WHERE project_ref=expected_project FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_NOT_CONFIGURED'; END IF;
  SELECT * INTO binding
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
REVOKE ALL ON FUNCTION supacloud_worker.enqueue_bounded(text,text,text,text,jsonb) FROM PUBLIC;
