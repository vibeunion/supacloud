BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_operator') THEN
    CREATE ROLE supacloud_approval_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_publisher') THEN
    CREATE ROLE supacloud_approval_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supacloud_approval_consumer') THEN
    CREATE ROLE supacloud_approval_consumer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (
    'supacloud_approval_owner','supacloud_approval_service','supacloud_approval_operator',
    'supacloud_approval_publisher','supacloud_approval_consumer')
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION 'APPROVAL_UNSAFE_ROLE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname LIKE 'supacloud_approval_%') THEN
    RAISE EXCEPTION 'Approval roles must not inherit other roles';
  END IF;
END $$;
SET LOCAL ROLE supacloud_approval_owner;
ALTER TABLE approval.runs
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 5),
  ADD COLUMN recovery_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN recovery_error text;
ALTER TABLE approval.runs ADD CONSTRAINT approval_run_invariants CHECK (
  step_index BETWEEN 0 AND 31 AND row_version>0
  AND ((status='pending')=(finished_at IS NULL)));
ALTER TABLE approval.wakeups
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 5),
  ADD COLUMN recovery_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN recovery_error text;
CREATE INDEX approval_pending_deadlines ON approval.runs(deadline,id) WHERE status='pending';
CREATE INDEX approval_recovery_candidates ON approval.runs(recovery_after,id) WHERE status='pending';
CREATE TABLE approval.maintenance_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  engine_id text,
  last_success timestamptz,
  last_scanned integer NOT NULL DEFAULT 0,
  last_recovered integer NOT NULL DEFAULT 0
);
INSERT INTO approval.maintenance_state(singleton) VALUES(true);

CREATE OR REPLACE FUNCTION approval.immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'APPROVAL_IMMUTABLE_RECORD'; END $$;
CREATE TRIGGER approval_events_immutable BEFORE UPDATE OR DELETE ON approval.events
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_receipts_immutable BEFORE UPDATE OR DELETE ON approval.receipts
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();

