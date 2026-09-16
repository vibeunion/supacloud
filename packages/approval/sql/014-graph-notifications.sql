BEGIN;
SET LOCAL ROLE supacloud_approval_owner;

-- Presence of a row pins notification semantics, including an explicit no-policy snapshot.
CREATE TABLE approval.graph_notification_snapshots (
  tenant text NOT NULL,run_id uuid NOT NULL,policy jsonb,
  PRIMARY KEY(tenant,run_id),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id)
);
CREATE TRIGGER approval_graph_notification_snapshot_immutable
  BEFORE UPDATE OR DELETE ON approval.graph_notification_snapshots
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_graph_notification_snapshot_no_truncate
  BEFORE TRUNCATE ON approval.graph_notification_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();

CREATE FUNCTION approval.snapshot_graph_notifications() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE policy jsonb;
BEGIN
  IF NEW.execution_version<>3 THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant||':'||NEW.definition_key||':'||NEW.definition_version::text,1));
  SELECT jsonb_build_object('reminderBefore',p.reminder_before,'escalationBefore',p.escalation_before,
    'escalationActor',p.escalation_actor,'publishedBy',p.published_by) INTO policy
    FROM approval.notification_policies p WHERE p.tenant=NEW.tenant
      AND p.definition_key=NEW.definition_key AND p.definition_version=NEW.definition_version;
  INSERT INTO approval.graph_notification_snapshots VALUES(NEW.tenant,NEW.id,policy);
  RETURN NEW;
END $$;
CREATE TRIGGER approval_snapshot_graph_notifications AFTER INSERT ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.snapshot_graph_notifications();

CREATE FUNCTION approval.inherit_graph_notifications() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE policy jsonb; item record; notice uuid;
BEGIN
  IF OLD.graph_parent_id IS NOT NULL OR NEW.graph_parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT s.policy INTO policy FROM approval.graph_notification_snapshots s
    WHERE s.tenant=NEW.tenant AND s.run_id=NEW.graph_parent_id;
  IF policy IS NULL THEN RETURN NEW; END IF;
  INSERT INTO approval.notification_policies(
    tenant,definition_key,definition_version,reminder_before,escalation_before,escalation_actor,published_by)
    VALUES(NEW.tenant,NEW.definition_key,NEW.definition_version,
      (policy->>'reminderBefore')::integer,(policy->>'escalationBefore')::integer,
      policy->>'escalationActor',policy->>'publishedBy');
  FOR item IN SELECT * FROM (VALUES('reminder',(policy->>'reminderBefore')::integer),
    ('escalation',(policy->>'escalationBefore')::integer)) v(kind,seconds)
  LOOP
    INSERT INTO approval.notices(tenant,run_id,step_index,kind,due_at)
      VALUES(NEW.tenant,NEW.id,NEW.step_index,item.kind,
        greatest(clock_timestamp(),NEW.deadline-make_interval(secs=>item.seconds)))
      RETURNING id INTO notice;
    PERFORM approval.schedule_notice(notice);
  END LOOP;
  INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(NEW.tenant,NEW.id,'notification_policy_inherited',
    jsonb_build_object('graphRunId',NEW.graph_parent_id,'policy',policy));
  RETURN NEW;
END $$;
CREATE TRIGGER approval_inherit_graph_notifications AFTER UPDATE OF graph_parent_id ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.inherit_graph_notifications();

CREATE FUNCTION approval.list_notices(p_tenant text,p_run uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_PAGE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND id=p_run) THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n."noticeId"),'[]'::jsonb) FROM (
    SELECT id AS "noticeId",run_id AS "runId",kind,status,due_at AS "dueAt",attempts,
      recovery_attempts AS "recoveryAttempts",last_error AS "lastError"
    FROM approval.notices WHERE tenant=p_tenant AND run_id=p_run AND (p_after IS NULL OR id>p_after)
    ORDER BY id LIMIT p_limit
  ) n);
END $$;

CREATE FUNCTION approval.recover_notice(p_tenant text,p_actor text,p_request uuid,p_run uuid,
  p_notice uuid,p_attempts integer,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; n approval.notices; command jsonb; receipt jsonb;
BEGIN
  command:=jsonb_build_array('recover_notice',p_actor,p_run,p_notice,p_attempts,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED'; END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  SELECT * INTO n FROM approval.notices WHERE tenant=p_tenant AND run_id=p_run AND id=p_notice FOR UPDATE;
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

-- Preserve the old operator API but use the same run-before-notice lock order.
CREATE OR REPLACE FUNCTION approval.requeue_notice(p_tenant text,p_id uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT * INTO n FROM approval.notices WHERE tenant=p_tenant AND id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOTICE_NOT_DEAD'; END IF;
  PERFORM approval.recover_notice(p_tenant,session_user,gen_random_uuid(),n.run_id,p_id,n.attempts,p_reason);
  RETURN true;
END $$;
REVOKE ALL ON TABLE approval.graph_notification_snapshots FROM PUBLIC;
REVOKE ALL ON FUNCTION approval.snapshot_graph_notifications(),approval.inherit_graph_notifications(),
  approval.list_notices(text,uuid,uuid,integer),approval.recover_notice(text,text,uuid,uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.list_notices(text,uuid,uuid,integer),
  approval.recover_notice(text,text,uuid,uuid,uuid,integer,text) TO supacloud_approval_operator;
COMMIT;
