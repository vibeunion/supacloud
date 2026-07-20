CREATE OR REPLACE FUNCTION realtime.notify_change_payload(payload jsonb)
RETURNS void AS $fn$
DECLARE
  payload_text text := payload::text;
BEGIN
  IF pg_catalog.octet_length(payload_text) >= 8000 THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM pg_catalog.pg_notify('realtime_changes', payload_text);
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN;
  END;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;
