BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
CREATE FUNCTION approval.recovery_queue(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_PAGE'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.id),'[]'::jsonb) FROM (
    SELECT * FROM (
      SELECT 'execution'::text AS kind,r.tenant,r.id::text AS id,r.engine_id,
        r.recovery_error AS error_code,greatest(r.recovery_attempts,r.timeout_failures) AS attempts,r.created_at
        FROM approval.runs r LEFT JOIN df.instances e ON e.id=r.engine_id
        WHERE r.status='pending' AND (r.deadline<=clock_timestamp() OR e.id IS NULL OR e.status IN ('completed','failed','cancelled'))
      UNION ALL
      SELECT 'wakeup',w.tenant,w.request_id::text,w.engine_id,w.recovery_error,w.recovery_attempts,w.created_at
        FROM approval.wakeups w LEFT JOIN df.instances e ON e.id=w.engine_id
        WHERE w.delivered_at IS NULL AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))
      UNION ALL
      SELECT 'outcome',o.tenant,o.run_id::text,NULL::text,o.last_error_code,o.attempts,o.created_at
        FROM approval.outcomes o WHERE o.dead_lettered_at IS NOT NULL
    ) items ORDER BY created_at,id LIMIT p_limit
  ) q);
END $$;

CREATE FUNCTION approval.retry_wakeup(p_tenant text,p_request uuid,p_expected_engine text,p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w approval.wakeups; state text; instance text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'APPROVAL_RECOVERY_REASON_REQUIRED';
  END IF;
  SELECT * INTO w FROM approval.wakeups WHERE tenant=p_tenant AND request_id=p_request FOR UPDATE;
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

CREATE OR REPLACE FUNCTION approval.operational_health() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT approval.health() || jsonb_build_object(
    'exhaustedRecoveries',(SELECT count(*) FROM approval.runs r LEFT JOIN df.instances e ON e.id=r.engine_id
      WHERE r.status='pending' AND r.recovery_attempts>=5 AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))),
    'exhaustedWakeups',(SELECT count(*) FROM approval.wakeups w LEFT JOIN df.instances e ON e.id=w.engine_id
      WHERE w.delivered_at IS NULL AND w.recovery_attempts>=5 AND (e.id IS NULL OR e.status IN ('completed','failed','cancelled'))),
    'exhaustedTimeouts',(SELECT count(*) FROM approval.runs WHERE status='pending' AND timeout_failures>=5),
    'lastScanned',s.last_scanned,'lastRecovered',s.last_recovered
  ) FROM approval.maintenance_state s WHERE singleton
$$;
REVOKE ALL ON FUNCTION approval.recovery_queue(integer),approval.retry_wakeup(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.recovery_queue(integer),approval.retry_wakeup(text,uuid,text,text)
  TO supacloud_approval_operator;
COMMIT;
