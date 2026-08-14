DO $pgmq_extension$
BEGIN
  IF to_regprocedure('pgmq.send(text,jsonb,integer)') IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgmq';
  END IF;
END
$pgmq_extension$;
CREATE SCHEMA IF NOT EXISTS supacloud_workflows;
REVOKE ALL ON SCHEMA supacloud_workflows FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_workflows TO service_role;

SELECT pgmq.create('supacloud_internal_workflows');

CREATE TABLE IF NOT EXISTS supacloud_workflows.runs (
  id uuid PRIMARY KEY,
  workflow_name text NOT NULL
    CHECK (workflow_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  workflow_version text NOT NULL
    CHECK (char_length(workflow_version) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input) = 'object'),
  output jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output) = 'object'),
  error_message text NOT NULL DEFAULT ''
    CHECK (char_length(error_message) <= 4000),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supacloud_workflows.steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES supacloud_workflows.runs(id) ON DELETE CASCADE,
  step_key text NOT NULL
    CHECK (step_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_lettered', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input) = 'object'),
  output jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output) = 'object'),
  error_message text NOT NULL DEFAULT ''
    CHECK (char_length(error_message) <= 4000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  retry_delay_seconds integer NOT NULL DEFAULT 0
    CHECK (retry_delay_seconds BETWEEN 0 AND 86400),
  queue_message_id bigint NOT NULL UNIQUE,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  next_step_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key)
);

ALTER TABLE supacloud_workflows.steps
  ADD COLUMN IF NOT EXISTS retry_delay_seconds integer NOT NULL DEFAULT 0
    CHECK (retry_delay_seconds BETWEEN 0 AND 86400);

