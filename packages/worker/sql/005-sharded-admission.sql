-- Sharded admission refinement. Migration 003 remains checksum-stable; this
-- replacement avoids dynamic per-queue table scans while preserving its API.
CREATE OR REPLACE FUNCTION supacloud_worker.enqueue_bounded(
  expected_project text, target_queue text, expected_task_key text,
  operation_key text, input jsonb
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $enqueue$
DECLARE
  project_limit supacloud_worker.bounded_project_limits;
  binding supacloud_worker.queue_bindings;
  queue_depth bigint;
  total_depth bigint := 0;
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

  -- Lock only the project budget and target shard. Queue depth is obtained from
  -- pgmq metrics in bounded calls; queue tables are never scanned per message.
  SELECT queue_length INTO queue_depth FROM pgmq.metrics(target_queue);
  IF queue_depth >= binding.max_pending THEN RAISE EXCEPTION 'WORKER_QUEUE_FULL'; END IF;
  SELECT COALESCE(sum(metrics.queue_length),0) INTO total_depth
    FROM pgmq.metrics_all() AS metrics
    JOIN supacloud_worker.queue_bindings AS family
      ON family.queue_name=metrics.queue_name AND family.project_ref=expected_project;
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
    WHERE queue_name=target_queue AND project_ref=expected_project;
  SELECT pgmq.send(target_queue,payload) INTO message_id;
  RETURN message_id::text;
END $enqueue$;
REVOKE ALL ON FUNCTION supacloud_worker.enqueue_bounded(text,text,text,text,jsonb) FROM PUBLIC;
