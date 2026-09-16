BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
CREATE INDEX approval_tasks_by_actor ON approval.tasks(tenant,actor,status,run_id);
CREATE INDEX approval_runs_by_requester ON approval.runs(tenant,requester,created_at DESC,id DESC);
CREATE INDEX approval_delegations_by_delegate ON approval.task_delegations(tenant,delegate_actor,run_id) WHERE resolved_at IS NULL;
CREATE FUNCTION approval.list_runs(
  p_tenant text,p_actor text,p_view text,p_before_time timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_tenant IS NULL OR p_tenant !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_view IS NULL OR p_view NOT IN ('inbox','done','started','delegated')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR (p_before_time IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'APPROVAL_INVALID_PAGE'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenant',r.tenant,'runId',r.id,'entityId',r.entity_id,'definitionKey',r.definition_key,'definitionVersion',r.definition_version,
    'requester',r.requester,'status',r.status,'stepIndex',r.step_index,'rowVersion',r.row_version::text,
    'round',r.review_round,'rootRunId',r.root_run_id,'createdAt',r.created_at,'deadline',r.deadline,
    'blockingReason',CASE
      WHEN r.status<>'pending' THEN NULL
      WHEN r.deadline<=clock_timestamp() THEN 'deadline_elapsed'
      WHEN EXISTS(SELECT 1 FROM approval.task_delegations d WHERE d.tenant=p_tenant AND d.run_id=r.id
        AND d.step_index=r.step_index AND d.resolved_at IS NULL) THEN 'delegation_pending'
      WHEN def.definition->'steps'->r.step_index->>'mode'='claim'
        AND NOT EXISTS(SELECT 1 FROM approval.task_claims c WHERE c.tenant=p_tenant AND c.run_id=r.id
          AND c.step_index=r.step_index) THEN 'awaiting_claim'
      ELSE 'awaiting_decision' END
  ) ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb) FROM (
    SELECT a.* FROM approval.runs a WHERE a.tenant=p_tenant
      AND (p_before_time IS NULL OR (a.created_at,a.id)<(p_before_time,p_before_id))
      AND CASE p_view
        WHEN 'started' THEN a.requester=p_actor
        WHEN 'done' THEN EXISTS(SELECT 1 FROM approval.events e WHERE e.tenant=p_tenant AND e.run_id=a.id
          AND e.actor=p_actor AND e.kind IN ('decision','returned','task_resolve'))
        WHEN 'delegated' THEN a.status='pending' AND EXISTS(SELECT 1 FROM approval.task_delegations d
          WHERE d.tenant=p_tenant AND d.run_id=a.id AND d.step_index=a.step_index
            AND d.delegate_actor=p_actor AND d.resolved_at IS NULL)
        ELSE a.status='pending' AND a.deadline>clock_timestamp()
          AND EXISTS(SELECT 1 FROM approval.tasks t WHERE t.tenant=p_tenant AND t.run_id=a.id
            AND t.step_index=a.step_index AND t.actor=p_actor AND t.status='pending')
          AND NOT EXISTS(SELECT 1 FROM approval.task_claims c WHERE c.tenant=p_tenant AND c.run_id=a.id
            AND c.step_index=a.step_index AND c.actor<>p_actor)
      END
    ORDER BY a.created_at DESC,a.id DESC LIMIT p_limit
  ) r JOIN approval.definitions def ON def.tenant=r.tenant AND def.key=r.definition_key AND def.version=r.definition_version);
END $$;
CREATE FUNCTION approval.list_rounds(p_tenant text,p_run uuid,p_after integer DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE root uuid;
BEGIN
  IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'APPROVAL_INVALID_PAGE'; END IF;
  SELECT root_run_id INTO root FROM approval.runs WHERE tenant=p_tenant AND id=p_run;
  IF root IS NULL THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(approval.get_run(p_tenant,q.id) ORDER BY q.review_round),'[]'::jsonb)
    FROM (SELECT id,review_round FROM approval.runs WHERE tenant=p_tenant AND root_run_id=root
      AND review_round>p_after ORDER BY review_round LIMIT p_limit) q);
END $$;
REVOKE ALL ON FUNCTION approval.list_runs(text,text,text,timestamptz,uuid,integer),
  approval.list_rounds(text,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.list_runs(text,text,text,timestamptz,uuid,integer),
  approval.list_rounds(text,uuid,integer,integer) TO supacloud_approval_service;
COMMIT;
