/**
 * Pure-SQL emulations of Supabase's queue and cron extensions, so migrations
 * and app code that call pgmq.* / cron.* work with no C extension on either
 * engine. pgmq is fully self-contained SQL. cron records jobs here; the
 * in-process CronService (src/cron/service.ts) executes them.
 *
 * These match the real extensions' function signatures closely enough that
 * `pgmq.send(...)`, `pgmq.read(...)`, `select cron.schedule(...)` etc. behave
 * the same from the client's and a migration's point of view.
 */

// ── pgmq (message queue) ────────────────────────────────────────────────────

/**
 * Self-contained SQL emulation of the pgmq extension: per-queue `q_<name>` /
 * `a_<name>` tables plus create/send/read/pop/delete/archive/etc functions,
 * matching pgmq's signatures. No C extension, no background worker needed.
 */
export const PGMQ_SQL = `
create schema if not exists pgmq;
revoke all on schema pgmq from public, anon, authenticated;
grant usage on schema pgmq to service_role;

create table if not exists pgmq.meta (
  queue_name text primary key,
  physical_name text not null unique,
  is_partitioned boolean not null default false,
  is_unlogged boolean not null default false,
  created_at timestamptz not null default now()
);

-- Preserve queues created by older Lite versions. Their physical names were
-- the queue names, so only the already-truncated identifier can be recovered.
insert into pgmq.meta (queue_name, physical_name)
select substring(tablename from 3), substring(tablename from 3)
from pg_tables
where schemaname = 'pgmq' and left(tablename, 2) = 'q_'
on conflict do nothing;

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'message_record' and n.nspname = 'pgmq') then
    create type pgmq.message_record as (
      msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb
    );
  end if;
end $$;

create or replace function pgmq._normalize_queue_name(queue_name text)
returns text language plpgsql immutable set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := btrim(queue_name);
begin
  if normalized is null or normalized !~ '^[a-z0-9][a-z0-9_-]{0,127}$' then
    raise exception 'invalid queue name: must match ^[a-z0-9][a-z0-9_-]{0,127}$'
      using errcode = '22023';
  end if;
  return normalized;
end $pgmq$;

-- PostgreSQL identifiers are limited to 63 bytes. Keep the conventional table
-- name for short queues and add a deterministic hash for valid 62-128 byte
-- public names so truncation can never merge two queues.
create or replace function pgmq._physical_queue_name(queue_name text)
returns text language sql immutable set search_path = pgmq, pg_catalog, public as $pgmq$
  select case when length(normalized) <= 61 then normalized
    else left(normalized, 28) || '_' || md5(normalized) end
  from (select pgmq._normalize_queue_name(queue_name) as normalized) names;
$pgmq$;

create or replace function pgmq._resolve_queue(queue_name text)
returns text language plpgsql stable security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text;
begin
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  if physical is null then
    raise exception 'queue "%" does not exist', normalized using errcode = '42P01';
  end if;
  return physical;
end $pgmq$;

create or replace function pgmq.create(queue_name text) returns void language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text := pgmq._physical_queue_name(queue_name);
begin
  insert into pgmq.meta (queue_name, physical_name) values (normalized, physical)
  on conflict do nothing;
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  execute format('create table if not exists pgmq.%I (
    msg_id bigint generated always as identity primary key,
    read_ct integer not null default 0,
    enqueued_at timestamptz not null default now(),
    vt timestamptz not null default now(),
    message jsonb)', 'q_' || physical);
  execute format('create table if not exists pgmq.%I (
    msg_id bigint primary key, read_ct integer not null default 0,
    enqueued_at timestamptz not null, archived_at timestamptz not null default now(),
    vt timestamptz, message jsonb)', 'a_' || physical);
end $pgmq$;

create or replace function pgmq.send(queue_name text, msg jsonb, delay integer default 0)
returns bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare id bigint; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('insert into pgmq.%I (vt, message) values (now() + make_interval(secs => $1), $2) returning msg_id', 'q_' || physical)
    into id using delay, msg;
  return id;
end $pgmq$;

create or replace function pgmq.send_batch(queue_name text, msgs jsonb[], delay integer default 0)
returns setof bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare queue_message jsonb;
begin
  perform pgmq._resolve_queue(queue_name);
  foreach queue_message in array msgs loop
    return next pgmq.send(queue_name, queue_message, delay);
  end loop;
end $pgmq$;

create or replace function pgmq.read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    with cte as (
      select msg_id from pgmq.%I where vt <= now() order by msg_id limit $1 for update skip locked
    )
    update pgmq.%I m set vt = now() + make_interval(secs => $2), read_ct = read_ct + 1
    from cte where m.msg_id = cte.msg_id
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical, 'q_' || physical) using qty, vt;
end $pgmq$;

create or replace function pgmq.pop(queue_name text)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    with cte as (select msg_id from pgmq.%I where vt <= now() order by msg_id limit 1 for update skip locked)
    delete from pgmq.%I m using cte where m.msg_id = cte.msg_id
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical, 'q_' || physical);
end $pgmq$;

create or replace function pgmq.set_vt(queue_name text, msg_id bigint, vt_offset integer)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    update pgmq.%I m set vt = now() + make_interval(secs => $1)
    where m.msg_id = $2
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical) using vt_offset, msg_id;
end $pgmq$;

create or replace function pgmq.delete(queue_name text, msg_id bigint)
returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n integer; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('delete from pgmq.%I where msg_id = $1', 'q_' || physical) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end $pgmq$;

create or replace function pgmq.archive(queue_name text, msg_id bigint)
returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n integer; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format($fmt$
    with del as (delete from pgmq.%I where msg_id = $1 returning *)
    insert into pgmq.%I (msg_id, read_ct, enqueued_at, vt, message)
    select msg_id, read_ct, enqueued_at, vt, message from del
  $fmt$, 'q_' || physical, 'a_' || physical) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end $pgmq$;

create or replace function pgmq.drop_queue(queue_name text) returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text;
begin
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  if physical is null then return false; end if;
  execute format('drop table if exists pgmq.%I', 'q_' || physical);
  execute format('drop table if exists pgmq.%I', 'a_' || physical);
  delete from pgmq.meta where pgmq.meta.queue_name = normalized;
  return true;
end $pgmq$;

create or replace function pgmq.purge_queue(queue_name text) returns bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n bigint; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('delete from pgmq.%I', 'q_' || physical);
  get diagnostics n = row_count;
  return n;
end $pgmq$;

create or replace function pgmq.list_queues()
returns table(queue_name text, is_partitioned boolean, is_unlogged boolean, created_at timestamptz)
language sql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
  select queue_name, is_partitioned, is_unlogged, created_at from pgmq.meta;
$pgmq$;

revoke all on all functions in schema pgmq from public, anon, authenticated;
grant execute on all functions in schema pgmq to service_role;

-- supacloud:sql-module:pgmq-public:start
DO $pgmq_extension$
BEGIN
  IF to_regprocedure('pgmq.send(text,jsonb,integer)') IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgmq';
  END IF;
END
$pgmq_extension$;

CREATE SCHEMA IF NOT EXISTS pgmq_public;
GRANT USAGE ON SCHEMA pgmq_public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION pgmq_public.require_public_queue(queue_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  normalized_queue_name text := lower(btrim(queue_name));
BEGIN
  IF normalized_queue_name IS NULL
     OR left(normalized_queue_name, char_length('supacloud_internal_')) = 'supacloud_internal_' THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_NAME_RESERVED' USING ERRCODE = '42501';
  END IF;
  RETURN normalized_queue_name;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.send(pgmq_public.require_public_queue(queue_name), message, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.send_batch(pgmq_public.require_public_queue(queue_name), messages, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.read(pgmq_public.require_public_queue(queue_name), sleep_seconds, n); $$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT * FROM pgmq.pop(pgmq_public.require_public_queue(queue_name)); $$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.archive(pgmq_public.require_public_queue(queue_name), message_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.delete(pgmq_public.require_public_queue(queue_name), message_id); $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role;
-- supacloud:sql-module:pgmq-public:end
`

