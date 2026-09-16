BEGIN;
SET LOCAL ROLE supacloud_approval_owner;

-- Freeze the installed execution functions before adding new lifecycle commands.
-- Copies call other frozen functions, including the callback embedded in wait SQL.
DO $$
DECLARE signatures text[]:=ARRAY[
  'approval.start(text,text,uuid,text,integer,text,jsonb)',
  'approval.decide(text,text,uuid,uuid,bigint,text,text,jsonb)',
  'approval.cancel(text,text,uuid,uuid,bigint)',
  'approval.advance(text,uuid)','approval.open_tasks(text,uuid)',
  'approval.schedule_wait(text,uuid)','approval.resume_wait(text,uuid,uuid)'
]; bodies text[]:=ARRAY[]::text[]; signature text; body text; name text;
BEGIN
  FOREACH signature IN ARRAY signatures LOOP
    bodies:=array_append(bodies,pg_get_functiondef(signature::regprocedure));
  END LOOP;
  FOREACH body IN ARRAY bodies LOOP
    FOREACH name IN ARRAY ARRAY['start','decide','cancel','advance','open_tasks','schedule_wait','resume_wait'] LOOP
      body:=replace(body,'approval.'||name||'(','approval.'||name||'_v1(');
    END LOOP;
    body:=replace(body,E'\nBEGIN\n',E'\nBEGIN\n  PERFORM approval.check_execution_version(1);\n');
    EXECUTE body;
  END LOOP;
END $$;

ALTER TABLE approval.runs
  ADD COLUMN execution_version integer NOT NULL DEFAULT 1 CHECK(execution_version=1),
  ADD COLUMN root_run_id uuid,
  ADD COLUMN previous_run_id uuid,
  ADD COLUMN review_round integer NOT NULL DEFAULT 1 CHECK(review_round BETWEEN 1 AND 1000);
UPDATE approval.runs SET root_run_id=id;
ALTER TABLE approval.runs ALTER COLUMN root_run_id SET NOT NULL;
ALTER TABLE approval.runs
  ADD CONSTRAINT approval_root_fk FOREIGN KEY(tenant,root_run_id) REFERENCES approval.runs(tenant,id),
  ADD CONSTRAINT approval_previous_fk FOREIGN KEY(tenant,previous_run_id) REFERENCES approval.runs(tenant,id),
  ADD CONSTRAINT approval_round_unique UNIQUE(tenant,root_run_id,review_round),
  ADD CONSTRAINT approval_previous_unique UNIQUE(tenant,previous_run_id);
ALTER TABLE approval.runs DROP CONSTRAINT runs_status_check;
ALTER TABLE approval.runs ADD CONSTRAINT runs_status_check
  CHECK(status IN ('pending','approved','rejected','cancelled','timed_out','returned'));

CREATE FUNCTION approval.protect_lineage() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.root_run_id IS NULL THEN NEW.root_run_id:=NEW.id; END IF;
  ELSIF ROW(NEW.root_run_id,NEW.previous_run_id,NEW.review_round,NEW.execution_version)
    IS DISTINCT FROM ROW(OLD.root_run_id,OLD.previous_run_id,OLD.review_round,OLD.execution_version) THEN
    RAISE EXCEPTION 'APPROVAL_LINEAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_lineage_guard BEFORE INSERT OR UPDATE ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.protect_lineage();