CREATE UNIQUE INDEX IF NOT EXISTS supacloud_workflows_one_active_step_idx
  ON supacloud_workflows.steps (run_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS supacloud_workflows_runs_status_idx
  ON supacloud_workflows.runs (status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS supacloud_workflows_steps_run_idx
  ON supacloud_workflows.steps (run_id, created_at, id);

CREATE TABLE IF NOT EXISTS supacloud_workflows.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES supacloud_workflows.runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES supacloud_workflows.steps(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN (
      'run_started', 'step_claimed', 'step_retried', 'step_completed',
      'step_failed', 'step_dead_lettered', 'run_completed', 'run_cancelled'
    )),
  attempt integer CHECK (attempt IS NULL OR attempt > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supacloud_workflows_events_run_idx
  ON supacloud_workflows.events (run_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS supacloud_workflows_retry_receipt_idx
  ON supacloud_workflows.events (step_id, attempt)
  WHERE event_type IN ('step_retried', 'step_dead_lettered')
    AND details ->> 'operation' = 'retry';

CREATE OR REPLACE FUNCTION supacloud_workflows.snapshot(
  p_run_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'runId', run.id,
    'workflowName', run.workflow_name,
    'workflowVersion', run.workflow_version,
    'status', run.status,
    'input', run.input,
    'output', run.output,
    'errorMessage', run.error_message,
    'rowVersion', run.row_version::text,
    'createdAt', run.created_at,
    'startedAt', run.started_at,
    'completedAt', run.completed_at,
    'updatedAt', run.updated_at,
    'idempotent', p_idempotent,
    'steps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'stepId', step.id,
        'stepKey', step.step_key,
        'status', step.status,
        'input', step.input,
        'output', step.output,
        'errorMessage', step.error_message,
        'attempts', step.attempts,
        'maxAttempts', step.max_attempts,
        'retryDelaySeconds', step.retry_delay_seconds,
        'queueMessageId', step.queue_message_id::text,
        'claimedBy', step.claimed_by,
        'claimedAt', step.claimed_at,
        'completedAt', step.completed_at,
        'nextStepKey', step.next_step_key,
        'createdAt', step.created_at,
        'updatedAt', step.updated_at
      ) ORDER BY step.created_at, step.id)
      FROM supacloud_workflows.steps step
      WHERE step.run_id = run.id
    ), '[]'::jsonb)
  )
  FROM supacloud_workflows.runs run
  WHERE run.id = p_run_id
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.enqueue_step(
  p_run_id uuid,
  p_step_key text,
  p_input jsonb,
  p_max_attempts integer
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_step_key text := nullif(btrim(p_step_key), '');
  step_id uuid := gen_random_uuid();
  message_id bigint;
  created_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF normalized_step_key IS NULL
     OR normalized_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supacloud_workflows.runs run
    WHERE run.id = p_run_id AND run.status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT queued_id INTO message_id
  FROM pgmq.send(
    'supacloud_internal_workflows',
    jsonb_build_object('run_id', p_run_id, 'step_id', step_id),
    0
  ) AS queued_id;

  INSERT INTO supacloud_workflows.steps (
    id, run_id, step_key, input, max_attempts, queue_message_id
  ) VALUES (
    step_id, p_run_id, normalized_step_key, p_input, p_max_attempts, message_id
  ) RETURNING * INTO created_step;

  RETURN created_step;
END;
$$;

-- Clean-code exception: private transitions keep typed PostgreSQL arguments and
-- the complete lock/queue/ledger/event mutation in one transaction. The public
-- contract already uses one JSON request; revisit if a private routine gains a
-- second caller or any transition can be decomposed without weakening atomicity.
CREATE OR REPLACE FUNCTION supacloud_workflows.start_run(
  p_run_id uuid,
  p_workflow_name text,
  p_workflow_version text,
  p_first_step_key text,
  p_input jsonb,
  p_max_attempts integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_name text := nullif(btrim(p_workflow_name), '');
  normalized_version text := nullif(btrim(p_workflow_version), '');
  normalized_first_step_key text := nullif(btrim(p_first_step_key), '');
  existing_run supacloud_workflows.runs%ROWTYPE;
  existing_step supacloud_workflows.steps%ROWTYPE;
  first_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF p_run_id IS NULL
     OR normalized_name IS NULL
     OR normalized_name !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_version IS NULL
     OR char_length(normalized_version) > 80
     OR normalized_first_step_key IS NULL
     OR normalized_first_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_START_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id::text, 0));
  SELECT * INTO existing_run FROM supacloud_workflows.runs WHERE id = p_run_id;
  IF FOUND THEN
    SELECT * INTO existing_step
    FROM supacloud_workflows.steps
    WHERE run_id = p_run_id
    ORDER BY created_at, id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    IF existing_run.workflow_name <> normalized_name
       OR existing_run.workflow_version <> normalized_version
       OR existing_run.input <> p_input
       OR existing_step.step_key <> normalized_first_step_key
       OR existing_step.input <> p_input
       OR existing_step.max_attempts <> p_max_attempts THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(p_run_id, true);
  END IF;

  INSERT INTO supacloud_workflows.runs (
    id, workflow_name, workflow_version, input
  ) VALUES (
    p_run_id, normalized_name, normalized_version, p_input
  );
  first_step := supacloud_workflows.enqueue_step(
    p_run_id, normalized_first_step_key, p_input, p_max_attempts
  );
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type)
  VALUES (p_run_id, first_step.id, 'run_started');
  RETURN supacloud_workflows.snapshot(p_run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.claim_step(
  p_worker_id text,
  p_visibility_timeout_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
  queued_message pgmq.message_record;
  message_run_id text;
  message_step_id text;
  candidate_run_id uuid;
  claimed_step supacloud_workflows.steps%ROWTYPE;
  claimed_run supacloud_workflows.runs%ROWTYPE;
BEGIN
  IF normalized_worker_id IS NULL
     OR char_length(normalized_worker_id) > 200
     OR p_visibility_timeout_seconds NOT BETWEEN 15 AND 3600 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO queued_message
  FROM pgmq.read('supacloud_internal_workflows', p_visibility_timeout_seconds, 1)
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  message_run_id := queued_message.message ->> 'run_id';
  message_step_id := queued_message.message ->> 'step_id';
  IF jsonb_typeof(queued_message.message) IS DISTINCT FROM 'object'
     OR message_run_id IS NULL
     OR message_step_id IS NULL
     OR message_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR message_step_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'invalid_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  SELECT step.run_id INTO candidate_run_id
  FROM supacloud_workflows.steps step
  WHERE step.id::text = lower(message_step_id)
    AND step.run_id::text = lower(message_run_id)
    AND step.queue_message_id = queued_message.msg_id;
  IF NOT FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'orphaned_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate_run_id::text, 0)) THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_RETRY' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO claimed_step
  FROM supacloud_workflows.steps
  WHERE id::text = lower(message_step_id)
    AND run_id = candidate_run_id
    AND queue_message_id = queued_message.msg_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'orphaned_message',
      'messageId', queued_message.msg_id::text
    );
  END IF;

  SELECT * INTO claimed_run
  FROM supacloud_workflows.runs
  WHERE id = claimed_step.run_id
  FOR UPDATE;
  IF claimed_run.status NOT IN ('queued', 'running')
     OR claimed_step.status NOT IN ('queued', 'running') THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    RETURN jsonb_build_object(
      'status', 'discarded',
      'reason', 'step_not_claimable',
      'runId', claimed_step.run_id,
      'stepId', claimed_step.id,
      'messageId', queued_message.msg_id::text
    );
  END IF;

  IF queued_message.read_ct > claimed_step.max_attempts THEN
    UPDATE supacloud_workflows.steps
    SET status = 'dead_lettered', attempts = queued_message.read_ct,
        error_message = 'maximum attempts exceeded', completed_at = now(), updated_at = now()
    WHERE id = claimed_step.id;
    UPDATE supacloud_workflows.runs
    SET status = 'failed', error_message = 'maximum attempts exceeded',
        completed_at = now(), updated_at = now(), row_version = row_version + 1
    WHERE id = claimed_step.run_id;
    PERFORM pgmq.archive('supacloud_internal_workflows', queued_message.msg_id);
    INSERT INTO supacloud_workflows.events (
      run_id, step_id, event_type, attempt, details
    ) VALUES (
      claimed_step.run_id, claimed_step.id, 'step_dead_lettered', queued_message.read_ct,
      jsonb_build_object('errorMessage', 'maximum attempts exceeded')
    );
    RETURN jsonb_build_object(
      'status', 'dead_lettered',
      'runId', claimed_step.run_id,
      'stepId', claimed_step.id,
      'stepKey', claimed_step.step_key,
      'messageId', queued_message.msg_id::text,
      'attempt', queued_message.read_ct,
      'maxAttempts', claimed_step.max_attempts
    );
  END IF;

  UPDATE supacloud_workflows.steps
  SET status = 'running', attempts = queued_message.read_ct,
      retry_delay_seconds = 0, claimed_by = normalized_worker_id,
      claimed_at = now(), updated_at = now()
  WHERE id = claimed_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'running', started_at = coalesce(started_at, now()),
      updated_at = now(), row_version = row_version + 1
  WHERE id = claimed_step.run_id;
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt, details)
  VALUES (
    claimed_step.run_id, claimed_step.id, 'step_claimed', queued_message.read_ct,
    jsonb_build_object('workerId', normalized_worker_id)
  );

  RETURN jsonb_build_object(
    'status', 'claimed',
    'runId', claimed_step.run_id,
    'workflowName', claimed_run.workflow_name,
    'workflowVersion', claimed_run.workflow_version,
    'stepId', claimed_step.id,
    'stepKey', claimed_step.step_key,
    'input', claimed_step.input,
    'messageId', queued_message.msg_id::text,
    'attempt', queued_message.read_ct,
    'maxAttempts', claimed_step.max_attempts,
    'workerId', normalized_worker_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.lock_step(
  p_step_id uuid
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  candidate_run_id uuid;
  active_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  SELECT step.run_id INTO candidate_run_id
  FROM supacloud_workflows.steps step
  WHERE step.id = p_step_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(candidate_run_id::text, 0));
  SELECT * INTO active_step
  FROM supacloud_workflows.steps
  WHERE id = p_step_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STEP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN active_step;
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.lock_step_attempt(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text
) RETURNS supacloud_workflows.steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  active_step supacloud_workflows.steps%ROWTYPE;
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
BEGIN
  active_step := supacloud_workflows.lock_step(p_step_id);
  IF normalized_worker_id IS NULL
     OR p_message_id IS NULL
     OR p_attempt IS NULL
     OR active_step.queue_message_id IS DISTINCT FROM p_message_id
     OR active_step.attempts IS DISTINCT FROM p_attempt
     OR active_step.claimed_by IS DISTINCT FROM normalized_worker_id THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  RETURN active_step;
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.advance_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_output jsonb,
  p_next_step_key text,
  p_next_input jsonb,
  p_next_max_attempts integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  next_step supacloud_workflows.steps%ROWTYPE;
  normalized_next_step_key text := nullif(btrim(p_next_step_key), '');
  archived boolean;
BEGIN
  IF jsonb_typeof(p_output) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_next_input) IS DISTINCT FROM 'object'
     OR normalized_next_step_key IS NULL
     OR normalized_next_step_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_next_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );

  IF current_step.status = 'completed' THEN
    SELECT * INTO next_step
    FROM supacloud_workflows.steps
    WHERE run_id = current_step.run_id AND step_key = normalized_next_step_key;
    IF NOT FOUND
       OR current_step.output IS DISTINCT FROM p_output
       OR current_step.next_step_key IS DISTINCT FROM normalized_next_step_key
       OR next_step.input IS DISTINCT FROM p_next_input
       OR next_step.max_attempts IS DISTINCT FROM p_next_max_attempts THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'completed', output = p_output, error_message = '',
      completed_at = now(), next_step_key = normalized_next_step_key, updated_at = now()
  WHERE id = current_step.id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_completed', p_attempt,
    jsonb_build_object('nextStepKey', normalized_next_step_key)
  );
  next_step := supacloud_workflows.enqueue_step(
    current_step.run_id, normalized_next_step_key, p_next_input, p_next_max_attempts
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.complete_run(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_step_output jsonb,
  p_run_output jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  current_run supacloud_workflows.runs%ROWTYPE;
  archived boolean;
BEGIN
  IF jsonb_typeof(p_step_output) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_run_output) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );
  SELECT * INTO current_run
  FROM supacloud_workflows.runs
  WHERE id = current_step.run_id
  FOR UPDATE;

  IF current_step.status = 'completed' THEN
    IF current_step.next_step_key IS NOT NULL
       OR current_step.output IS DISTINCT FROM p_step_output
       OR current_run.status IS DISTINCT FROM 'completed'
       OR current_run.output IS DISTINCT FROM p_run_output THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  IF current_run.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'completed', output = p_step_output, error_message = '',
      completed_at = now(), updated_at = now()
  WHERE id = current_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'completed', output = p_run_output, error_message = '',
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = current_step.run_id AND status = 'running';
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt)
  VALUES (current_step.run_id, current_step.id, 'step_completed', p_attempt);
  INSERT INTO supacloud_workflows.events (run_id, step_id, event_type, attempt)
  VALUES (current_step.run_id, current_step.id, 'run_completed', p_attempt);
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.retry_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_error_message text,
  p_delay_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  normalized_error text := nullif(btrim(p_error_message), '');
  normalized_worker_id text := nullif(btrim(p_worker_id), '');
  retry_receipt jsonb;
  queue_message_updated boolean;
  archived boolean;
