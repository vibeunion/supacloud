-- Additive SupaCloud extension; official send/read/archive/delete contracts stay unchanged.
CREATE OR REPLACE FUNCTION pgmq_public.send_idempotent(
  queue_name text, message jsonb, p_job_key text, sleep_seconds integer DEFAULT 0
)
RETURNS TABLE (msg_id text, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_queue text := pgmq_public.require_public_queue(queue_name);
  captured_message jsonb := pgmq_public.require_message(message);
  captured_delay integer := pgmq_public.require_seconds(sleep_seconds);
  inserted boolean;
  sent_id bigint;
  existing_id bigint;
  existing_message jsonb;
  existing_delay integer;
BEGIN
  IF p_job_key IS NULL OR p_job_key !~ '^[A-Za-z0-9_.:@/-]{1,200}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_QUEUE_JOB_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO supacloud_queue.job_keys(queue_name, job_key, msg_id, message, sleep_seconds)
  VALUES (normalized_queue, p_job_key, 0, captured_message, captured_delay)
  ON CONFLICT ON CONSTRAINT job_keys_pkey DO NOTHING;
  inserted := FOUND;
  IF NOT inserted THEN
    SELECT keys.msg_id, keys.message, keys.sleep_seconds
      INTO existing_id, existing_message, existing_delay
    FROM supacloud_queue.job_keys AS keys
    WHERE keys.queue_name = normalized_queue AND keys.job_key = p_job_key;
    IF existing_id IS NULL OR existing_id < 1 THEN
      RAISE EXCEPTION 'SUPACLOUD_QUEUE_JOB_KEY_UNAVAILABLE' USING ERRCODE = '55000';
    END IF;
    IF existing_message IS DISTINCT FROM captured_message OR existing_delay IS DISTINCT FROM captured_delay THEN
      RAISE EXCEPTION 'SUPACLOUD_QUEUE_JOB_KEY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    -- This is a durable enqueue receipt, not evidence that the message is still pending.
    RETURN QUERY SELECT existing_id::text, false;
    RETURN;
  END IF;
  SELECT receipt.msg_id INTO STRICT sent_id
  FROM pgmq.send(normalized_queue, captured_message, captured_delay) AS receipt(msg_id);
  PERFORM pgmq_public.require_message_id(sent_id);
  UPDATE supacloud_queue.job_keys AS keys SET msg_id = sent_id
  WHERE keys.queue_name = normalized_queue AND keys.job_key = p_job_key;
  RETURN QUERY SELECT sent_id::text, true;
END;
$$;

