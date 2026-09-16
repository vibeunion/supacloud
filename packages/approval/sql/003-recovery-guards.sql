BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
ALTER TABLE approval.runs
  ADD COLUMN timeout_failures integer NOT NULL DEFAULT 0 CHECK(timeout_failures BETWEEN 0 AND 5),
  ADD COLUMN timeout_retry_after timestamptz NOT NULL DEFAULT '-infinity';
CREATE TRIGGER approval_events_no_truncate BEFORE TRUNCATE ON approval.events
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_receipts_no_truncate BEFORE TRUNCATE ON approval.receipts
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_publications_no_truncate BEFORE TRUNCATE ON approval.publications
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_definitions_no_truncate BEFORE TRUNCATE ON approval.definitions
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_outcomes_no_delete BEFORE DELETE ON approval.outcomes
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_outcomes_no_truncate BEFORE TRUNCATE ON approval.outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE FUNCTION approval.protect_outcome_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF ROW(NEW.tenant,NEW.run_id,NEW.payload,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant,OLD.run_id,OLD.payload,OLD.created_at) THEN
    RAISE EXCEPTION 'APPROVAL_IMMUTABLE_OUTCOME';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'APPROVAL_ACKNOWLEDGED_OUTCOME';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_outcomes_guard BEFORE UPDATE ON approval.outcomes
  FOR EACH ROW EXECUTE FUNCTION approval.protect_outcome_payload();

CREATE OR REPLACE FUNCTION approval.maintenance(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; w approval.wakeups; scanned integer:=0; recovered integer:=0;
  new_engine text; failure text; expired boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_BATCH'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('approval-maintenance',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOR r IN SELECT a.* FROM approval.runs a LEFT JOIN df.instances e ON e.id=a.engine_id
    WHERE a.status='pending' AND (
      (a.deadline<=clock_timestamp() AND a.timeout_failures<5 AND a.timeout_retry_after<=clock_timestamp()) OR
      (a.deadline>clock_timestamp() AND a.recovery_attempts<5 AND a.recovery_after<=clock_timestamp()
        AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))))
    ORDER BY a.deadline,a.id FOR UPDATE OF a SKIP LOCKED LIMIT p_limit
  LOOP
    scanned:=scanned+1;
    expired:=r.deadline<=clock_timestamp();
    BEGIN
      IF expired THEN PERFORM approval.advance(r.tenant,r.id);
      ELSE PERFORM approval.schedule_wait(r.tenant,r.id); END IF;
      UPDATE approval.runs SET recovery_attempts=CASE WHEN expired THEN recovery_attempts ELSE least(5,recovery_attempts+1) END,
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^r.recovery_attempts)::integer)),
        recovery_error=NULL WHERE id=r.id;
      INSERT INTO approval.events(tenant,run_id,kind,detail)
        VALUES(r.tenant,r.id,'execution_recovered',jsonb_build_object('previousEngineId',r.engine_id,'expired',expired));
      recovered:=recovered+1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failure=RETURNED_SQLSTATE;
      UPDATE approval.runs SET
        recovery_attempts=CASE WHEN expired THEN recovery_attempts ELSE least(5,recovery_attempts+1) END,
        timeout_failures=CASE WHEN expired THEN least(5,timeout_failures+1) ELSE timeout_failures END,
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^r.recovery_attempts)::integer)),
        timeout_retry_after=CASE WHEN expired
          THEN clock_timestamp()+make_interval(secs=>least(3600,30*(2^r.timeout_failures)::integer)) ELSE timeout_retry_after END,
        recovery_error=failure WHERE id=r.id;
    END;
  END LOOP;
  FOR w IN SELECT a.* FROM approval.wakeups a LEFT JOIN df.instances e ON e.id=a.engine_id
    WHERE a.delivered_at IS NULL AND a.recovery_attempts<5 AND a.recovery_after<=clock_timestamp()
      AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))
    ORDER BY a.created_at,a.request_id FOR UPDATE OF a SKIP LOCKED LIMIT p_limit
  LOOP
    scanned:=scanned+1;
    BEGIN
      new_engine:=df.start(format('SELECT approval.deliver_wakeup(%L,%L::uuid)',w.tenant,w.request_id),
        'approval-wakeup-recovery',transaction_mode=>'caller');
      UPDATE approval.wakeups SET engine_id=new_engine,recovery_attempts=recovery_attempts+1,
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^w.recovery_attempts)::integer)),
        recovery_error=NULL WHERE tenant=w.tenant AND request_id=w.request_id;
      recovered:=recovered+1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failure=RETURNED_SQLSTATE;
      UPDATE approval.wakeups SET recovery_attempts=least(5,recovery_attempts+1),
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^w.recovery_attempts)::integer)),
        recovery_error=failure WHERE tenant=w.tenant AND request_id=w.request_id;
    END;
  END LOOP;
  UPDATE approval.maintenance_state SET last_success=clock_timestamp(),last_scanned=scanned,last_recovered=recovered;
  RETURN jsonb_build_object('scanned',scanned,'recovered',recovered);
END $$;

CREATE OR REPLACE FUNCTION approval.ensure_maintenance() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE saved text; state text;
BEGIN
  SELECT engine_id INTO saved FROM approval.maintenance_state WHERE singleton FOR UPDATE;
  state:=df.status(saved);
  IF state IN ('pending','running') THEN RETURN saved; END IF;
  -- A failed pass must not permanently kill the maintenance schedule.
  saved:=df.start(df.loop(df.seq(df.wait_for_schedule('* * * * *'),'SELECT approval.maintenance(50)'),
      continue_on_failure=>true),
    'approval-maintenance',transaction_mode=>'caller');
  UPDATE approval.maintenance_state SET engine_id=saved WHERE singleton;
  RETURN saved;
END $$;

CREATE FUNCTION approval.list_events(p_tenant text,p_run uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_PAGE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND id=p_run) THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,'actor',e.actor,
    'detail',e.detail,'createdAt',e.created_at) ORDER BY e.id),'[]'::jsonb)
    FROM (SELECT * FROM approval.events WHERE tenant=p_tenant AND run_id=p_run AND id>p_after ORDER BY id LIMIT p_limit) e);
END $$;

CREATE FUNCTION approval.operational_health() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT approval.health() || jsonb_build_object(
    'exhaustedTimeouts',(SELECT count(*) FROM approval.runs WHERE status='pending' AND timeout_failures>=5),
    'lastScanned',s.last_scanned,'lastRecovered',s.last_recovered
  ) FROM approval.maintenance_state s WHERE singleton
$$;

CREATE OR REPLACE FUNCTION approval.retry_execution(p_tenant text,p_run uuid,p_expected_engine text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; state text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
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
REVOKE ALL ON FUNCTION approval.protect_outcome_payload(),approval.list_events(text,uuid,bigint,integer),
  approval.operational_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.list_events(text,uuid,bigint,integer) TO supacloud_approval_service;
GRANT EXECUTE ON FUNCTION approval.operational_health() TO supacloud_approval_operator;
COMMIT;