export const WORKFLOWS_SQL = `
-- supacloud:sql-module:workflows-public:start
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
-- supacloud:sql-module:workflows-public:end
`

// ── cron (scheduled jobs) ────────────────────────────────────────────────────

/**
 * pg_cron emulation: the `cron.job` / `cron.job_run_details` tables and
 * schedule/unschedule functions. This only records jobs; the in-process
 * CronService (src/cron/service.ts) reads the table and runs them.
 */
export const CRON_SQL = `
create schema if not exists cron;
-- cron.schedule executes arbitrary SQL as the (superuser) function owner, so it
-- must stay restricted to service_role - matching hosted Supabase, where
-- authenticated cannot schedule jobs.
grant usage on schema cron to service_role;

create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  jobname text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists cron.job_run_details (
  runid bigint generated always as identity primary key,
  jobid bigint,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid into id;
  return id;
end $cron$;

create or replace function cron.schedule(schedule text, command text)
returns bigint language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
begin
  return cron.schedule('job_' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text, schedule, command);
end $cron$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare n integer;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics n = row_count;
  return n > 0;
end $cron$;

create or replace function cron.unschedule(job_id bigint)
returns boolean language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare n integer;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics n = row_count;
  return n > 0;
end $cron$;

grant execute on function cron.schedule(text,text,text), cron.schedule(text,text), cron.unschedule(text), cron.unschedule(bigint) to service_role;
`

/**
 * pg_net emulation - the `net.http_get/post/delete` SQL surface. The functions
 * only enqueue into net.http_request_queue; the in-process NetService
 * (src/net/service.ts) performs the HTTP and records the reply in
 * net._http_response, exactly like pg_net's background worker. This lets the
 * common Supabase pattern - a cron job that calls net.http_post to hit an Edge
 * Function - run unchanged, with no C extension on either engine.
 */
