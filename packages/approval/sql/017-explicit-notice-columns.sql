BEGIN;
SET LOCAL ROLE supacloud_approval_owner;

CREATE OR REPLACE FUNCTION approval.recover_notice(p_tenant text,p_actor text,p_request uuid,p_run uuid,
  p_notice uuid,p_attempts integer,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; n approval.notices; command jsonb; receipt jsonb;
BEGIN
  command:=jsonb_build_array('recover_notice',p_actor,p_run,p_notice,p_attempts,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED'; END IF;
  SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE tenant=p_tenant AND run_id=p_run AND id=p_notice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF p_attempts IS NULL OR p_attempts<>n.attempts THEN RAISE EXCEPTION 'APPROVAL_RECOVERY_CONFLICT'; END IF;
  IF r.status<>'pending' OR r.step_index<>n.step_index OR r.deadline<=clock_timestamp() THEN
    RAISE EXCEPTION 'APPROVAL_NOTICE_OBSOLETE';
  END IF;
  IF n.status<>'dead' THEN RAISE EXCEPTION 'APPROVAL_NOTICE_NOT_DEAD'; END IF;
  UPDATE approval.notices SET status='ready',attempts=0,lease_token=NULL,lease_until=NULL,
    available_at=clock_timestamp() WHERE id=n.id;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES(p_tenant,p_run,'notice_requeued',p_actor,
    jsonb_build_object('noticeId',p_notice,'reason',p_reason,'requestId',p_request));
  receipt:=jsonb_build_object('noticeId',p_notice,'runId',p_run,'status','ready');
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION approval.requeue_notice(p_tenant text,p_id uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT id, tenant, run_id, step_index, kind, due_at, status, engine_id, payload, attempts, recovery_attempts, available_at, lease_token, lease_until, last_error INTO n FROM approval.notices WHERE tenant=p_tenant AND id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOTICE_NOT_DEAD'; END IF;
  PERFORM approval.recover_notice(p_tenant,session_user,gen_random_uuid(),n.run_id,p_id,n.attempts,p_reason);
  RETURN true;
END $$;
COMMIT;
