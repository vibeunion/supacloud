BEGIN;
DO $$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_jsonschema';
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION approval.valid_definition(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_DEFINITION_SCHEMA__'::json, value)
    $body$
  $fn$, extension_schema);
  EXECUTE format($fn$
    CREATE FUNCTION approval.valid_assignment_resolution(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_ASSIGNMENT_RESOLUTION_SCHEMA__'::json, value)
    $body$
  $fn$, extension_schema);
END $$;
ALTER FUNCTION approval.valid_assignment_resolution(jsonb) OWNER TO supacloud_approval_owner;
SET LOCAL ROLE supacloud_approval_owner;

-- Replaced only by a reviewed, database-installed domain adapter, never a definition.
-- The adapter must lock the authoritative eligibility records until transaction end.
CREATE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'APPROVAL_ASSIGNMENT_ADAPTER_REQUIRED';
END $$;

CREATE TABLE approval.assignments (
  tenant text NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  rule jsonb NOT NULL,
  resolution jsonb NOT NULL CHECK (approval.valid_assignment_resolution(resolution)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant,run_id,step_index),
  FOREIGN KEY (tenant,run_id) REFERENCES approval.runs(tenant,id)
);
CREATE TRIGGER approval_assignments_immutable BEFORE UPDATE OR DELETE ON approval.assignments
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_assignments_no_truncate BEFORE TRUNCATE ON approval.assignments
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();

CREATE FUNCTION approval.assignment_resolution(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE resolution jsonb;
BEGIN
  resolution:=approval.resolve_assignment(p_tenant,p_entity,p_rule);
  IF resolution IS NULL OR NOT approval.valid_assignment_resolution(resolution) THEN
    RAISE EXCEPTION 'APPROVAL_ASSIGNMENT_RESOLUTION_INVALID';
  END IF;
  RETURN resolution;
END $$;

CREATE FUNCTION approval.open_tasks(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; d jsonb; step jsonb; actors jsonb; resolution jsonb;
BEGIN
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  SELECT definition INTO STRICT d FROM approval.definitions
    WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version;
  step:=d->'steps'->r.step_index;
  IF d->>'schemaVersion'='2' THEN
    resolution:=approval.assignment_resolution(p_tenant,r.entity_id,step->'assignment');
    actors:=resolution->'actors';
    IF actors ? r.requester THEN RAISE EXCEPTION 'APPROVAL_MAKER_CHECKER'; END IF;
    INSERT INTO approval.assignments(tenant,run_id,step_index,rule,resolution)
      VALUES(p_tenant,p_run,r.step_index,step->'assignment',resolution);
    INSERT INTO approval.events(tenant,run_id,kind,detail)
      VALUES(p_tenant,p_run,'assignment_resolved',jsonb_build_object(
        'stepIndex',r.step_index,'rule',step->'assignment','resolution',resolution));
  ELSE
    actors:=step->'approvers';
  END IF;
  INSERT INTO approval.tasks(tenant,run_id,step_index,actor)
    SELECT p_tenant,p_run,r.step_index,jsonb_array_elements_text(actors);
END $$;

-- Enforced at the mutation boundary, including calls through the existing decide API.
CREATE FUNCTION approval.check_task_eligibility() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a approval.assignments; r approval.runs; resolution jsonb;
BEGIN
  IF OLD.status='pending' AND NEW.status IN ('approved','rejected') THEN
    SELECT * INTO a FROM approval.assignments
      WHERE tenant=OLD.tenant AND run_id=OLD.run_id AND step_index=OLD.step_index;
    IF FOUND THEN
      SELECT * INTO STRICT r FROM approval.runs WHERE tenant=OLD.tenant AND id=OLD.run_id;
      resolution:=approval.assignment_resolution(r.tenant,r.entity_id,a.rule);
      IF NOT (resolution->'actors' ? OLD.actor) THEN RAISE EXCEPTION 'APPROVAL_ACTOR_INELIGIBLE'; END IF;
      INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
        VALUES(r.tenant,r.id,'eligibility_verified',OLD.actor,jsonb_build_object(
          'stepIndex',OLD.step_index,'assignmentRevision',a.resolution->>'revision',
          'eligibilityRevision',resolution->>'revision'));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_task_eligibility BEFORE UPDATE OF status ON approval.tasks
  FOR EACH ROW EXECUTE FUNCTION approval.check_task_eligibility();

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
  PERFORM approval.open_tasks(p_tenant,r);
  PERFORM approval.schedule_wait(p_tenant,r);
  INSERT INTO approval.events(tenant,run_id,kind,actor) VALUES(p_tenant,r,'started',p_actor);
  receipt := approval.get_run(p_tenant,r);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
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
      PERFORM approval.open_tasks(p_tenant,p_run);
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

REVOKE ALL ON TABLE approval.assignments FROM PUBLIC,supacloud_approval_service;
REVOKE ALL ON FUNCTION approval.valid_assignment_resolution(jsonb),
  approval.resolve_assignment(text,text,jsonb),approval.assignment_resolution(text,text,jsonb),
  approval.open_tasks(text,uuid),approval.check_task_eligibility() FROM PUBLIC,supacloud_approval_service;
COMMIT;
