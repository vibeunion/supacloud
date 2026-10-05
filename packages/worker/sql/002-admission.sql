CREATE TABLE supacloud_worker.admission_limits (
  group_name text PRIMARY KEY CHECK (group_name ~ '^[a-z][a-z0-9-]{0,47}$'),
  max_outstanding integer NOT NULL CHECK (max_outstanding BETWEEN 1 AND 1000000),
  outstanding integer NOT NULL DEFAULT 0 CHECK (outstanding >= 0),
  accepting boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE supacloud_worker.admission_tokens (
  group_name text NOT NULL REFERENCES supacloud_worker.admission_limits(group_name),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_.:@/-]{1,200}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  released boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (group_name, operation_id)
);
CREATE INDEX admission_held ON supacloud_worker.admission_tokens(group_name) WHERE NOT released;
REVOKE ALL ON supacloud_worker.admission_limits, supacloud_worker.admission_tokens FROM PUBLIC;

-- Deployment operators provision limits. Runtime callers cannot raise their quota.
CREATE FUNCTION supacloud_worker.admit_operation(
  project text, group_id text, operation text, input_fingerprint text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE quota supacloud_worker.admission_limits; token supacloud_worker.admission_tokens;
BEGIN
  IF NOT EXISTS (SELECT FROM supacloud_worker.installation WHERE project_ref=project AND singleton) THEN
    RAISE EXCEPTION 'WORKER_PROJECT_MISMATCH';
  END IF;
  SELECT * INTO quota FROM supacloud_worker.admission_limits WHERE group_name=group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_UNCONFIGURED'; END IF;
  SELECT * INTO token FROM supacloud_worker.admission_tokens WHERE group_name=group_id AND operation_id=operation;
  IF FOUND THEN
    IF token.fingerprint IS DISTINCT FROM input_fingerprint THEN RAISE EXCEPTION 'WORKER_OPERATION_CONFLICT'; END IF;
    RETURN false;
  END IF;
  IF NOT quota.accepting THEN RAISE EXCEPTION 'WORKER_ADMISSION_PAUSED'; END IF;
  IF quota.outstanding >= quota.max_outstanding THEN RAISE EXCEPTION 'WORKER_ADMISSION_LIMIT'; END IF;
  INSERT INTO supacloud_worker.admission_tokens(group_name,operation_id,fingerprint)
    VALUES(group_id,operation,input_fingerprint);
  UPDATE supacloud_worker.admission_limits SET outstanding=outstanding+1,updated_at=clock_timestamp()
    WHERE group_name=group_id;
  RETURN true;
END
$function$;

CREATE FUNCTION supacloud_worker.release_operation(project text, group_id text, operation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE changed integer;
BEGIN
  IF NOT EXISTS (SELECT FROM supacloud_worker.installation WHERE project_ref=project AND singleton) THEN
    RAISE EXCEPTION 'WORKER_PROJECT_MISMATCH';
  END IF;
  PERFORM 1 FROM supacloud_worker.admission_limits WHERE group_name=group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKER_ADMISSION_UNCONFIGURED'; END IF;
  UPDATE supacloud_worker.admission_tokens SET released=true
    WHERE group_name=group_id AND operation_id=operation AND NOT released;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed=1 THEN
    UPDATE supacloud_worker.admission_limits SET outstanding=outstanding-1,updated_at=clock_timestamp()
      WHERE group_name=group_id;
  ELSIF NOT EXISTS(SELECT FROM supacloud_worker.admission_tokens WHERE group_name=group_id AND operation_id=operation) THEN
    RAISE EXCEPTION 'WORKER_OPERATION_MISSING';
  END IF;
END
$function$;

-- Read-only reconciliation detects drift without guessing domain terminal state.
CREATE VIEW supacloud_worker.admission_reconciliation AS
SELECT l.group_name,l.max_outstanding,l.outstanding,
  (SELECT count(*) FROM supacloud_worker.admission_tokens t
    WHERE t.group_name=l.group_name AND NOT t.released) AS held
FROM supacloud_worker.admission_limits l;
REVOKE ALL ON supacloud_worker.admission_reconciliation FROM PUBLIC;
REVOKE ALL ON FUNCTION supacloud_worker.admit_operation(text,text,text,text),
  supacloud_worker.release_operation(text,text,text) FROM PUBLIC;
