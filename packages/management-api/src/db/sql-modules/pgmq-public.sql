CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE SCHEMA IF NOT EXISTS pgmq_public;
GRANT USAGE ON SCHEMA pgmq_public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.send(queue_name, message, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.send_batch(queue_name, messages, sleep_seconds); $$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.read(queue_name, sleep_seconds, n); $$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT * FROM pgmq.pop(queue_name); $$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT pgmq.archive(queue_name, message_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pgmq, public
AS $$ SELECT pgmq.delete(queue_name, message_id); $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role;