CREATE TABLE approval.execution_versions (
  version integer PRIMARY KEY,
  functions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO approval.execution_versions(version,functions)
  SELECT 1,jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='approval' AND p.proname IN (
      'start_v1','decide_v1','cancel_v1','advance_v1','open_tasks_v1','schedule_wait_v1','resume_wait_v1');
CREATE TRIGGER approval_execution_versions_immutable BEFORE UPDATE OR DELETE ON approval.execution_versions
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_execution_versions_no_truncate BEFORE TRUNCATE ON approval.execution_versions
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();

CREATE FUNCTION approval.check_execution_version(p_version integer) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE signatures jsonb; item record;
BEGIN
  SELECT functions INTO signatures FROM approval.execution_versions WHERE version=p_version;
  IF signatures IS NULL THEN RAISE EXCEPTION 'APPROVAL_EXECUTION_VERSION_UNSUPPORTED'; END IF;
  FOR item IN SELECT * FROM jsonb_each_text(signatures) LOOP
    IF to_regprocedure(item.key) IS NULL OR md5(pg_get_functiondef(to_regprocedure(item.key)))<>item.value THEN
      RAISE EXCEPTION 'APPROVAL_EXECUTION_VERSION_DRIFT';
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION approval.start(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM approval.check_execution_version(1);
  RETURN approval.start_v1(p_tenant,p_actor,p_request,p_key,p_version,p_entity,p_snapshot);
END $$;
CREATE OR REPLACE FUNCTION approval.decide(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_decision text,p_reason text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(version);
  RETURN approval.decide_v1(p_tenant,p_actor,p_request,p_run,p_expected,p_decision,p_reason,p_snapshot);
END $$;
CREATE OR REPLACE FUNCTION approval.advance(p_tenant text,p_run uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  PERFORM approval.check_execution_version(version);
  RETURN approval.advance_v1(p_tenant,p_run);
END $$;
CREATE OR REPLACE FUNCTION approval.cancel(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(version);
  RETURN approval.cancel_v1(p_tenant,p_actor,p_request,p_run,p_expected);
END $$;
CREATE OR REPLACE FUNCTION approval.resume_wait(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RETURN false; END IF;
  PERFORM approval.check_execution_version(version);
  RETURN approval.resume_wait_v1(p_tenant,p_run,p_token);
END $$;

-- Receipt metadata is immutable across retries, unlike the current state of a run.
CREATE FUNCTION approval.receipt_context(value jsonb) RETURNS jsonb
LANGUAGE sql SET search_path='' AS $$
  SELECT value||jsonb_build_object('rootRunId',root_run_id,'previousRunId',previous_run_id,
    'round',review_round,'executionVersion',execution_version)
    FROM approval.runs WHERE tenant=value->>'tenant' AND id=(value->>'id')::uuid
$$;
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.get_run(text,uuid)'::regprocedure);
  body:=replace(body,'RETURN result;','RETURN approval.receipt_context(result);');
  EXECUTE body;
END $$;

CREATE FUNCTION approval.return_for_changes(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; receipt jsonb; command jsonb; assignment approval.assignments; resolution jsonb;
BEGIN
  command:=jsonb_build_array('return',p_actor,p_run,p_expected,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RETURN_REASON_REQUIRED';
  END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
    AND step_index=r.step_index AND actor=p_actor AND status='pending') THEN
    RAISE EXCEPTION 'APPROVAL_ACTOR_NOT_ASSIGNED';
  END IF;
  SELECT * INTO assignment FROM approval.assignments
    WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
  IF FOUND THEN
    resolution:=approval.assignment_resolution(p_tenant,r.entity_id,assignment.rule);
    IF NOT(resolution->'actors' ? p_actor) THEN RAISE EXCEPTION 'APPROVAL_ACTOR_INELIGIBLE'; END IF;
  END IF;
  UPDATE approval.runs SET status='returned',finished_at=clock_timestamp(),row_version=row_version+1 WHERE id=p_run;
  UPDATE approval.tasks SET status='cancelled' WHERE tenant=p_tenant AND run_id=p_run AND status='pending';
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'returned',p_actor,jsonb_build_object('reason',p_reason,'stepIndex',r.step_index,
      'round',r.review_round,'businessSnapshot',r.business_snapshot));
  PERFORM approval.enqueue_wakeup(p_tenant,p_request,p_run,r.engine_id);
  receipt:=approval.get_run(p_tenant,p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE FUNCTION approval.resubmit(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old approval.runs; d jsonb; new_run uuid; receipt jsonb; command jsonb;
BEGIN
  command:=jsonb_build_array('resubmit',p_actor,p_run,p_expected,p_snapshot,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RETURN_REASON_REQUIRED'; END IF;
  SELECT * INTO old FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF p_actor IS NULL OR p_actor<>old.requester THEN RAISE EXCEPTION 'APPROVAL_NOT_REQUESTER'; END IF;
  IF old.status<>'returned' THEN RAISE EXCEPTION 'APPROVAL_NOT_RETURNED'; END IF;
  IF p_expected IS NULL OR old.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF old.review_round>=1000 OR EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND previous_run_id=p_run) THEN
    RAISE EXCEPTION 'APPROVAL_RESUBMISSION_CONFLICT';
  END IF;
  PERFORM approval.check_execution_version(old.execution_version);
  SELECT definition INTO STRICT d FROM approval.definitions
    WHERE tenant=p_tenant AND key=old.definition_key AND version=old.definition_version;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'steps') s WHERE s->'approvers' ? p_actor) THEN
    RAISE EXCEPTION 'APPROVAL_MAKER_CHECKER';
  END IF;
  INSERT INTO approval.runs(tenant,definition_key,definition_version,entity_id,requester,deadline,
    business_snapshot,root_run_id,previous_run_id,review_round,execution_version)
    VALUES(p_tenant,old.definition_key,old.definition_version,old.entity_id,p_actor,
      clock_timestamp()+make_interval(secs=>(d->'steps'->0->>'timeoutSeconds')::integer),
      p_snapshot,old.root_run_id,p_run,old.review_round+1,old.execution_version) RETURNING id INTO new_run;
  PERFORM approval.open_tasks_v1(p_tenant,new_run);
  PERFORM approval.schedule_wait_v1(p_tenant,new_run);
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES
    (p_tenant,new_run,'resubmitted',p_actor,jsonb_build_object('previousRunId',p_run,'reason',p_reason,
      'round',old.review_round+1,'businessSnapshot',p_snapshot)),
    (p_tenant,p_run,'next_round_started',p_actor,jsonb_build_object('nextRunId',new_run,'reason',p_reason));
  receipt:=approval.get_run(p_tenant,new_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.emit_outcome()'::regprocedure);
  body:=replace(body,'''rowVersion'',NEW.row_version::text)',
    '''rowVersion'',NEW.row_version::text,''round'',NEW.review_round,''rootRunId'',NEW.root_run_id,''executionVersion'',NEW.execution_version)');
  EXECUTE body;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON TABLE approval.execution_versions FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.return_for_changes(text,text,uuid,uuid,bigint,text),
  approval.resubmit(text,text,uuid,uuid,bigint,jsonb,text) TO supacloud_approval_service;
COMMIT;
