BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
-- graph_terminal is pinned by execution version 3. Migration 016 replaced it and
-- makes check_execution_version(3) raise APPROVAL_EXECUTION_VERSION_DRIFT.
-- Restore the migration 011 body. The other functions below are not in that pin.
CREATE OR REPLACE FUNCTION approval.graph_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE child approval.runs;
BEGIN
  IF NEW.execution_version=3 AND OLD.status='pending' AND NEW.status<>'pending' THEN
    PERFORM approval.check_execution_version(3);
    UPDATE approval.graph_nodes SET status='cancelled' WHERE tenant=NEW.tenant AND run_id=NEW.id AND status='waiting';
    FOR child IN SELECT * FROM approval.runs WHERE tenant=NEW.tenant AND graph_parent_id=NEW.id AND status='pending'
      ORDER BY id FOR UPDATE
    LOOP
      UPDATE approval.runs SET status='cancelled',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=child.id;
      UPDATE approval.tasks SET status='cancelled' WHERE tenant=child.tenant AND run_id=child.id AND status='pending';
      INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(child.tenant,child.id,'graph_parent_ended',
        jsonb_build_object('parentRunId',NEW.id,'parentStatus',NEW.status));
      PERFORM approval.enqueue_wakeup(child.tenant,gen_random_uuid(),child.id,child.engine_id);
    END LOOP;
    PERFORM approval.enqueue_wakeup(NEW.tenant,gen_random_uuid(),NEW.id,NEW.engine_id);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION approval.return_for_changes(
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
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.tasks WHERE tenant=p_tenant AND run_id=p_run
    AND step_index=r.step_index AND actor=p_actor AND status='pending') THEN
    RAISE EXCEPTION 'APPROVAL_ACTOR_NOT_ASSIGNED';
  END IF;
  IF r.execution_version=2 AND EXISTS(SELECT 1 FROM approval.definitions
       WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version
         AND definition->'steps'->r.step_index->>'mode'='claim')
       AND NOT EXISTS(SELECT 1 FROM approval.task_claims WHERE tenant=p_tenant AND run_id=p_run
         AND step_index=r.step_index AND actor=p_actor) THEN
       RAISE EXCEPTION 'APPROVAL_TASK_NOT_CLAIMED';
     END IF;
     SELECT src.tenant, src.run_id, src.step_index, src.rule, src.resolution, src.created_at INTO assignment FROM approval.assignments src
    WHERE src.tenant=p_tenant AND src.run_id=p_run AND src.step_index=r.step_index;
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

