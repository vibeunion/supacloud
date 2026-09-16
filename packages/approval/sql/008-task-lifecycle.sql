BEGIN;
DO $$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_jsonschema';
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION approval.valid_definition(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_DEFINITION_SCHEMA__'::json,value)
    $body$
  $fn$,extension_schema);
END $$;
SET LOCAL ROLE supacloud_approval_owner;
ALTER TABLE approval.runs DROP CONSTRAINT runs_execution_version_check;
ALTER TABLE approval.runs ADD CONSTRAINT runs_execution_version_check CHECK(execution_version IN(1,2));

CREATE TABLE approval.task_claims (
  tenant text NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  actor text NOT NULL,
  PRIMARY KEY(tenant,run_id,step_index),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id)
);
CREATE TABLE approval.task_delegations (
  tenant text NOT NULL,run_id uuid NOT NULL,step_index integer NOT NULL,
  owner_actor text NOT NULL,delegate_actor text NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY(tenant,run_id,step_index,owner_actor),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id)
);

CREATE FUNCTION approval.authorize_task_change(
  p_tenant text,p_run uuid,p_actor text,p_action text,p_target text
) RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  -- Administrative reassignment and additions require an explicit domain policy.
  RETURN false;
END $$;

CREATE FUNCTION approval.validate_task_modes() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.definition->>'schemaVersion'='4' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(NEW.definition->'steps') s
    WHERE (s->>'mode'='quorum')<>(s ? 'quorum')
  ) THEN RAISE EXCEPTION 'APPROVAL_QUORUM_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_task_modes BEFORE INSERT ON approval.definitions
  FOR EACH ROW EXECUTE FUNCTION approval.validate_task_modes();

