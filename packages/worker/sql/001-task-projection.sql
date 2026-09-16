-- A read projection, not an independently writable task ledger.
CREATE VIEW supacloud_worker.tasks AS
SELECT
  'pgflow:' || r.run_id::text AS id,
  i.project_ref,
  'pgflow'::text AS task_type,
  CASE r.status WHEN 'completed' THEN 'succeeded' WHEN 'failed' THEN 'failed'
    ELSE CASE
      WHEN tasks.has_started THEN 'running'
      WHEN tasks.has_retry THEN 'retry_scheduled'
      WHEN NOT coalesce(tasks.has_attempted,false) THEN 'pending'
      ELSE 'running'
    END
  END AS status,
  jsonb_build_object('kind','pgflow','version',i.engine_version,
    'definition',r.flow_slug,'run_id',r.run_id,'native_status',r.status) AS executor,
  jsonb_build_object('cancel',false,'retry',false) AS capabilities,
  CASE WHEN r.status='started' AND tasks.permanently_stalled
    THEN 'PGFLOW_PERMANENTLY_STALLED' ELSE NULL END AS blocked_reason,
  steps.total_steps, steps.finished_steps,
  r.started_at AS created_at, r.started_at,
  COALESCE(r.completed_at,r.failed_at) AS completed_at,
  greatest(r.completed_at,r.failed_at,r.started_at,tasks.updated_at,steps.updated_at) AS updated_at,
  CASE WHEN r.status='failed' THEN 'PGFLOW_RUN_FAILED' ELSE NULL END AS error,
  r.output AS result
FROM pgflow.runs r CROSS JOIN supacloud_worker.installation i
CROSS JOIN LATERAL (
  SELECT count(*)::int AS total_steps,
    count(*) FILTER(WHERE s.status IN ('completed','skipped'))::int AS finished_steps,
    max(greatest(s.created_at,s.started_at,s.completed_at,s.failed_at,s.skipped_at)) AS updated_at
  FROM pgflow.step_states s WHERE s.run_id=r.run_id
) steps
CROSS JOIN LATERAL (
  SELECT bool_or(t.status='started') AS has_started,
    bool_or(t.status='queued' AND t.attempts_count>0) AS has_retry,
    bool_or(t.attempts_count>0) AS has_attempted,
    bool_or(t.permanently_stalled_at IS NOT NULL) AS permanently_stalled,
    max(greatest(t.queued_at,t.started_at,t.completed_at,t.failed_at,t.last_requeued_at,t.permanently_stalled_at)) AS updated_at
  FROM pgflow.step_tasks t WHERE t.run_id=r.run_id
) tasks
WHERE r.flow_slug LIKE 'scw\_%' ESCAPE '\';
REVOKE ALL ON supacloud_worker.tasks FROM PUBLIC;
