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
  EXECUTE format($fn$
    CREATE FUNCTION approval.valid_business_snapshot(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $body$
      SELECT %I.jsonb_matches_schema('__APPROVAL_BUSINESS_SNAPSHOT_SCHEMA__'::json,value)
    $body$
  $fn$,extension_schema);
END $$;
ALTER FUNCTION approval.valid_business_snapshot(jsonb) OWNER TO supacloud_approval_owner;
SET LOCAL ROLE supacloud_approval_owner;

CREATE FUNCTION approval.resolve_subject(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'APPROVAL_SUBJECT_ADAPTER_REQUIRED';
END $$;

ALTER TABLE approval.runs
  ADD COLUMN business_snapshot jsonb,
  ADD COLUMN subject_resolver text,
  ADD CONSTRAINT approval_snapshot_valid CHECK (
    (business_snapshot IS NULL AND subject_resolver IS NULL)
    OR (business_snapshot IS NOT NULL AND subject_resolver IS NOT NULL
      AND approval.valid_business_snapshot(business_snapshot)));

CREATE FUNCTION approval.verify_subject(p_tenant text,p_entity text,p_resolver text,p_expected jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE actual jsonb;
BEGIN
  IF p_expected IS NULL OR NOT approval.valid_business_snapshot(p_expected) THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_SNAPSHOT';
  END IF;
  actual:=approval.resolve_subject(p_tenant,p_entity,p_resolver);
  IF actual IS NULL OR NOT approval.valid_business_snapshot(actual) THEN
    RAISE EXCEPTION 'APPROVAL_SUBJECT_RESOLUTION_INVALID';
  END IF;
  IF actual<>p_expected THEN RAISE EXCEPTION 'APPROVAL_SUBJECT_CHANGED'; END IF;
END $$;

CREATE FUNCTION approval.protect_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE d jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.business_snapshot IS DISTINCT FROM OLD.business_snapshot
      OR NEW.subject_resolver IS DISTINCT FROM OLD.subject_resolver
      OR (OLD.business_snapshot IS NOT NULL AND (
        NEW.tenant IS DISTINCT FROM OLD.tenant OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
        OR NEW.definition_key IS DISTINCT FROM OLD.definition_key
        OR NEW.definition_version IS DISTINCT FROM OLD.definition_version)) THEN
      RAISE EXCEPTION 'APPROVAL_SNAPSHOT_IMMUTABLE';
    END IF;
  ELSE
    SELECT definition INTO STRICT d FROM approval.definitions
      WHERE tenant=NEW.tenant AND key=NEW.definition_key AND version=NEW.definition_version;
    IF d->>'schemaVersion'='3' THEN
      NEW.subject_resolver:=d->>'subjectResolver';
      PERFORM approval.verify_subject(NEW.tenant,NEW.entity_id,NEW.subject_resolver,NEW.business_snapshot);
    ELSIF NEW.business_snapshot IS NOT NULL OR NEW.subject_resolver IS NOT NULL THEN
      RAISE EXCEPTION 'APPROVAL_SNAPSHOT_UNSUPPORTED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_subject_guard BEFORE INSERT OR UPDATE ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.protect_subject();

CREATE OR REPLACE FUNCTION approval.get_run(p_tenant text,p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object('id',r.id,'tenant',r.tenant,'entityId',r.entity_id,'status',r.status,
    'stepIndex',r.step_index,'rowVersion',r.row_version::text,'deadline',r.deadline,
    'engineId',r.engine_id,'tasks',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'stepIndex',t.step_index,'actor',t.actor,'status',t.status,'reason',t.reason)
      ORDER BY t.step_index,t.actor) FROM approval.tasks t WHERE t.tenant=p_tenant AND t.run_id=p_run),'[]'::jsonb))
    || CASE WHEN r.business_snapshot IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('businessSnapshot',r.business_snapshot) END
    INTO result FROM approval.runs r WHERE r.tenant=p_tenant AND r.id=p_run;
  IF result IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION approval.open_tasks(p_tenant text,p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; d jsonb; step jsonb; actors jsonb; resolution jsonb;
BEGIN
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  SELECT definition INTO STRICT d FROM approval.definitions
    WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version;
  step:=d->'steps'->r.step_index;
  IF d->>'schemaVersion' IN ('2','3') THEN
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

CREATE FUNCTION approval.start(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d jsonb; r uuid; receipt jsonb; command jsonb;
BEGIN
  command:=jsonb_build_array('start',p_actor,p_key,p_version,p_entity);
  IF p_snapshot IS NOT NULL THEN command:=command||jsonb_build_array(p_snapshot); END IF;
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  SELECT definition INTO d FROM approval.definitions WHERE tenant=p_tenant AND key=p_key AND version=p_version;
  IF d IS NULL THEN RAISE EXCEPTION 'APPROVAL_DEFINITION_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(d->'steps') s WHERE s->'approvers' ? p_actor) THEN
    RAISE EXCEPTION 'APPROVAL_MAKER_CHECKER';
  END IF;
  INSERT INTO approval.runs(tenant,definition_key,definition_version,entity_id,requester,deadline,business_snapshot)
    VALUES(p_tenant,p_key,p_version,p_entity,p_actor,
      clock_timestamp()+make_interval(secs=>(d->'steps'->0->>'timeoutSeconds')::integer),p_snapshot) RETURNING id INTO r;
  PERFORM approval.open_tasks(p_tenant,r);
  PERFORM approval.schedule_wait(p_tenant,r);
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,r,'started',p_actor,CASE WHEN p_snapshot IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('businessSnapshot',p_snapshot) END);
  receipt:=approval.get_run(p_tenant,r);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;
CREATE OR REPLACE FUNCTION approval.start(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_entity text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT approval.start(p_tenant,p_actor,p_request,p_key,p_version,p_entity,NULL::jsonb)
$$;

CREATE FUNCTION approval.decide(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_decision text,p_reason text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; receipt jsonb; command jsonb;
BEGIN
  command:=jsonb_build_array('decide',p_actor,p_run,p_expected,p_decision,p_reason);
  IF p_snapshot IS NOT NULL THEN command:=command||jsonb_build_array(p_snapshot); END IF;
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected')
    OR p_reason IS NULL OR length(p_reason)>4000 OR p_expected IS NULL
    OR (p_decision='rejected' AND length(btrim(p_reason))=0) THEN RAISE EXCEPTION 'APPROVAL_INVALID_DECISION'; END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF r.business_snapshot IS NOT NULL THEN
    IF p_snapshot IS DISTINCT FROM r.business_snapshot THEN RAISE EXCEPTION 'APPROVAL_SNAPSHOT_MISMATCH'; END IF;
    PERFORM approval.verify_subject(p_tenant,r.entity_id,r.subject_resolver,r.business_snapshot);
  ELSIF p_snapshot IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_SNAPSHOT_UNSUPPORTED';
  END IF;
  UPDATE approval.tasks SET status=p_decision,reason=p_reason,decided_at=clock_timestamp()
    WHERE tenant=p_tenant AND run_id=p_run AND step_index=r.step_index AND actor=p_actor AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_ACTOR_NOT_ASSIGNED'; END IF;
  UPDATE approval.runs SET row_version=row_version+1 WHERE id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'decision',p_actor,jsonb_build_object('decision',p_decision,'stepIndex',r.step_index,'reason',p_reason)
      || CASE WHEN r.business_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessSnapshot',r.business_snapshot) END);
  PERFORM approval.advance(p_tenant,p_run);
  IF EXISTS (SELECT 1 FROM approval.runs WHERE id=p_run AND (status<>'pending' OR step_index<>r.step_index)) THEN
    PERFORM approval.enqueue_wakeup(p_tenant,p_request,p_run,r.engine_id);
  END IF;
  receipt:=approval.get_run(p_tenant,p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;
CREATE OR REPLACE FUNCTION approval.decide(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_decision text,p_reason text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT approval.decide(p_tenant,p_actor,p_request,p_run,p_expected,p_decision,p_reason,NULL::jsonb)
$$;

CREATE OR REPLACE FUNCTION approval.emit_outcome() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status<>'pending' THEN
    INSERT INTO approval.outcomes(tenant,run_id,payload)
      VALUES(NEW.tenant,NEW.id,jsonb_build_object('tenant',NEW.tenant,'runId',NEW.id,
        'entityId',NEW.entity_id,'definitionKey',NEW.definition_key,'definitionVersion',NEW.definition_version,
        'status',NEW.status,'rowVersion',NEW.row_version::text)
        || CASE WHEN NEW.business_snapshot IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('businessSnapshot',NEW.business_snapshot) END);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION approval.resolve_subject(text,text,text),approval.verify_subject(text,text,text,jsonb),
  approval.valid_business_snapshot(jsonb),approval.protect_subject(),
  approval.start(text,text,uuid,text,integer,text,jsonb),
  approval.decide(text,text,uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.start(text,text,uuid,text,integer,text,jsonb),
  approval.decide(text,text,uuid,uuid,bigint,text,text,jsonb) TO supacloud_approval_service;
COMMIT;
