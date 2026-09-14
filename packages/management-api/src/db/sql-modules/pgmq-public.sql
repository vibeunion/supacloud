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
BEGIN
  IF queue_name IS NULL OR queue_name !~ '^[a-z0-9][a-z0-9_-]{0,127}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_NAME_INVALID' USING ERRCODE = '22023';
  END IF;
  IF left(queue_name, char_length('supacloud_internal_')) = 'supacloud_internal_' THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_NAME_RESERVED' USING ERRCODE = '42501';
  END IF;
  RETURN queue_name;
END;
$$;

-- Return-type changes require replacement. Do not CASCADE through user dependencies.
DO $pgmq_receipt_types$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('pgmq_public.send(text,jsonb,integer)')
      AND prorettype = 'bigint'::regtype
  ) THEN
    DROP FUNCTION pgmq_public.send(text,jsonb,integer);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('pgmq_public.send_batch(text,jsonb[],integer)')
      AND prorettype = 'bigint'::regtype
  ) THEN
    DROP FUNCTION pgmq_public.send_batch(text,jsonb[],integer);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('pgmq_public.read(text,integer,integer)')
      AND prorettype = 'pgmq.message_record'::regtype
  ) THEN
    DROP FUNCTION pgmq_public.read(text,integer,integer);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('pgmq_public.pop(text)')
      AND prorettype = 'pgmq.message_record'::regtype
  ) THEN
    DROP FUNCTION pgmq_public.pop(text);
  END IF;
END
$pgmq_receipt_types$;

CREATE OR REPLACE FUNCTION pgmq_public.require_seconds(value integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF value IS NULL OR value < 0 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_SECONDS_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.require_read_count(value integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF value IS NULL OR value < 1 OR value > 10000 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_COUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.require_message_id(value bigint)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  IF value IS NULL OR value < 1 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_MESSAGE_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.message_node_count(value jsonb)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  node_count integer;
  maximum_depth integer;
BEGIN
  IF value IS NULL THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_MESSAGE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF octet_length(convert_to(value::text, 'UTF8')) > 1048576 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_PAYLOAD_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  WITH RECURSIVE tree(item, depth) AS (
    SELECT value, 0
    UNION ALL
    SELECT child.item, tree.depth + 1
    FROM tree
    CROSS JOIN LATERAL (
      SELECT element AS item
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tree.item) = 'array' THEN tree.item ELSE '[]'::jsonb END) AS element
      UNION ALL
      SELECT entry.value AS item
      FROM jsonb_each(CASE WHEN jsonb_typeof(tree.item) = 'object' THEN tree.item ELSE '{}'::jsonb END) AS entry
    ) AS child
    WHERE tree.depth < 65
  )
  SELECT count(*)::integer, max(depth) INTO node_count, maximum_depth
  FROM (SELECT depth FROM tree LIMIT 10001) AS bounded;
  IF node_count > 10000 OR maximum_depth > 64 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_STRUCTURE_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  RETURN node_count;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.require_message(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
  PERFORM pgmq_public.message_node_count(value);
  RETURN value;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.require_messages(values_ jsonb[])
RETURNS jsonb[] LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  item jsonb;
  total_bytes bigint := 0;
  total_nodes integer := 0;
BEGIN
  IF values_ IS NULL OR cardinality(values_) < 1 OR cardinality(values_) > 10000
     OR array_ndims(values_) <> 1 OR array_lower(values_, 1) <> 1 THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_BATCH_INVALID' USING ERRCODE = '22023';
  END IF;
  FOREACH item IN ARRAY values_ LOOP
    total_nodes := total_nodes + pgmq_public.message_node_count(item);
    IF total_nodes > 100000 THEN
      RAISE EXCEPTION 'SUPACLOUD_QUEUE_STRUCTURE_TOO_LARGE' USING ERRCODE = '22023';
    END IF;
    total_bytes := total_bytes + octet_length(convert_to(item::text, 'UTF8'));
    IF total_bytes > 8388608 THEN
      RAISE EXCEPTION 'SUPACLOUD_QUEUE_PAYLOAD_TOO_LARGE' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN values_;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT receipt.msg_id::text FROM pgmq.send(pgmq_public.require_public_queue(queue_name), pgmq_public.require_message(message), pgmq_public.require_seconds(sleep_seconds)) AS receipt(msg_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT receipt.msg_id::text FROM pgmq.send_batch(pgmq_public.require_public_queue(queue_name), pgmq_public.require_messages(messages), pgmq_public.require_seconds(sleep_seconds)) AS receipt(msg_id); $$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS TABLE (
  msg_id text, read_ct integer, enqueued_at timestamptz,
  last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT receipt.msg_id::text, receipt.read_ct, receipt.enqueued_at,
    (to_jsonb(receipt)->>'last_read_at')::timestamptz, receipt.vt,
    receipt.message, to_jsonb(receipt)->'headers'
  FROM pgmq.read(pgmq_public.require_public_queue(queue_name),
    pgmq_public.require_seconds(sleep_seconds), pgmq_public.require_read_count(n)) AS receipt;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS TABLE (
  msg_id text, read_ct integer, enqueued_at timestamptz,
  last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT receipt.msg_id::text, receipt.read_ct, receipt.enqueued_at,
    (to_jsonb(receipt)->>'last_read_at')::timestamptz, receipt.vt,
    receipt.message, to_jsonb(receipt)->'headers'
  FROM pgmq.pop(pgmq_public.require_public_queue(queue_name)) AS receipt;
$$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.archive(pgmq_public.require_public_queue(queue_name), pgmq_public.require_message_id(message_id)); $$;

CREATE OR REPLACE FUNCTION pgmq_public."delete"(queue_name text, message_id bigint)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT pgmq.delete(pgmq_public.require_public_queue(queue_name), pgmq_public.require_message_id(message_id)); $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