CREATE OR REPLACE FUNCTION approval.resubmit_without_graph(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old approval.runs; d jsonb; new_run uuid; receipt jsonb; command jsonb;
BEGIN
  command:=jsonb_build_array('resubmit',p_actor,p_run,p_expected,p_snapshot,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RETURN_REASON_REQUIRED'; END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO old FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
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
  IF old.execution_version=2 THEN PERFORM approval.open_tasks_v2(p_tenant,new_run);
     ELSE PERFORM approval.open_tasks_v1(p_tenant,new_run); END IF;
  PERFORM approval.schedule_wait(p_tenant,new_run);
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES
    (p_tenant,new_run,'resubmitted',p_actor,jsonb_build_object('previousRunId',p_run,'reason',p_reason,
      'round',old.review_round+1,'businessSnapshot',p_snapshot)),
    (p_tenant,p_run,'next_round_started',p_actor,jsonb_build_object('nextRunId',new_run,'reason',p_reason));
  receipt:=approval.get_run(p_tenant,new_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION approval.replay(p_tenant text,p_request uuid,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE saved approval.receipts;
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_request IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_IDENTITY';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_request::text,0));
  SELECT tenant, request_id, command, receipt INTO saved FROM approval.receipts WHERE tenant=p_tenant AND request_id=p_request;
  IF FOUND THEN
    IF saved.command <> p_command THEN RAISE EXCEPTION 'APPROVAL_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN saved.receipt;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION approval.publish(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_definition jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior approval.publications; saved jsonb;
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_request IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_IDENTITY';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('publish:'||p_tenant||':'||p_request::text,0));
  SELECT tenant, request_id, actor, definition_key, definition_version, definition, published_at INTO prior FROM approval.publications WHERE tenant=p_tenant AND request_id=p_request;
  IF FOUND THEN
    IF ROW(prior.actor,prior.definition_key,prior.definition_version,prior.definition)
      IS DISTINCT FROM ROW(p_actor,p_key,p_version,p_definition) THEN
      RAISE EXCEPTION 'APPROVAL_IDEMPOTENCY_CONFLICT';
    END IF;
  ELSE
    IF p_definition IS NULL OR octet_length(p_definition::text)>262144
      OR NOT approval.valid_definition(p_definition) THEN RAISE EXCEPTION 'APPROVAL_DEFINITION_INVALID'; END IF;
    INSERT INTO approval.definitions(tenant,key,version,definition)
      VALUES(p_tenant,p_key,p_version,p_definition) ON CONFLICT DO NOTHING;
    SELECT definition INTO saved FROM approval.definitions WHERE tenant=p_tenant AND key=p_key AND version=p_version;
    IF saved IS DISTINCT FROM p_definition THEN RAISE EXCEPTION 'APPROVAL_DEFINITION_VERSION_CONFLICT'; END IF;
    INSERT INTO approval.publications(tenant,request_id,actor,definition_key,definition_version,definition)
      VALUES(p_tenant,p_request,p_actor,p_key,p_version,p_definition);
  END IF;
  RETURN jsonb_build_object('tenant',p_tenant,'definitionKey',p_key,'definitionVersion',p_version);
END $$;

CREATE OR REPLACE FUNCTION approval.claim_outcome(p_tenant text,p_lease_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes; token uuid:=gen_random_uuid();
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_LEASE';
  END IF;
  SELECT tenant, run_id, payload, created_at, available_at, attempts, lease_token, lease_until, acknowledged_at, dead_lettered_at, last_error_code INTO item FROM approval.outcomes WHERE tenant=p_tenant
    AND acknowledged_at IS NULL AND dead_lettered_at IS NULL AND available_at<=clock_timestamp()
    AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY available_at,created_at,run_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF item.attempts>=10 THEN
    UPDATE approval.outcomes SET dead_lettered_at=clock_timestamp(),last_error_code='ATTEMPTS_EXHAUSTED'
      WHERE tenant=p_tenant AND run_id=item.run_id;
    RETURN NULL;
  END IF;
  UPDATE approval.outcomes SET attempts=attempts+1,lease_token=token,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    WHERE tenant=p_tenant AND run_id=item.run_id RETURNING tenant, run_id, payload, created_at, available_at, attempts, lease_token, lease_until, acknowledged_at, dead_lettered_at, last_error_code INTO item;
  RETURN jsonb_build_object('payload',item.payload,'leaseToken',token,'leaseUntil',item.lease_until,'attempt',item.attempts);
END $$;

CREATE OR REPLACE FUNCTION approval.ack_outcome(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  SELECT tenant, run_id, payload, created_at, available_at, attempts, lease_token, lease_until, acknowledged_at, dead_lettered_at, last_error_code INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR item.lease_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'APPROVAL_STALE_LEASE';
  END IF;
  IF item.acknowledged_at IS NOT NULL THEN RETURN true; END IF;
  IF item.dead_lettered_at IS NOT NULL OR item.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_STALE_LEASE'; END IF;
  UPDATE approval.outcomes SET acknowledged_at=clock_timestamp() WHERE tenant=p_tenant AND run_id=p_run;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.nack_outcome(p_tenant text,p_run uuid,p_token uuid,p_error_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[A-Z0-9_]{1,80}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ERROR_CODE'; END IF;
  SELECT tenant, run_id, payload, created_at, available_at, attempts, lease_token, lease_until, acknowledged_at, dead_lettered_at, last_error_code INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR item.lease_token IS DISTINCT FROM p_token
    OR item.acknowledged_at IS NOT NULL OR item.dead_lettered_at IS NOT NULL
    OR item.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_STALE_LEASE'; END IF;
  UPDATE approval.outcomes SET last_error_code=p_error_code,lease_token=NULL,lease_until=NULL,
    available_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^item.attempts)::integer)),
    dead_lettered_at=CASE WHEN item.attempts>=10 THEN clock_timestamp() ELSE NULL END
    WHERE tenant=p_tenant AND run_id=p_run;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.requeue_outcome(p_tenant text,p_run uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT tenant, run_id, payload, created_at, available_at, attempts, lease_token, lease_until, acknowledged_at, dead_lettered_at, last_error_code INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR item.dead_lettered_at IS NULL OR item.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_CONFLICT';
  END IF;
  UPDATE approval.outcomes SET dead_lettered_at=NULL,attempts=0,lease_token=NULL,lease_until=NULL,
    available_at=clock_timestamp(),last_error_code=NULL WHERE tenant=p_tenant AND run_id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'outcome_requeued',session_user,jsonb_build_object('reason',p_reason));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.retry_execution(p_tenant text,p_run uuid,p_expected_engine text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; state text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.status<>'pending' OR r.engine_id IS DISTINCT FROM p_expected_engine THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_CONFLICT';
  END IF;
  state:=df.status(r.engine_id);
  IF r.deadline<=clock_timestamp() THEN
    PERFORM approval.advance(p_tenant,p_run);
  ELSE
    IF state IN ('pending','running') THEN RAISE EXCEPTION 'APPROVAL_ENGINE_STILL_ACTIVE'; END IF;
    PERFORM approval.schedule_wait(p_tenant,p_run);
  END IF;
  UPDATE approval.runs SET recovery_attempts=0,timeout_failures=0,recovery_error=NULL,
    recovery_after=clock_timestamp()+interval '30 seconds',timeout_retry_after='-infinity' WHERE id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'execution_retry_requested',session_user,
      jsonb_build_object('previousEngineId',r.engine_id,'reason',p_reason));
  RETURN approval.get_run(p_tenant,p_run);
END $$;

CREATE OR REPLACE FUNCTION approval.retry_wakeup(p_tenant text,p_request uuid,p_expected_engine text,p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w approval.wakeups; state text; instance text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT tenant, request_id, run_id, engine_id, target_engine_id, delivered_at, created_at, recovery_attempts, recovery_after, recovery_error, graph_run_id INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR w.delivered_at IS NOT NULL OR w.engine_id IS DISTINCT FROM p_expected_engine THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_CONFLICT';
  END IF;
  state:=df.status(w.engine_id);
  IF state IN ('pending','running') THEN RAISE EXCEPTION 'APPROVAL_ENGINE_STILL_ACTIVE'; END IF;
  instance:=df.start(format('SELECT approval.deliver_wakeup(%L,%L::uuid)',p_tenant,p_request),
    'approval-wakeup-retry',transaction_mode=>'caller');
  UPDATE approval.wakeups SET engine_id=instance,recovery_attempts=0,recovery_error=NULL,
    recovery_after=clock_timestamp()+interval '30 seconds'
    WHERE tenant=p_tenant AND request_id=p_request;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,w.run_id,'wakeup_retry_requested',session_user,
      jsonb_build_object('requestId',p_request,'previousEngineId',w.engine_id,'reason',p_reason));
  RETURN instance;
END $$;

CREATE OR REPLACE FUNCTION approval.check_task_eligibility() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a approval.assignments; r approval.runs; resolution jsonb;
BEGIN
  IF OLD.status='pending' AND NEW.status IN ('approved','rejected') THEN
    SELECT src.tenant, src.run_id, src.step_index, src.rule, src.resolution, src.created_at INTO a FROM approval.assignments src
      WHERE src.tenant=OLD.tenant AND src.run_id=OLD.run_id AND src.step_index=OLD.step_index;
    IF FOUND THEN
      SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO STRICT r FROM approval.runs WHERE tenant=OLD.tenant AND id=OLD.run_id;
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

CREATE OR REPLACE FUNCTION approval.task_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; step jsonb; claimant text;
BEGIN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') THEN RETURN NEW; END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO STRICT r FROM approval.runs WHERE tenant=OLD.tenant AND id=OLD.run_id;
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

CREATE OR REPLACE FUNCTION approval.task_action(
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
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF r.execution_version<>2 THEN RAISE EXCEPTION 'APPROVAL_TASK_ACTION_UNSUPPORTED'; END IF;
  IF r.status<>'pending' OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  SELECT definition->'steps'->r.step_index INTO step FROM approval.definitions
    WHERE tenant=p_tenant AND key=r.definition_key AND version=r.definition_version;
  SELECT src.tenant, src.run_id, src.step_index, src.rule, src.resolution, src.created_at INTO STRICT a FROM approval.assignments src WHERE src.tenant=p_tenant AND src.run_id=p_run AND src.step_index=r.step_index;
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

CREATE OR REPLACE FUNCTION approval.publish_notification_policy(
  p_tenant text,p_actor text,p_key text,p_version integer,p_reminder integer,p_escalation integer,p_escalation_actor text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing approval.notification_policies;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant||':'||p_key||':'||p_version::text,1));
  SELECT tenant, definition_key, definition_version, reminder_before, escalation_before, escalation_actor, published_by, published_at INTO existing FROM approval.notification_policies
    WHERE tenant=p_tenant AND definition_key=p_key AND definition_version=p_version;
  IF FOUND THEN
    IF ROW(existing.reminder_before,existing.escalation_before,existing.escalation_actor,existing.published_by)
      IS DISTINCT FROM ROW(p_reminder,p_escalation,p_escalation_actor,p_actor) THEN
      RAISE EXCEPTION 'APPROVAL_NOTIFICATION_POLICY_IMMUTABLE';
    END IF;
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND definition_key=p_key AND definition_version=p_version) THEN
    RAISE EXCEPTION 'APPROVAL_NOTIFICATION_POLICY_TOO_LATE';
  END IF;
  INSERT INTO approval.notification_policies(tenant,definition_key,definition_version,reminder_before,escalation_before,escalation_actor,published_by)
    VALUES(p_tenant,p_key,p_version,p_reminder,p_escalation,p_escalation_actor,p_actor);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.schedule_notice(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO STRICT n FROM approval.notices WHERE id=p_id FOR UPDATE;
  IF n.status<>'scheduled' THEN RETURN; END IF;
  UPDATE approval.notices SET engine_id=df.start(
    df.seq(df.wait_for_signal('notice',greatest(1,ceil(extract(epoch FROM n.due_at-clock_timestamp()))::integer)),
      format('SELECT approval.ready_notice(%L::uuid)',p_id)), 'approval-notice',transaction_mode=>'caller')
    WHERE id=p_id;
END $$;

CREATE OR REPLACE FUNCTION approval.ready_notice(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE n approval.notices; r approval.runs; recipients jsonb; escalation_actor text;
BEGIN
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO STRICT r FROM approval.runs WHERE id=n.run_id AND tenant=n.tenant FOR UPDATE;
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE id=p_id FOR UPDATE;
  IF n.status<>'scheduled' THEN RETURN false; END IF;
  IF r.status<>'pending' OR r.step_index<>n.step_index THEN
    UPDATE approval.notices SET status='cancelled' WHERE id=p_id;
    RETURN false;
  END IF;
  IF clock_timestamp()<n.due_at THEN PERFORM approval.schedule_notice(p_id); RETURN false; END IF;
  IF n.kind='escalation' THEN
    SELECT p.escalation_actor INTO escalation_actor FROM approval.notification_policies p
      WHERE p.tenant=r.tenant AND p.definition_key=r.definition_key AND p.definition_version=r.definition_version;
    recipients:=jsonb_build_array(escalation_actor);
  ELSE
    SELECT coalesce(jsonb_agg(t.actor ORDER BY t.actor),'[]'::jsonb) INTO recipients
      FROM approval.tasks t WHERE t.tenant=r.tenant AND t.run_id=r.id AND t.step_index=r.step_index AND t.status='pending';
  END IF;
  UPDATE approval.notices SET status='ready',payload=jsonb_build_object('noticeId',n.id,'tenant',r.tenant,
    'runId',r.id,'entityId',r.entity_id,'stepIndex',r.step_index,'round',r.review_round,
    'kind',n.kind,'recipients',recipients,'deadline',r.deadline,'businessSnapshot',r.business_snapshot)
    WHERE id=p_id;
  INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(r.tenant,r.id,'notice_ready',
    jsonb_build_object('noticeId',n.id,'kind',n.kind,'stepIndex',n.step_index));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.create_stage_notices() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; policy approval.notification_policies; item record; notice uuid;
BEGIN
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO STRICT r FROM approval.runs WHERE tenant=NEW.tenant AND id=NEW.run_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.tenant||':'||r.definition_key||':'||r.definition_version::text,1));
  SELECT tenant, definition_key, definition_version, reminder_before, escalation_before, escalation_actor, published_by, published_at INTO policy FROM approval.notification_policies
    WHERE tenant=r.tenant AND definition_key=r.definition_key AND definition_version=r.definition_version;
  IF NOT FOUND THEN RETURN NEW; END IF;
  FOR item IN SELECT * FROM (VALUES('reminder',policy.reminder_before),('escalation',policy.escalation_before)) v(kind,seconds)
  LOOP
    INSERT INTO approval.notices(tenant,run_id,step_index,kind,due_at)
      VALUES(r.tenant,r.id,NEW.step_index,item.kind,greatest(clock_timestamp(),r.deadline-make_interval(secs=>item.seconds)))
      ON CONFLICT DO NOTHING RETURNING id INTO notice;
    IF notice IS NOT NULL THEN PERFORM approval.schedule_notice(notice); END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION approval.claim_notice(p_tenant text,p_lease integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices; token uuid:=gen_random_uuid();
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_lease IS NULL OR p_lease NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_LEASE';
  END IF;
  UPDATE approval.notices SET status='dead' WHERE id IN(
    SELECT id FROM approval.notices WHERE tenant=p_tenant AND status='ready' AND attempts=10
      AND lease_until<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 50);
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE tenant=p_tenant AND status='ready' AND attempts<10
    AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE approval.notices SET lease_token=token,lease_until=clock_timestamp()+make_interval(secs=>p_lease),attempts=attempts+1
    WHERE id=n.id RETURNING id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n;
  RETURN jsonb_build_object('payload',n.payload,'leaseToken',token,'leaseUntil',n.lease_until,'attempt',n.attempts);
END $$;

CREATE OR REPLACE FUNCTION approval.finish_notice(p_tenant text,p_id uuid,p_token uuid,p_error text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE tenant=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR n.lease_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'APPROVAL_NOTICE_LEASE_CONFLICT'; END IF;
  IF n.status='acknowledged' AND p_error IS NULL THEN RETURN true; END IF;
  IF n.status<>'ready' OR n.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_NOTICE_LEASE_CONFLICT'; END IF;
  IF p_error IS NOT NULL AND p_error !~ '^[A-Z0-9_]{1,80}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ERROR_CODE'; END IF;
  UPDATE approval.notices SET status=CASE WHEN p_error IS NULL THEN 'acknowledged' WHEN attempts>=10 THEN 'dead' ELSE 'ready' END,
    last_error=p_error,available_at=clock_timestamp()+make_interval(secs=>least(3600,5*(2^n.attempts)::integer)),
    lease_token=CASE WHEN p_error IS NULL THEN lease_token ELSE NULL END,
    lease_until=CASE WHEN p_error IS NULL THEN lease_until ELSE NULL END WHERE id=p_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION approval.deliver_wakeup(p_tenant text,p_request uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE w approval.wakeups;
BEGIN
  SELECT tenant, request_id, run_id, engine_id, target_engine_id, delivered_at, created_at, recovery_attempts, recovery_after, recovery_error, graph_run_id INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR w.delivered_at IS NOT NULL THEN RETURN true; END IF;
  IF w.graph_run_id IS NOT NULL THEN
    PERFORM approval.reconcile_graph(p_tenant,w.graph_run_id);
    UPDATE approval.wakeups SET delivered_at=clock_timestamp() WHERE tenant=p_tenant AND request_id=p_request;
    RETURN true;
  END IF;
  RETURN approval.deliver_wakeup_without_graph(p_tenant,p_request);
END $$;

CREATE OR REPLACE FUNCTION approval.resubmit(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs;
BEGIN
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.graph_parent_id IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RESUBMIT_GRAPH_ROOT'; END IF;
  IF r.execution_version=3 THEN RETURN approval.start_graph(p_tenant,p_actor,p_request,r.definition_key,
    r.definition_version,r.entity_id,p_snapshot,p_run,p_expected,p_reason); END IF;
  RETURN approval.resubmit_without_graph(p_tenant,p_actor,p_request,p_run,p_expected,p_snapshot,p_reason);
END $$;

CREATE OR REPLACE FUNCTION approval.migrate_run(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_target_version integer,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; command jsonb; receipt jsonb; new_run uuid;
BEGIN
  command:=jsonb_build_array('migrate',p_actor,p_run,p_expected,p_target_version,p_snapshot,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_INVALID_MIGRATION'; END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.graph_parent_id IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_MIGRATE_GRAPH_ROOT'; END IF;
  IF r.status<>'pending' OR r.deadline<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF p_target_version IS NULL OR p_target_version=r.definition_version OR NOT EXISTS(
    SELECT 1 FROM approval.definitions WHERE tenant=p_tenant AND key=r.definition_key AND version=p_target_version
  ) THEN RAISE EXCEPTION 'APPROVAL_MIGRATION_TARGET_INVALID'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF approval.authorize_migration(p_tenant,p_run,p_actor,p_target_version) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'APPROVAL_MIGRATION_FORBIDDEN';
  END IF;
  PERFORM approval.cancel(p_tenant,r.requester,gen_random_uuid(),p_run,p_expected);
  receipt:=approval.start(p_tenant,r.requester,gen_random_uuid(),r.definition_key,p_target_version,r.entity_id,p_snapshot);
  new_run:=(receipt->>'id')::uuid;
  INSERT INTO approval.instance_migrations VALUES(p_tenant,p_run,new_run,p_actor,p_reason,clock_timestamp());
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES
    (p_tenant,p_run,'migrated_out',p_actor,jsonb_build_object('targetRunId',new_run,'targetVersion',p_target_version,'reason',p_reason)),
    (p_tenant,new_run,'migrated_in',p_actor,jsonb_build_object('sourceRunId',p_run,'sourceVersion',r.definition_version,'reason',p_reason));
  receipt:=receipt||jsonb_build_object('migrationSourceRunId',p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;
COMMIT;
