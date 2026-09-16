-- Database-only fixture of the Realtime broadcast contract. No transport service.
-- realtime.send implementation: Supabase Realtime (Apache-2.0), v2.134.10,
-- lib/realtime/tenants/repo/migrations/20250128220012_realtime_send_sets_topic_config.ex
-- This persists real events; it is deliberately not a no-op compatibility stub.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload jsonb, event text, topic text, private boolean,
  extension text, inserted_at timestamptz DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
    INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES (payload, event, topic, private, 'broadcast');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_notify('realtime:system', jsonb_build_object(
      'error', SQLERRM, 'function', 'realtime.send', 'event', event,
      'topic', topic, 'private', private
    )::text);
  END;
END;
$$;
