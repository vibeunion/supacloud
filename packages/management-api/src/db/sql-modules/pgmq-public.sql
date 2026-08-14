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