BEGIN
  IF normalized_error IS NULL OR char_length(normalized_error) > 4000
     OR p_delay_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step(p_step_id);
  SELECT event.details INTO retry_receipt
  FROM supacloud_workflows.events event
  WHERE event.step_id = current_step.id
    AND event.attempt = p_attempt
    AND event.event_type IN ('step_retried', 'step_dead_lettered')
    AND event.details ->> 'operation' = 'retry'
  ORDER BY event.id DESC
  LIMIT 1;
  IF FOUND THEN
    IF retry_receipt ->> 'messageId' IS DISTINCT FROM p_message_id::text
       OR retry_receipt ->> 'workerId' IS DISTINCT FROM normalized_worker_id
       OR retry_receipt ->> 'errorMessage' IS DISTINCT FROM normalized_error
       OR (retry_receipt ->> 'delaySeconds')::integer IS DISTINCT FROM p_delay_seconds THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF normalized_worker_id IS NULL
     OR p_message_id IS NULL
     OR p_attempt IS NULL
     OR current_step.queue_message_id IS DISTINCT FROM p_message_id
     OR current_step.attempts IS DISTINCT FROM p_attempt
     OR current_step.claimed_by IS DISTINCT FROM normalized_worker_id
     OR current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;

  IF current_step.attempts >= current_step.max_attempts THEN
    SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
    IF archived IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
    END IF;
    UPDATE supacloud_workflows.steps
    SET status = 'dead_lettered', error_message = normalized_error,
        completed_at = now(), updated_at = now()
    WHERE id = current_step.id;
    UPDATE supacloud_workflows.runs
    SET status = 'failed', error_message = normalized_error,
        completed_at = now(), updated_at = now(), row_version = row_version + 1
    WHERE id = current_step.run_id AND status = 'running';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
    END IF;
    INSERT INTO supacloud_workflows.events (
      run_id, step_id, event_type, attempt, details
    ) VALUES (
      current_step.run_id, current_step.id, 'step_dead_lettered', p_attempt,
      jsonb_build_object(
        'operation', 'retry',
        'messageId', p_message_id::text,
        'workerId', normalized_worker_id,
        'errorMessage', normalized_error,
        'delaySeconds', p_delay_seconds
      )
    );
    RETURN supacloud_workflows.snapshot(current_step.run_id, false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pgmq.set_vt('supacloud_internal_workflows', p_message_id, p_delay_seconds)
  ) INTO queue_message_updated;
  IF queue_message_updated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'queued', error_message = normalized_error,
      retry_delay_seconds = p_delay_seconds, updated_at = now()
  WHERE id = current_step.id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_retried', p_attempt,
    jsonb_build_object(
      'operation', 'retry',
      'messageId', p_message_id::text,
      'workerId', normalized_worker_id,
      'errorMessage', normalized_error,
      'delaySeconds', p_delay_seconds
    )
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.fail_step(
  p_step_id uuid,
  p_message_id bigint,
  p_attempt integer,
  p_worker_id text,
  p_error_message text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  current_step supacloud_workflows.steps%ROWTYPE;
  current_run supacloud_workflows.runs%ROWTYPE;
  normalized_error text := nullif(btrim(p_error_message), '');
  archived boolean;
BEGIN
  IF normalized_error IS NULL OR char_length(normalized_error) > 4000 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  current_step := supacloud_workflows.lock_step_attempt(
    p_step_id, p_message_id, p_attempt, p_worker_id
  );
  SELECT * INTO current_run
  FROM supacloud_workflows.runs
  WHERE id = current_step.run_id
  FOR UPDATE;

  IF current_step.status = 'failed' THEN
    IF current_step.error_message IS DISTINCT FROM normalized_error
       OR current_run.status IS DISTINCT FROM 'failed'
       OR current_run.error_message IS DISTINCT FROM normalized_error THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(current_step.run_id, true);
  END IF;
  IF current_step.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_STALE_ATTEMPT' USING ERRCODE = '40001';
  END IF;
  IF current_run.status <> 'running' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT pgmq.archive('supacloud_internal_workflows', p_message_id) INTO archived;
  IF archived IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_QUEUE_MESSAGE_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE supacloud_workflows.steps
  SET status = 'failed', error_message = normalized_error,
      completed_at = now(), updated_at = now()
  WHERE id = current_step.id;
  UPDATE supacloud_workflows.runs
  SET status = 'failed', error_message = normalized_error,
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = current_step.run_id AND status = 'running';
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, attempt, details
  ) VALUES (
    current_step.run_id, current_step.id, 'step_failed', p_attempt,
    jsonb_build_object('errorMessage', normalized_error)
  );
  RETURN supacloud_workflows.snapshot(current_step.run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.cancel_run(
  p_run_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_reason text := nullif(btrim(p_reason), '');
  locked_run supacloud_workflows.runs%ROWTYPE;
  active_step supacloud_workflows.steps%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR normalized_reason IS NULL OR char_length(normalized_reason) > 4000 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CANCEL_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id::text, 0));
  SELECT * INTO locked_run FROM supacloud_workflows.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF locked_run.status = 'cancelled' THEN
    IF locked_run.error_message IS DISTINCT FROM normalized_reason THEN
      RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_workflows.snapshot(p_run_id, true);
  END IF;
  IF locked_run.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RUN_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO active_step
  FROM supacloud_workflows.steps
  WHERE run_id = p_run_id AND status IN ('queued', 'running')
  FOR UPDATE;
  IF FOUND THEN
    PERFORM pgmq.archive('supacloud_internal_workflows', active_step.queue_message_id);
    UPDATE supacloud_workflows.steps
    SET status = 'cancelled', error_message = normalized_reason,
        completed_at = now(), updated_at = now()
    WHERE id = active_step.id;
  END IF;
  UPDATE supacloud_workflows.runs
  SET status = 'cancelled', error_message = normalized_reason,
      completed_at = now(), updated_at = now(), row_version = row_version + 1
  WHERE id = p_run_id;
  INSERT INTO supacloud_workflows.events (
    run_id, step_id, event_type, details
  ) VALUES (
    p_run_id, active_step.id, 'run_cancelled',
    jsonb_build_object('reason', normalized_reason)
  );
  RETURN supacloud_workflows.snapshot(p_run_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.run_events(
  p_run_id uuid,
  p_after_event_id bigint,
  p_limit integer
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'eventId', page.id::text,
    'runId', page.run_id,
    'stepId', page.step_id,
    'eventType', page.event_type,
    'attempt', page.attempt,
    'details', page.details,
    'createdAt', page.created_at
  ) ORDER BY page.id), '[]'::jsonb)
  FROM (
    SELECT event.*
    FROM supacloud_workflows.events event
    WHERE event.run_id = p_run_id AND event.id > p_after_event_id
    ORDER BY event.id
    LIMIT p_limit
  ) page
