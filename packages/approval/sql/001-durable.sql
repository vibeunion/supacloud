-- Install as database administrator in pg_durable.database.
-- This module owns generic approval facts, never application signing/report facts.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_durable' AND extversion='0.2.8')
    OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_jsonschema') THEN
    RAISE EXCEPTION 'Required extensions: pg_durable 0.2.8 and pg_jsonschema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_owner') THEN
    CREATE ROLE supacloud_approval_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_service') THEN
    CREATE ROLE supacloud_approval_service NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_owner'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'Approval owner must be a restricted non-superuser LOGIN role';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS approval AUTHORIZATION supacloud_approval_owner;
REVOKE ALL ON SCHEMA approval FROM PUBLIC;
SELECT df.grant_usage('supacloud_approval_owner');
-- Locate pg_jsonschema without assuming it is installed in public.
DO $$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_jsonschema';
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO supacloud_approval_owner', extension_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.jsonb_matches_schema(json,jsonb) TO supacloud_approval_owner', extension_schema);
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION approval.valid_definition(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_DEFINITION_SCHEMA__'::json, value)
    $body$
  $fn$, extension_schema);
END $$;
ALTER FUNCTION approval.valid_definition(jsonb) OWNER TO supacloud_approval_owner;
SET LOCAL ROLE supacloud_approval_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA approval REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS approval.definitions (
  tenant text NOT NULL CHECK (tenant ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (octet_length(definition::text)<=262144 AND approval.valid_definition(definition)),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant,key,version)
);
CREATE OR REPLACE FUNCTION approval.protect_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'APPROVAL_DEFINITION_IMMUTABLE'; END IF;
  IF (SELECT count(*) <> count(DISTINCT step->>'key')
      FROM jsonb_array_elements(NEW.definition->'steps') step) THEN
    RAISE EXCEPTION 'APPROVAL_DUPLICATE_STEP';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER protect_definition BEFORE INSERT OR UPDATE OR DELETE ON approval.definitions
  FOR EACH ROW EXECUTE FUNCTION approval.protect_definition();

