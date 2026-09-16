BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
CREATE TABLE approval.notification_policies(
  tenant text NOT NULL,definition_key text NOT NULL,definition_version integer NOT NULL,
  reminder_before integer NOT NULL CHECK(reminder_before BETWEEN 1 AND 2592000),
  escalation_before integer NOT NULL CHECK(escalation_before BETWEEN 1 AND 2592000),
  escalation_actor text NOT NULL CHECK(escalation_actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  published_by text NOT NULL,published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,definition_key,definition_version),
  FOREIGN KEY(tenant,definition_key,definition_version) REFERENCES approval.definitions(tenant,key,version),
  CHECK(reminder_before>escalation_before)
);
CREATE TRIGGER approval_notification_policies_immutable BEFORE UPDATE OR DELETE ON approval.notification_policies
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_notification_policies_no_truncate BEFORE TRUNCATE ON approval.notification_policies
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE FUNCTION approval.publish_notification_policy(
  p_tenant text,p_actor text,p_key text,p_version integer,p_reminder integer,p_escalation integer,p_escalation_actor text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing approval.notification_policies;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ACTOR'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant||':'||p_key||':'||p_version::text,1));
  SELECT * INTO existing FROM approval.notification_policies
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

CREATE TABLE approval.notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL,run_id uuid NOT NULL,step_index integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reminder','escalation')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','ready','cancelled','acknowledged','dead')),
  engine_id text,
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  recovery_attempts integer NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,lease_until timestamptz,
  last_error text,
  UNIQUE(tenant,run_id,step_index,kind),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX approval_notices_ready ON approval.notices(tenant,available_at,id) WHERE status='ready';
CREATE INDEX approval_notices_scheduled ON approval.notices(due_at,id) WHERE status='scheduled';

CREATE FUNCTION approval.schedule_notice(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT * INTO STRICT n FROM approval.notices WHERE id=p_id FOR UPDATE;
  IF n.status<>'scheduled' THEN RETURN; END IF;
  UPDATE approval.notices SET engine_id=df.start(
    df.seq(df.wait_for_signal('notice',greatest(1,ceil(extract(epoch FROM n.due_at-clock_timestamp()))::integer)),
      format('SELECT approval.ready_notice(%L::uuid)',p_id)), 'approval-notice',transaction_mode=>'caller')
    WHERE id=p_id;
END $$;
CREATE FUNCTION approval.ready_notice(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE n approval.notices; r approval.runs; recipients jsonb; escalation_actor text;
BEGIN
  SELECT * INTO n FROM approval.notices WHERE id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO STRICT r FROM approval.runs WHERE id=n.run_id AND tenant=n.tenant FOR UPDATE;
  SELECT * INTO n FROM approval.notices WHERE id=p_id FOR UPDATE;
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
CREATE FUNCTION approval.create_stage_notices() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r approval.runs; policy approval.notification_policies; item record; notice uuid;
BEGIN
  SELECT * INTO STRICT r FROM approval.runs WHERE tenant=NEW.tenant AND id=NEW.run_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.tenant||':'||r.definition_key||':'||r.definition_version::text,1));
  SELECT * INTO policy FROM approval.notification_policies
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
CREATE TRIGGER approval_stage_notices AFTER INSERT ON approval.tasks
  FOR EACH ROW EXECUTE FUNCTION approval.create_stage_notices();

CREATE FUNCTION approval.cancel_obsolete_notices() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.status<>'pending' OR NEW.step_index<>OLD.step_index THEN
    UPDATE approval.notices SET status='cancelled' WHERE tenant=NEW.tenant AND run_id=NEW.id
      AND status IN('scheduled','ready') AND (NEW.status<>'pending' OR step_index<>NEW.step_index);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_cancel_obsolete_notices AFTER UPDATE OF status,step_index ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.cancel_obsolete_notices();

