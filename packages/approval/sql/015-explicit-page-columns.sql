BEGIN;
SET LOCAL ROLE supacloud_approval_owner;

CREATE OR REPLACE FUNCTION approval.list_events(p_tenant text,p_run uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'APPROVAL_INVALID_PAGE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM approval.runs WHERE tenant=p_tenant AND id=p_run) THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,'actor',e.actor,
    'detail',e.detail,'createdAt',e.created_at) ORDER BY e.id),'[]'::jsonb)
    FROM (SELECT id, kind, actor, detail, created_at FROM approval.events
      WHERE tenant=p_tenant AND run_id=p_run AND id>p_after ORDER BY id LIMIT p_limit) e);
END $$;

CREATE OR REPLACE FUNCTION approval.recovery_queue(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_PAGE'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.id),'[]'::jsonb) FROM (
    SELECT kind, tenant, id, engine_id, error_code, attempts, created_at FROM (
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

REVOKE ALL ON FUNCTION approval.list_events(text,uuid,bigint,integer),approval.recovery_queue(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.list_events(text,uuid,bigint,integer) TO supacloud_approval_service;
GRANT EXECUTE ON FUNCTION approval.recovery_queue(integer) TO supacloud_approval_operator;
COMMIT;