CREATE TABLE approval.publications (
  tenant text NOT NULL,
  request_id uuid NOT NULL,
  actor text NOT NULL,
  definition_key text NOT NULL,
  definition_version integer NOT NULL,
  definition jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,request_id),
  FOREIGN KEY(tenant,definition_key,definition_version) REFERENCES approval.definitions(tenant,key,version)
);
CREATE TRIGGER approval_publications_immutable BEFORE UPDATE OR DELETE ON approval.publications
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE FUNCTION approval.publish(
  p_tenant text,p_actor text,p_request uuid,p_key text,p_version integer,p_definition jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior approval.publications; saved jsonb;
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_request IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_IDENTITY';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('publish:'||p_tenant||':'||p_request::text,0));
  SELECT * INTO prior FROM approval.publications WHERE tenant=p_tenant AND request_id=p_request;
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

-- Terminal business intent, retained independently of pg_durable's history retention.
CREATE TABLE approval.outcomes (
  tenant text NOT NULL,
  run_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  lease_token uuid,
  lease_until timestamptz,
  acknowledged_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  PRIMARY KEY(tenant,run_id),
  FOREIGN KEY(tenant,run_id) REFERENCES approval.runs(tenant,id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX approval_outcomes_pending ON approval.outcomes(tenant,available_at,created_at)
  WHERE acknowledged_at IS NULL AND dead_lettered_at IS NULL;
CREATE FUNCTION approval.emit_outcome() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status<>'pending' THEN
    INSERT INTO approval.outcomes(tenant,run_id,payload)
      VALUES(NEW.tenant,NEW.id,jsonb_build_object('tenant',NEW.tenant,'runId',NEW.id,
      'entityId',NEW.entity_id,'definitionKey',NEW.definition_key,'definitionVersion',NEW.definition_version,
      'status',NEW.status,'rowVersion',NEW.row_version::text));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_terminal_outcome AFTER UPDATE OF status ON approval.runs
  FOR EACH ROW EXECUTE FUNCTION approval.emit_outcome();
-- Upgrade pending consumers without silently discarding already-completed approvals.
INSERT INTO approval.outcomes(tenant,run_id,payload,created_at)
  SELECT tenant,id,jsonb_build_object('tenant',tenant,'runId',id,'entityId',entity_id,
    'definitionKey',definition_key,'definitionVersion',definition_version,'status',status,'rowVersion',row_version::text),
    coalesce(finished_at,created_at)
  FROM approval.runs WHERE status<>'pending';

CREATE FUNCTION approval.claim_outcome(p_tenant text,p_lease_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes; token uuid:=gen_random_uuid();
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_LEASE';
  END IF;
  SELECT * INTO item FROM approval.outcomes WHERE tenant=p_tenant
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
    WHERE tenant=p_tenant AND run_id=item.run_id RETURNING * INTO item;
  RETURN jsonb_build_object('payload',item.payload,'leaseToken',token,'leaseUntil',item.lease_until,'attempt',item.attempts);
END $$;

CREATE FUNCTION approval.ack_outcome(p_tenant text,p_run uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  SELECT * INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR item.lease_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'APPROVAL_STALE_LEASE';
  END IF;
  IF item.acknowledged_at IS NOT NULL THEN RETURN true; END IF;
  IF item.dead_lettered_at IS NOT NULL OR item.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_STALE_LEASE'; END IF;
  UPDATE approval.outcomes SET acknowledged_at=clock_timestamp() WHERE tenant=p_tenant AND run_id=p_run;
  RETURN true;
END $$;

CREATE FUNCTION approval.nack_outcome(p_tenant text,p_run uuid,p_token uuid,p_error_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[A-Z0-9_]{1,80}$' THEN RAISE EXCEPTION 'APPROVAL_INVALID_ERROR_CODE'; END IF;
  SELECT * INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR item.lease_token IS DISTINCT FROM p_token
    OR item.acknowledged_at IS NOT NULL OR item.dead_lettered_at IS NOT NULL
    OR item.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_STALE_LEASE'; END IF;
  UPDATE approval.outcomes SET last_error_code=p_error_code,lease_token=NULL,lease_until=NULL,
    available_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^item.attempts)::integer)),
    dead_lettered_at=CASE WHEN item.attempts>=10 THEN clock_timestamp() ELSE NULL END
    WHERE tenant=p_tenant AND run_id=p_run;
  RETURN true;
END $$;

CREATE FUNCTION approval.maintenance(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; w approval.wakeups; state text; scanned integer:=0; recovered integer:=0;
  new_engine text; failure text;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_BATCH'; END IF;
  -- One maintenance pass at a time, even when an operator and the schedule overlap.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('approval-maintenance',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOR r IN SELECT a.* FROM approval.runs a LEFT JOIN df.instances e ON e.id=a.engine_id
    WHERE a.status='pending' AND (
      a.deadline<=clock_timestamp() OR
      (a.recovery_attempts<5 AND a.recovery_after<=clock_timestamp()
        AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))))
    ORDER BY a.deadline,a.id FOR UPDATE OF a SKIP LOCKED LIMIT p_limit
  LOOP
    scanned:=scanned+1;
    BEGIN
      IF r.deadline<=clock_timestamp() THEN
        PERFORM approval.advance(r.tenant,r.id);
      ELSE
        PERFORM approval.schedule_wait(r.tenant,r.id);
      END IF;
      UPDATE approval.runs SET recovery_attempts=least(5,recovery_attempts+1),
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^r.recovery_attempts)::integer)),
        recovery_error=NULL WHERE id=r.id;
      INSERT INTO approval.events(tenant,run_id,kind,detail)
        VALUES(r.tenant,r.id,'execution_recovered',jsonb_build_object('previousEngineId',r.engine_id));
      recovered:=recovered+1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failure=RETURNED_SQLSTATE;
      UPDATE approval.runs SET recovery_attempts=least(5,recovery_attempts+1),
        recovery_after=clock_timestamp()+make_interval(secs=>least(3600,30*(2^r.recovery_attempts)::integer)),
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

CREATE FUNCTION approval.ensure_maintenance() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE saved text; state text;
BEGIN
  SELECT engine_id INTO saved FROM approval.maintenance_state WHERE singleton FOR UPDATE;
  state:=df.status(saved);
  IF state IN ('pending','running') THEN RETURN saved; END IF;
  saved:=df.start(df.loop(df.seq('SELECT approval.maintenance(50)',df.wait_for_schedule('* * * * *'))),
    'approval-maintenance',transaction_mode=>'caller');
  UPDATE approval.maintenance_state SET engine_id=saved WHERE singleton;
  RETURN saved;
END $$;