CREATE FUNCTION approval.claim_notice(p_tenant text,p_lease integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices; token uuid:=gen_random_uuid();
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_lease IS NULL OR p_lease NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_LEASE';
  END IF;
  UPDATE approval.notices SET status='dead' WHERE id IN(
    SELECT id FROM approval.notices WHERE tenant=p_tenant AND status='ready' AND attempts=10
      AND lease_until<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 50);
  SELECT * INTO n FROM approval.notices WHERE tenant=p_tenant AND status='ready' AND attempts<10
    AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE approval.notices SET lease_token=token,lease_until=clock_timestamp()+make_interval(secs=>p_lease),attempts=attempts+1
    WHERE id=n.id RETURNING * INTO n;
  RETURN jsonb_build_object('payload',n.payload,'leaseToken',token,'leaseUntil',n.lease_until,'attempt',n.attempts);
END $$;
CREATE FUNCTION approval.finish_notice(p_tenant text,p_id uuid,p_token uuid,p_error text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  SELECT * INTO n FROM approval.notices WHERE tenant=p_tenant AND id=p_id FOR UPDATE;
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
CREATE FUNCTION approval.requeue_notice(p_tenant text,p_id uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n approval.notices;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED'; END IF;
  SELECT * INTO n FROM approval.notices WHERE tenant=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND OR n.status<>'dead' THEN RAISE EXCEPTION 'APPROVAL_NOTICE_NOT_DEAD'; END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND id=n.run_id
    AND status='pending' AND step_index=n.step_index) THEN RAISE EXCEPTION 'APPROVAL_NOTICE_OBSOLETE'; END IF;
  UPDATE approval.notices SET status='ready',attempts=0,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp() WHERE id=p_id;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES(p_tenant,n.run_id,'notice_requeued',session_user,
    jsonb_build_object('noticeId',p_id,'reason',p_reason));
  RETURN true;
END $$;
CREATE FUNCTION approval.protect_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant,NEW.run_id,NEW.step_index,NEW.kind,NEW.due_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant,OLD.run_id,OLD.step_index,OLD.kind,OLD.due_at)
    OR (OLD.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload)
    OR (OLD.status='acknowledged' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'APPROVAL_IMMUTABLE_NOTICE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_notice_guard BEFORE UPDATE ON approval.notices
  FOR EACH ROW EXECUTE FUNCTION approval.protect_notice();
CREATE TRIGGER approval_notice_no_delete BEFORE DELETE ON approval.notices
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_notice_no_truncate BEFORE TRUNCATE ON approval.notices
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();

ALTER FUNCTION approval.maintenance(integer) RENAME TO maintenance_without_notices;
CREATE FUNCTION approval.maintenance(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; n approval.notices; error_code text; scanned integer:=0;
BEGIN
  result:=approval.maintenance_without_notices(p_limit);
  IF result->>'busy'='true' THEN RETURN result; END IF;
  FOR n IN SELECT a.* FROM approval.notices a LEFT JOIN df.instances e ON e.id=a.engine_id
    WHERE a.status='scheduled' AND a.recovery_attempts<5 AND a.available_at<=clock_timestamp()
      AND (a.due_at<=clock_timestamp() OR e.id IS NULL OR e.status IN('completed','failed','cancelled'))
    ORDER BY a.due_at,a.id LIMIT p_limit
  LOOP
    BEGIN
      -- ready_notice locks the run before the notice, matching command lock order.
      IF n.due_at<=clock_timestamp() THEN PERFORM approval.ready_notice(n.id);
      ELSE PERFORM approval.schedule_notice(n.id); END IF;
      UPDATE approval.notices SET recovery_attempts=recovery_attempts+1,
        available_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^n.recovery_attempts)::integer))
        WHERE id=n.id AND status='scheduled';
      scanned:=scanned+1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS error_code=RETURNED_SQLSTATE;
      UPDATE approval.notices SET recovery_attempts=least(5,recovery_attempts+1),last_error=error_code,
        available_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^n.recovery_attempts)::integer)) WHERE id=n.id;
    END;
  END LOOP;
  RETURN result||jsonb_build_object('noticesScanned',scanned);
END $$;
ALTER FUNCTION approval.operational_health() RENAME TO operational_health_without_notices;
CREATE FUNCTION approval.operational_health() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT approval.operational_health_without_notices()||jsonb_build_object(
    'overdueNotices',(SELECT count(*) FROM approval.notices WHERE status='scheduled' AND due_at<clock_timestamp()-interval '3 minutes'),
    'noticeDeadLetters',(SELECT count(*) FROM approval.notices WHERE status='dead'),
    'exhaustedNotices',(SELECT count(*) FROM approval.notices n LEFT JOIN df.instances e ON e.id=n.engine_id
      WHERE n.status='scheduled' AND n.recovery_attempts>=5 AND (e.id IS NULL OR e.status IN('completed','failed','cancelled'))),
    'oldestNoticeAgeSeconds',(SELECT coalesce(max(extract(epoch FROM clock_timestamp()-due_at)),0) FROM approval.notices WHERE status='ready'))
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON FUNCTION approval.maintenance_without_notices(integer),approval.operational_health_without_notices()
  FROM supacloud_approval_operator;
REVOKE ALL ON TABLE approval.notices,approval.notification_policies FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.publish_notification_policy(text,text,text,integer,integer,integer,text) TO supacloud_approval_publisher;
GRANT EXECUTE ON FUNCTION approval.claim_notice(text,integer),approval.finish_notice(text,uuid,uuid,text) TO supacloud_approval_consumer;
GRANT EXECUTE ON FUNCTION approval.requeue_notice(text,uuid,text),approval.maintenance(integer),approval.operational_health()
  TO supacloud_approval_operator;
COMMIT;