CREATE TABLE IF NOT EXISTS approval.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL,
  definition_key text NOT NULL,
  definition_version integer NOT NULL,
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
  requester text NOT NULL CHECK (requester ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','timed_out')),
  step_index integer NOT NULL DEFAULT 0,
  row_version bigint NOT NULL DEFAULT 1,
  deadline timestamptz NOT NULL,
  engine_id text UNIQUE,
  wait_token uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (tenant,id),
  FOREIGN KEY (tenant,definition_key,definition_version) REFERENCES approval.definitions(tenant,key,version)
);
ALTER TABLE approval.runs ADD COLUMN IF NOT EXISTS wait_token uuid;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_approval
  ON approval.runs(tenant,definition_key,entity_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS approval.tasks (
  tenant text NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  actor text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason)<=4000),
  decided_at timestamptz,
  PRIMARY KEY (tenant,run_id,step_index,actor),
  FOREIGN KEY (tenant,run_id) REFERENCES approval.runs(tenant,id)
);
CREATE TABLE IF NOT EXISTS approval.receipts (
  tenant text NOT NULL,
  request_id uuid NOT NULL,
  command jsonb NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (tenant,request_id)
);
CREATE TABLE IF NOT EXISTS approval.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant text NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL,
  actor text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant,run_id) REFERENCES approval.runs(tenant,id)
);
CREATE INDEX IF NOT EXISTS approval_events_by_run ON approval.events(tenant,run_id,id);
-- Pending notification intent commits atomically with the domain decision.
CREATE TABLE IF NOT EXISTS approval.wakeups (
  tenant text NOT NULL,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  engine_id text,
  target_engine_id text,
  delivered_at timestamptz,
  PRIMARY KEY (tenant,request_id),
  FOREIGN KEY (tenant,run_id) REFERENCES approval.runs(tenant,id)
);
ALTER TABLE approval.wakeups ADD COLUMN IF NOT EXISTS target_engine_id text;
CREATE INDEX IF NOT EXISTS approval_pending_wakeups ON approval.wakeups(tenant,run_id) WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION approval.get_run(p_tenant text,p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object('id',r.id,'tenant',r.tenant,'entityId',r.entity_id,'status',r.status,
    'stepIndex',r.step_index,'rowVersion',r.row_version::text,'deadline',r.deadline,
    'engineId',r.engine_id,'tasks',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'stepIndex',t.step_index,'actor',t.actor,'status',t.status,'reason',t.reason)
      ORDER BY t.step_index,t.actor) FROM approval.tasks t WHERE t.tenant=p_tenant AND t.run_id=p_run),'[]'::jsonb))
    INTO result FROM approval.runs r WHERE r.tenant=p_tenant AND r.id=p_run;
  IF result IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION approval.replay(p_tenant text,p_request uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE saved approval.receipts;
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_request IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_IDENTITY';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_request::text,0));
  SELECT * INTO saved FROM approval.receipts WHERE tenant=p_tenant AND request_id=p_request;
  IF FOUND THEN
    IF saved.command <> p_command THEN RAISE EXCEPTION 'APPROVAL_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN saved.receipt;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION approval.advance(p_tenant text,p_run uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r approval.runs; d jsonb; step jsonb; outcome text; approved integer; remaining integer;
BEGIN
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.status<>'pending' THEN RETURN false; END IF;
  SELECT definition INTO d FROM approval.definitions
    WHERE tenant=r.tenant AND key=r.definition_key AND version=r.definition_version;
  step := d->'steps'->r.step_index;
  SELECT count(*) FILTER (WHERE status='approved'),count(*) FILTER (WHERE status='pending')
    INTO approved,remaining FROM approval.tasks
    WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
  -- Decisions accepted before the deadline remain valid if the worker resumes late.
  IF EXISTS (SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
      AND step_index=r.step_index AND status='rejected') THEN outcome := 'rejected';
  ELSIF approved>0 AND (step->>'mode'='any' OR remaining=0) THEN
    UPDATE approval.tasks SET status='cancelled' WHERE tenant=p_tenant AND run_id=p_run
      AND step_index=r.step_index AND status='pending';
    IF r.step_index+1=jsonb_array_length(d->'steps') THEN outcome := 'approved';
    ELSE
      r.step_index := r.step_index+1;
      step := d->'steps'->r.step_index;
      UPDATE approval.runs SET step_index=r.step_index,row_version=row_version+1,
        deadline=clock_timestamp()+make_interval(secs=>(step->>'timeoutSeconds')::integer)
        WHERE id=p_run;
      INSERT INTO approval.tasks(tenant,run_id,step_index,actor)
        SELECT p_tenant,p_run,r.step_index,jsonb_array_elements_text(step->'approvers');
      INSERT INTO approval.events(tenant,run_id,kind,detail)
        VALUES(p_tenant,p_run,'step_opened',jsonb_build_object('stepIndex',r.step_index));
      PERFORM approval.schedule_wait(p_tenant,p_run);
    END IF;
  ELSIF clock_timestamp()>=r.deadline THEN outcome := 'timed_out';
  END IF;
  IF outcome IS NOT NULL THEN
    UPDATE approval.runs SET status=outcome,finished_at=clock_timestamp(),row_version=row_version+1 WHERE id=p_run;
    UPDATE approval.tasks SET status='cancelled' WHERE tenant=p_tenant AND run_id=p_run AND status='pending';
    INSERT INTO approval.events(tenant,run_id,kind) VALUES(p_tenant,p_run,outcome);
    RETURN false;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.schedule_wait(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r approval.runs; token uuid := gen_random_uuid(); instance text; seconds integer;
BEGIN
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND OR r.status<>'pending' THEN RETURN; END IF;
  seconds := greatest(1,ceil(extract(epoch FROM r.deadline-clock_timestamp()))::integer);
  instance := df.start(df.seq(df.wait_for_signal('changed',seconds),
    format('SELECT approval.resume_wait(%L,%L::uuid,%L::uuid)',p_tenant,p_run,token)),
    'approval-stage',transaction_mode=>'caller');
  UPDATE approval.runs SET engine_id=instance,wait_token=token WHERE tenant=p_tenant AND id=p_run;
END $$;

CREATE OR REPLACE FUNCTION approval.resume_wait(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r approval.runs;
BEGIN
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  -- An earlier stage, duplicated activity or superseded wait cannot affect this stage.
  IF NOT FOUND OR r.status<>'pending' OR r.wait_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
  IF clock_timestamp()>=r.deadline THEN
    PERFORM approval.advance(p_tenant,p_run);
  ELSE
    -- A signal never proves approval. Resume a bounded wait for the original deadline.
    PERFORM approval.schedule_wait(p_tenant,p_run);
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.deliver_wakeup(p_tenant text,p_request uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE w approval.wakeups; engine_status text;
BEGIN
  SELECT * INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR w.delivered_at IS NOT NULL THEN RETURN true; END IF;
  engine_status := df.status(w.target_engine_id);
  IF engine_status NOT IN ('completed','failed','cancelled') THEN
    PERFORM df.signal(w.target_engine_id,'changed','{}');
  END IF;
  UPDATE approval.wakeups SET delivered_at=clock_timestamp() WHERE tenant=p_tenant AND request_id=p_request;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.enqueue_wakeup(p_tenant text,p_request uuid,p_run uuid,p_target text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE instance text;
BEGIN
  INSERT INTO approval.wakeups(tenant,request_id,run_id,target_engine_id) VALUES(p_tenant,p_request,p_run,p_target);
  instance := df.start(format('SELECT approval.deliver_wakeup(%L,%L::uuid)',p_tenant,p_request),
    'approval-wakeup',transaction_mode=>'caller');
  UPDATE approval.wakeups SET engine_id=instance WHERE tenant=p_tenant AND request_id=p_request;
END $$;

CREATE OR REPLACE FUNCTION approval.start(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d jsonb; r uuid; receipt jsonb; command jsonb;
BEGIN
  command := jsonb_build_array('start',p_actor,p_key,p_version,p_entity);
  receipt := approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  SELECT definition INTO d FROM approval.definitions WHERE tenant=p_tenant AND key=p_key AND version=p_version;
  IF d IS NULL THEN RAISE EXCEPTION 'APPROVAL_DEFINITION_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(d->'steps') s WHERE s->'approvers' ? p_actor) THEN
    RAISE EXCEPTION 'APPROVAL_MAKER_CHECKER';
  END IF;
  INSERT INTO approval.runs(tenant,definition_key,definition_version,entity_id,requester,deadline)
    VALUES(p_tenant,p_key,p_version,p_entity,p_actor,
      clock_timestamp()+make_interval(secs=>(d->'steps'->0->>'timeoutSeconds')::integer)) RETURNING id INTO r;
  INSERT INTO approval.tasks(tenant,run_id,step_index,actor)
    SELECT p_tenant,r,0,jsonb_array_elements_text(d->'steps'->0->'approvers');
  PERFORM approval.schedule_wait(p_tenant,r);
  INSERT INTO approval.events(tenant,run_id,kind,actor) VALUES(p_tenant,r,'started',p_actor);
  receipt := approval.get_run(p_tenant,r);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION approval.decide(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_decision text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r approval.runs; receipt jsonb; command jsonb;
BEGIN
  command := jsonb_build_array('decide',p_actor,p_run,p_expected,p_decision,p_reason);
  receipt := approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected')
    OR p_reason IS NULL OR length(p_reason)>4000 OR p_expected IS NULL
    OR (p_decision='rejected' AND length(btrim(p_reason))=0) THEN RAISE EXCEPTION 'APPROVAL_INVALID_DECISION'; END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  UPDATE approval.tasks SET status=p_decision,reason=p_reason,decided_at=clock_timestamp()
    WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index AND actor=p_actor AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_ACTOR_NOT_ASSIGNED'; END IF;
  UPDATE approval.runs SET row_version=row_version+1 WHERE id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'decision',p_actor,jsonb_build_object('decision',p_decision,'stepIndex',r.step_index,'reason',p_reason));
  PERFORM approval.advance(p_tenant,p_run);
  IF EXISTS (SELECT 1 FROM approval.runs WHERE id=p_run
    AND (status<>'pending' OR step_index<>r.step_index)) THEN
    PERFORM approval.enqueue_wakeup(p_tenant,p_request,p_run,r.engine_id);
  END IF;
  receipt := approval.get_run(p_tenant,p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION approval.cancel(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r approval.runs; receipt jsonb; command jsonb;
BEGIN
  command := jsonb_build_array('cancel',p_actor,p_run,p_expected);
  receipt := approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF p_actor IS NULL OR p_actor<>r.requester THEN RAISE EXCEPTION 'APPROVAL_NOT_REQUESTER'; END IF;
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  UPDATE approval.runs SET status='cancelled',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=p_run;
  UPDATE approval.tasks SET status='cancelled' WHERE tenant=p_tenant AND run_id=p_run AND status='pending';
  INSERT INTO approval.events(tenant,run_id,kind,actor) VALUES(p_tenant,p_run,'cancelled',p_actor);
  PERFORM approval.enqueue_wakeup(p_tenant,p_request,p_run,r.engine_id);
  receipt := approval.get_run(p_tenant,p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
GRANT USAGE ON SCHEMA approval TO supacloud_approval_service;
GRANT EXECUTE ON FUNCTION approval.start(text,text,uuid,text,integer,text),
  approval.decide(text,text,uuid,uuid,bigint,text,text),
  approval.cancel(text,text,uuid,uuid,bigint),
  approval.get_run(text,uuid) TO supacloud_approval_service;
COMMIT;