export const NET_SQL = `
create schema if not exists net;
-- net.http_* can reach arbitrary URLs from the server (SSRF surface), so keep it
-- restricted to service_role like hosted Supabase - not authenticated.
grant usage on schema net to service_role;

create table if not exists net.http_request_queue (
  id bigint generated always as identity primary key,
  method text not null,
  url text not null,
  headers jsonb not null default '{}'::jsonb,
  body text,
  timeout_milliseconds int not null default 5000,
  created timestamptz not null default now()
);

create table if not exists net._http_response (
  id bigint primary key,
  status_code int,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);
grant select on net._http_response to service_role;

-- fold a jsonb param object into the URL as a query string (pg_net semantics)
create or replace function net._merge_params(url text, params jsonb)
returns text language sql immutable as $net$
  select case
    when params is null or params = '{}'::jsonb then url
    else url || (case when position('?' in url) > 0 then '&' else '?' end) ||
      (select string_agg(key || '=' || (value #>> '{}'), '&') from jsonb_each(params))
  end;
$net$;

create or replace function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('GET', net._merge_params(url, params), coalesce(headers, '{}'::jsonb), null, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint; hdrs jsonb;
begin
  hdrs := coalesce(headers, '{}'::jsonb);
  -- default the content type to JSON, matching pg_net, unless the caller set one
  if not (hdrs ? 'Content-Type' or hdrs ? 'content-type') then
    hdrs := hdrs || jsonb_build_object('Content-Type', 'application/json');
  end if;
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', net._merge_params(url, params), hdrs, body::text, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

create or replace function net.http_delete(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('DELETE', net._merge_params(url, params), coalesce(headers, '{}'::jsonb), null, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

grant execute on function net.http_get(text,jsonb,jsonb,int), net.http_post(text,jsonb,jsonb,jsonb,int), net.http_delete(text,jsonb,jsonb,int) to service_role;
`

/**
 * Small pure-SQL stand-ins for contrib extensions Supabase migrations lean on
 * but which aren't in the PGlite / native builds. `moddatetime` (a BEFORE
 * UPDATE trigger that stamps a timestamp column) is the common one - projects
 * attach it as the updated_at trigger. Created only if absent, so a real
 * extension (where present) still wins.
 */
export const EXT_COMPAT_SQL = `
create schema if not exists extensions;
do $ensure_moddatetime$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'moddatetime'
  ) then
    execute $fn$
      create function extensions.moddatetime() returns trigger language plpgsql as $mod$
      begin
        if TG_NARGS >= 1 then
          NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
        end if;
        return NEW;
      end
      $mod$
    $fn$;
  end if;
end
$ensure_moddatetime$;
`

/**
 * Supabase Vault emulation. Real Vault (supabase_vault + pgsodium) encrypts
 * secrets at rest; we can't ship those C extensions. This stand-in keeps the
 * same surface (vault.secrets, vault.decrypted_secrets, vault.create_secret /
 * update_secret) but stores the secret encrypted with pgcrypto's authenticated
 * symmetric encryption (pgp_sym_encrypt) under a key held in the GUC
 * app.settings.vault_key, set at boot and never stored in the database.
 *
 * SECURITY: the stored `secret` column holds ciphertext; decrypted_secrets
 * decrypts on read. If pgcrypto or the key is unavailable the functions raise,
 * rather than silently falling back to cleartext.
 */
export const VAULT_SQL = `
create schema if not exists vault;
grant usage on schema vault to service_role;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on vault.secrets to service_role;

-- the encryption key, from the GUC set at boot (empty string if unset)
create or replace function vault._key() returns text
language sql stable as $vault$
  select coalesce(nullif(current_setting('app.settings.vault_key', true), ''), '')
$vault$;

create or replace function vault._encrypt(plain text) returns text
language plpgsql security definer set search_path = vault, extensions, pg_catalog, public as $vault$
declare k text := vault._key();
begin
  if plain is null then return null; end if;
  if k = '' then raise exception 'vault key is not configured'; end if;
  return encode(pgp_sym_encrypt(plain, k), 'base64');
end $vault$;

create or replace function vault._decrypt(cipher text) returns text
language plpgsql security definer set search_path = vault, extensions, pg_catalog, public as $vault$
declare k text := vault._key();
begin
  if cipher is null then return null; end if;
  if k = '' then raise exception 'vault key is not configured'; end if;
  return pgp_sym_decrypt(decode(cipher, 'base64'), k);
end $vault$;

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, vault._decrypt(secret) as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;
grant select on vault.decrypted_secrets to service_role;

create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = vault, pg_catalog, public as $vault$
declare rec_id uuid;
begin
  insert into vault.secrets (name, description, secret, key_id)
  values (new_name, coalesce(new_description, ''), vault._encrypt(new_secret), new_key_id)
  returning id into rec_id;
  return rec_id;
end $vault$;

create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql security definer set search_path = vault, pg_catalog, public as $vault$
begin
  update vault.secrets set
    secret = case when new_secret is null then secret else vault._encrypt(new_secret) end,
    name = coalesce(new_name, name),
    description = coalesce(new_description, description),
    key_id = coalesce(new_key_id, key_id),
    updated_at = now()
  where id = secret_id;
end $vault$;

grant execute on function vault.create_secret(text,text,text,uuid), vault.update_secret(uuid,text,text,text,uuid) to service_role;
`