$$;

CREATE OR REPLACE FUNCTION supacloud_workflows.request_uuid(
  request jsonb,
  key text
) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  uuid_text text;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  uuid_text := request ->> key;
  IF uuid_text IS NULL
     OR uuid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN uuid_text::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_start(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  max_attempts integer;
BEGIN
  max_attempts := coalesce((request ->> 'maxAttempts')::integer, 3);
  RETURN supacloud_workflows.start_run(
    supacloud_workflows.request_uuid(request, 'runId'),
    request ->> 'workflowName',
    request ->> 'workflowVersion',
    request ->> 'firstStepKey',
    coalesce(request -> 'input', '{}'::jsonb),
    max_attempts
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_START_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_claim(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  visibility_timeout_seconds integer;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  visibility_timeout_seconds := coalesce((request ->> 'visibilityTimeoutSeconds')::integer, 300);
  RETURN supacloud_workflows.claim_step(
    request ->> 'workerId', visibility_timeout_seconds
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_advance(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
  next_max_attempts integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  next_max_attempts := coalesce((request ->> 'nextMaxAttempts')::integer, 3);
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.advance_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    coalesce(request -> 'output', '{}'::jsonb),
    request ->> 'nextStepKey',
    coalesce(request -> 'nextInput', '{}'::jsonb),
    next_max_attempts
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_ADVANCE_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_complete(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.complete_run(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    coalesce(request -> 'stepOutput', '{}'::jsonb),
    coalesce(request -> 'runOutput', '{}'::jsonb)
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_COMPLETION_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_retry(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
  delay_seconds integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  delay_seconds := coalesce((request ->> 'delaySeconds')::integer, 0);
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.retry_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    request ->> 'errorMessage',
    delay_seconds
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_RETRY_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_fail(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  message_id bigint;
  attempt integer;
BEGIN
  message_id := (request ->> 'messageId')::bigint;
  attempt := (request ->> 'attempt')::integer;
  IF message_id <= 0 OR attempt <= 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.fail_step(
    supacloud_workflows.request_uuid(request, 'stepId'),
    message_id,
    attempt,
    request ->> 'workerId',
    request ->> 'errorMessage'
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_FAILURE_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_cancel(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_workflows.cancel_run(
    supacloud_workflows.request_uuid(request, 'runId'),
    request ->> 'reason'
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_CANCEL_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_get(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_workflows.snapshot(
    supacloud_workflows.request_uuid(request, 'runId'), false
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_workflow_events(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  after_event_id bigint;
  event_limit integer;
BEGIN
  after_event_id := coalesce((request ->> 'afterEventId')::bigint, 0);
  event_limit := coalesce((request ->> 'limit')::integer, 100);
  IF after_event_id < 0 OR event_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_EVENTS_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN supacloud_workflows.run_events(
    supacloud_workflows.request_uuid(request, 'runId'), after_event_id, event_limit
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_WORKFLOW_EVENTS_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_workflows
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.supacloud_workflow_start(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_claim(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_advance(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_complete(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_retry(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_fail(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_cancel(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_get(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_workflow_events(jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.supacloud_workflow_start(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_claim(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_advance(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_complete(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_retry(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_fail(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_cancel(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_get(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_workflow_events(jsonb) TO service_role;