-- New definitions use a new core. Never rewrite the frozen v1 implementation.
DO $$
DECLARE signatures text[]:=ARRAY[
  'approval.start_v1(text,text,uuid,text,integer,text,jsonb)',
  'approval.decide_v1(text,text,uuid,uuid,bigint,text,text,jsonb)',
  'approval.cancel_v1(text,text,uuid,uuid,bigint)',
  'approval.advance_v1(text,uuid)','approval.open_tasks_v1(text,uuid)',
  'approval.schedule_wait_v1(text,uuid)','approval.resume_wait_v1(text,uuid,uuid)'
]; signature text; body text; name text;
BEGIN
  FOREACH signature IN ARRAY signatures LOOP
    body:=pg_get_functiondef(signature::regprocedure);
    FOREACH name IN ARRAY ARRAY['start','decide','cancel','advance','open_tasks','schedule_wait','resume_wait'] LOOP
      body:=replace(body,'approval.'||name||'_v1(','approval.'||name||'_v2(');
    END LOOP;
    body:=replace(body,'approval.check_execution_version(1)','approval.check_execution_version(2)');
    IF signature LIKE 'approval.start_v1%' THEN
      body:=replace(body,'deadline,business_snapshot)','deadline,business_snapshot,execution_version)');
      body:=replace(body,'p_snapshot) RETURNING id','p_snapshot,2) RETURNING id');
    ELSIF signature LIKE 'approval.open_tasks_v1%' THEN
      body:=replace(body,'IN (''2'',''3'')','IN (''2'',''3'',''4'')');
      body:=replace(body,'actors:=resolution->''actors'';',
        'actors:=resolution->''actors'';
         IF step->>''mode''=''quorum'' AND (step->>''quorum'')::integer>jsonb_array_length(actors)
           THEN RAISE EXCEPTION ''APPROVAL_QUORUM_UNREACHABLE''; END IF;');
    ELSIF signature LIKE 'approval.advance_v1%' THEN
      body:=replace(body,'(step->>''mode''=''any'' OR remaining=0)',
        '(step->>''mode'' IN (''any'',''claim'') OR (step->>''mode''=''all'' AND remaining=0)
          OR (step->>''mode''=''quorum'' AND approved>=(step->>''quorum'')::integer))');
    END IF;
    EXECUTE body;
  END LOOP;
END $$;
INSERT INTO approval.execution_versions(version,functions)
  SELECT 2,jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='approval' AND p.proname IN (
      'start_v2','decide_v2','cancel_v2','advance_v2','open_tasks_v2','schedule_wait_v2','resume_wait_v2');
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.protect_subject()'::regprocedure);
  body:=replace(body,'d->>''schemaVersion''=''3''','d->>''schemaVersion'' IN (''3'',''4'')');
  EXECUTE body;
END $$;

CREATE OR REPLACE FUNCTION approval.start(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE schema_version text;
BEGIN
  SELECT definition->>'schemaVersion' INTO schema_version FROM approval.definitions
    WHERE tenant=p_tenant AND key=p_key AND version=p_version;
  IF schema_version='4' THEN
    RETURN approval.start_v2(p_tenant,p_actor,p_request,p_key,p_version,p_entity,p_snapshot);
  END IF;
  RETURN approval.start_v1(p_tenant,p_actor,p_request,p_key,p_version,p_entity,p_snapshot);
END $$;
CREATE OR REPLACE FUNCTION approval.decide(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_decision text,p_reason text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF version=2 THEN RETURN approval.decide_v2(p_tenant,p_actor,p_request,p_run,p_expected,p_decision,p_reason,p_snapshot); END IF;
  RETURN approval.decide_v1(p_tenant,p_actor,p_request,p_run,p_expected,p_decision,p_reason,p_snapshot);
END $$;
CREATE OR REPLACE FUNCTION approval.advance(p_tenant text,p_run uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version=2 THEN RETURN approval.advance_v2(p_tenant,p_run); END IF;
  RETURN approval.advance_v1(p_tenant,p_run);
END $$;
CREATE OR REPLACE FUNCTION approval.resume_wait(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RETURN false; END IF;
  IF version=2 THEN RETURN approval.resume_wait_v2(p_tenant,p_run,p_token); END IF;
  RETURN approval.resume_wait_v1(p_tenant,p_run,p_token);
END $$;
CREATE OR REPLACE FUNCTION approval.schedule_wait(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version=2 THEN PERFORM approval.schedule_wait_v2(p_tenant,p_run);
  ELSE PERFORM approval.schedule_wait_v1(p_tenant,p_run); END IF;
END $$;
CREATE OR REPLACE FUNCTION approval.cancel(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE version integer;
BEGIN
  SELECT execution_version INTO version FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF version IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF version=2 THEN RETURN approval.cancel_v2(p_tenant,p_actor,p_request,p_run,p_expected); END IF;
  RETURN approval.cancel_v1(p_tenant,p_actor,p_request,p_run,p_expected);
END $$;
DO $$
DECLARE body text;
BEGIN
  body:=pg_get_functiondef('approval.resubmit(text,text,uuid,uuid,bigint,jsonb,text)'::regprocedure);
  body:=replace(body,'PERFORM approval.open_tasks_v1(p_tenant,new_run);',
    'IF old.execution_version=2 THEN PERFORM approval.open_tasks_v2(p_tenant,new_run);
     ELSE PERFORM approval.open_tasks_v1(p_tenant,new_run); END IF;');
  body:=replace(body,'PERFORM approval.schedule_wait_v1(p_tenant,new_run);','PERFORM approval.schedule_wait(p_tenant,new_run);');
  EXECUTE body;
  body:=pg_get_functiondef('approval.return_for_changes(text,text,uuid,uuid,bigint,text)'::regprocedure);
  body:=replace(body,'SELECT * INTO assignment FROM approval.assignments',
    'IF r.execution_version=2 AND EXISTS(SELECT 1 FROM approval.definitions
       WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version
         AND definition->''steps''->r.step_index->>''mode''=''claim'')
       AND NOT EXISTS(SELECT 1 FROM approval.task_claims WHERE tenant=p_tenant AND run_id=p_run
         AND step_index=r.step_index AND actor=p_actor) THEN
       RAISE EXCEPTION ''APPROVAL_TASK_NOT_CLAIMED'';
     END IF;
     SELECT * INTO assignment FROM approval.assignments');
  EXECUTE body;
END $$;

CREATE FUNCTION approval.task_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; step jsonb; claimant text;
BEGIN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') THEN RETURN NEW; END IF;
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=OLD.tenant AND id=OLD.run_id;
  IF r.execution_version<>2 THEN RETURN NEW; END IF;
  SELECT definition->'steps'->OLD.step_index INTO step FROM approval.definitions
    WHERE tenant=r.tenant AND key=r.definition_key AND version=r.definition_version;
  IF step->>'mode'='claim' THEN
    SELECT actor INTO claimant FROM approval.task_claims
      WHERE tenant=OLD.tenant AND run_id=OLD.run_id AND step_index=OLD.step_index;
    IF claimant IS DISTINCT FROM OLD.actor THEN RAISE EXCEPTION 'APPROVAL_TASK_NOT_CLAIMED'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM approval.task_delegations WHERE tenant=OLD.tenant AND run_id=OLD.run_id
    AND step_index=OLD.step_index AND owner_actor=OLD.actor AND resolved_at IS NULL) THEN
    RAISE EXCEPTION 'APPROVAL_DELEGATION_PENDING';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_task_decision_guard BEFORE UPDATE OF status ON approval.tasks
  FOR EACH ROW EXECUTE FUNCTION approval.task_decision_guard();

CREATE FUNCTION approval.task_action(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_action text,p_target text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; step jsonb; a approval.assignments; resolution jsonb; claimant text;
  command jsonb; receipt jsonb; has_task boolean; target_exists boolean;
BEGIN
  command:=jsonb_build_array('task_action',p_actor,p_run,p_expected,p_action,p_target,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_action IS NULL OR p_action NOT IN ('claim','release','transfer','delegate','resolve','add')
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_TASK_ACTION';
  END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF r.execution_version<>2 THEN RAISE EXCEPTION 'APPROVAL_TASK_ACTION_UNSUPPORTED'; END IF;
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  SELECT definition->'steps'->r.step_index INTO step FROM approval.definitions
    WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version;
  SELECT * INTO STRICT a FROM approval.assignments WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
  resolution:=approval.assignment_resolution(p_tenant,r.entity_id,a.rule);
  has_task:=EXISTS(SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
    AND step_index=r.step_index AND actor=p_actor AND status='pending');
  SELECT actor INTO claimant FROM approval.task_claims WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
  IF p_action IN ('claim','release') THEN
    IF p_target IS NOT NULL OR step->>'mode'<>'claim' OR NOT has_task THEN RAISE EXCEPTION 'APPROVAL_INVALID_CLAIM'; END IF;
    IF p_action='claim' THEN
      IF NOT(resolution->'actors' ? p_actor) THEN RAISE EXCEPTION 'APPROVAL_ACTOR_INELIGIBLE'; END IF;
      IF claimant IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_ALREADY_CLAIMED'; END IF;
      INSERT INTO approval.task_claims VALUES(p_tenant,p_run,r.step_index,p_actor);
    ELSE
      IF claimant IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'APPROVAL_TASK_NOT_CLAIMED'; END IF;
      IF EXISTS(SELECT 1 FROM approval.task_delegations WHERE tenant=p_tenant AND run_id=p_run
        AND step_index=r.step_index AND owner_actor=p_actor AND resolved_at IS NULL) THEN
        RAISE EXCEPTION 'APPROVAL_DELEGATION_PENDING';
      END IF;
      DELETE FROM approval.task_claims WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
    END IF;
  ELSIF p_action='resolve' THEN
    IF p_target IS NULL THEN RAISE EXCEPTION 'APPROVAL_INVALID_TASK_TARGET'; END IF;
    IF NOT(resolution->'actors' ? p_actor) THEN RAISE EXCEPTION 'APPROVAL_ACTOR_INELIGIBLE'; END IF;
    UPDATE approval.task_delegations SET resolved_at=clock_timestamp() WHERE tenant=p_tenant AND run_id=p_run
      AND step_index=r.step_index AND owner_actor=p_target AND delegate_actor=p_actor AND resolved_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_DELEGATION_NOT_FOUND'; END IF;
  ELSE
    IF p_target IS NULL OR p_target !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_target=p_actor OR p_target=r.requester THEN
      RAISE EXCEPTION 'APPROVAL_INVALID_TASK_TARGET';
    END IF;
    IF NOT(resolution->'actors' ? p_target) THEN RAISE EXCEPTION 'APPROVAL_TARGET_INELIGIBLE'; END IF;
    IF p_action='add' THEN
      IF step->>'mode'<>'all' OR approval.authorize_task_change(p_tenant,p_run,p_actor,p_action,p_target) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'APPROVAL_TASK_CHANGE_FORBIDDEN';
      END IF;
    ELSE
      IF (NOT has_task OR NOT(resolution->'actors' ? p_actor))
        AND approval.authorize_task_change(p_tenant,p_run,p_actor,p_action,p_target) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'APPROVAL_TASK_CHANGE_FORBIDDEN';
      END IF;
      IF NOT has_task THEN RAISE EXCEPTION 'APPROVAL_ACTOR_NOT_ASSIGNED'; END IF;
      IF step->>'mode'='claim' AND claimant IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'APPROVAL_TASK_NOT_CLAIMED'; END IF;
      IF EXISTS(SELECT 1 FROM approval.task_delegations WHERE tenant=p_tenant AND run_id=p_run
        AND step_index=r.step_index AND owner_actor=p_actor) THEN RAISE EXCEPTION 'APPROVAL_DELEGATION_CONFLICT'; END IF;
    END IF;
    target_exists:=EXISTS(SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
      AND step_index=r.step_index AND actor=p_target);
    IF p_action='delegate' THEN
      INSERT INTO approval.task_delegations(tenant,run_id,step_index,owner_actor,delegate_actor)
        VALUES(p_tenant,p_run,r.step_index,p_actor,p_target);
    ELSIF step->>'mode'='claim' AND p_action='transfer' THEN
      IF NOT EXISTS(SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
        AND step_index=r.step_index AND actor=p_target AND status='pending') THEN RAISE EXCEPTION 'APPROVAL_TARGET_NOT_CANDIDATE'; END IF;
      UPDATE approval.task_claims SET actor=p_target WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index;
    ELSE
      IF target_exists THEN RAISE EXCEPTION 'APPROVAL_TARGET_ALREADY_ASSIGNED'; END IF;
      IF (SELECT count(*) FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index)>=50 THEN
        RAISE EXCEPTION 'APPROVAL_TASK_LIMIT';
      END IF;
      IF p_action='transfer' THEN
        UPDATE approval.tasks SET status='cancelled' WHERE tenant=p_tenant AND run_id=p_run
          AND step_index=r.step_index AND actor=p_actor AND status='pending';
      END IF;
      INSERT INTO approval.tasks(tenant,run_id,step_index,actor) VALUES(p_tenant,p_run,r.step_index,p_target);
    END IF;
  END IF;
  UPDATE approval.runs SET row_version=row_version+1 WHERE id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES(p_tenant,p_run,'task_'||p_action,p_actor,
    jsonb_build_object('target',p_target,'reason',p_reason,'stepIndex',r.step_index,'eligibilityRevision',resolution->>'revision'));
  receipt:=approval.get_run(p_tenant,p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION approval.receipt_context(value jsonb) RETURNS jsonb
LANGUAGE sql SET search_path='' AS $$
  SELECT value||jsonb_build_object('rootRunId',r.root_run_id,'previousRunId',r.previous_run_id,
    'round',r.review_round,'executionVersion',r.execution_version)
    || CASE WHEN r.execution_version<>2 THEN '{}'::jsonb ELSE jsonb_build_object(
      'taskContext',jsonb_build_object(
        'claimant',(SELECT c.actor FROM approval.task_claims c WHERE c.tenant=r.tenant AND c.run_id=r.id AND c.step_index=r.step_index),
        'delegations',(SELECT coalesce(jsonb_agg(jsonb_build_object('owner',d.owner_actor,'delegate',d.delegate_actor,
          'resolved',d.resolved_at IS NOT NULL) ORDER BY d.owner_actor),'[]'::jsonb)
          FROM approval.task_delegations d WHERE d.tenant=r.tenant AND d.run_id=r.id AND d.step_index=r.step_index)
      )) END
    FROM approval.runs r WHERE r.tenant=value->>'tenant' AND r.id=(value->>'id')::uuid
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON TABLE approval.task_claims,approval.task_delegations FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.task_action(text,text,uuid,uuid,bigint,text,text,text) TO supacloud_approval_service;
COMMIT;