CREATE FUNCTION approval.health() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'maintenanceEngineId',s.engine_id,
    'maintenanceStatus',df.status(s.engine_id),
    'lastMaintenanceAt',s.last_success,
    'maintenanceStale',s.last_success IS NULL OR s.last_success<clock_timestamp()-interval '3 minutes',
    'overdueRuns',(SELECT count(*) FROM approval.runs WHERE status='pending' AND deadline<clock_timestamp()-interval '1 minute'),
    'failedExecutions',(SELECT count(*) FROM approval.runs r LEFT JOIN df.instances e ON e.id=r.engine_id
      WHERE r.status='pending' AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))),
    'exhaustedRecoveries',(SELECT count(*) FROM approval.runs WHERE status='pending' AND recovery_attempts>=5),
    'pendingWakeups',(SELECT count(*) FROM approval.wakeups WHERE delivered_at IS NULL),
    'exhaustedWakeups',(SELECT count(*) FROM approval.wakeups WHERE delivered_at IS NULL AND recovery_attempts>=5),
    'unacknowledgedOutcomes',(SELECT count(*) FROM approval.outcomes WHERE acknowledged_at IS NULL),
    'deadLetteredOutcomes',(SELECT count(*) FROM approval.outcomes WHERE dead_lettered_at IS NOT NULL),
    'oldestUnacknowledgedOutcomeAt',(SELECT min(created_at) FROM approval.outcomes WHERE acknowledged_at IS NULL)
  ) FROM approval.maintenance_state s WHERE singleton
$$;

CREATE FUNCTION approval.retry_execution(p_tenant text,p_run uuid,p_expected_engine text,p_reason text) RETURNS jsonb
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
  IF state IN ('pending','running') THEN RAISE EXCEPTION 'APPROVAL_ENGINE_STILL_ACTIVE'; END IF;
  IF r.deadline<=clock_timestamp() THEN PERFORM approval.advance(p_tenant,p_run);
  ELSE PERFORM approval.schedule_wait(p_tenant,p_run); END IF;
  UPDATE approval.runs SET recovery_attempts=0,recovery_error=NULL,
    recovery_after=clock_timestamp()+interval '30 seconds' WHERE id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'execution_retry_requested',session_user,
      jsonb_build_object('previousEngineId',r.engine_id,'reason',p_reason));
  RETURN approval.get_run(p_tenant,p_run);
END $$;

CREATE FUNCTION approval.requeue_outcome(p_tenant text,p_run uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item approval.outcomes;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT * INTO item FROM approval.outcomes WHERE tenant=p_tenant AND run_id=p_run FOR UPDATE;
  IF NOT FOUND OR item.dead_lettered_at IS NULL OR item.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_CONFLICT';
  END IF;
  UPDATE approval.outcomes SET dead_lettered_at=NULL,attempts=0,lease_token=NULL,lease_until=NULL,
    available_at=clock_timestamp(),last_error_code=NULL WHERE tenant=p_tenant AND run_id=p_run;
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail)
    VALUES(p_tenant,p_run,'outcome_requeued',session_user,jsonb_build_object('reason',p_reason));
  RETURN true;
END $$;

-- A missing/retained-away engine no longer leaves a notification permanently stuck.
CREATE OR REPLACE FUNCTION approval.deliver_wakeup(p_tenant text,p_request uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE w approval.wakeups; state text;
BEGIN
  SELECT * INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR w.delivered_at IS NOT NULL THEN RETURN true; END IF;
  state:=df.status(w.target_engine_id);
  IF state IN ('pending','running') THEN PERFORM df.signal(w.target_engine_id,'changed','{}'); END IF;
  UPDATE approval.wakeups SET delivered_at=clock_timestamp() WHERE tenant=p_tenant AND request_id=p_request;
  RETURN true;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA approval FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA approval FROM PUBLIC;
GRANT USAGE ON SCHEMA approval TO supacloud_approval_operator,supacloud_approval_publisher,supacloud_approval_consumer;
GRANT EXECUTE ON FUNCTION approval.health(),approval.maintenance(integer),approval.ensure_maintenance(),
  approval.retry_execution(text,uuid,text,text),approval.requeue_outcome(text,uuid,text)
  TO supacloud_approval_operator;
GRANT EXECUTE ON FUNCTION approval.publish(text,text,uuid,text,integer,jsonb) TO supacloud_approval_publisher;
GRANT EXECUTE ON FUNCTION approval.claim_outcome(text,integer),approval.ack_outcome(text,uuid,uuid),
  approval.nack_outcome(text,uuid,uuid,text) TO supacloud_approval_consumer;
COMMIT;
