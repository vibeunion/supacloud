import { roleNames } from "./scheduler.js";

/** Installation and runtime ownership stay in the canonical worker schema. */
export function renderControl(projectRef: string): string {
  const { owner, worker } = roleNames(projectRef);
  return `
CREATE TABLE IF NOT EXISTS supacloud_worker.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT true
);
REVOKE ALL ON supacloud_worker.control FROM PUBLIC;
GRANT SELECT ON supacloud_worker.control TO ${owner};
DO $wrap$
BEGIN
  IF to_regprocedure('pgflow.scw_start_tasks(text,bigint[],uuid)') IS NULL THEN
    ALTER FUNCTION pgflow.start_tasks(text,bigint[],uuid) RENAME TO scw_start_tasks;
    EXECUTE replace(pg_get_functiondef('pgflow.scw_start_tasks(text,bigint[],uuid)'::regprocedure),
      'start_tasks.', 'scw_start_tasks.');
  END IF;
  IF to_regprocedure('pgflow.scw_start_flow(text,jsonb,uuid)') IS NULL THEN
    ALTER FUNCTION pgflow.start_flow(text,jsonb,uuid) RENAME TO scw_start_flow;
    EXECUTE replace(pg_get_functiondef('pgflow.scw_start_flow(text,jsonb,uuid)'::regprocedure),
      'start_flow.', 'scw_start_flow.');
  END IF;
END $wrap$;
INSERT INTO supacloud_worker.control VALUES(true,true) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION pgflow.start_tasks(flow_slug text,msg_ids bigint[],worker_id uuid)
RETURNS SETOF pgflow.step_task_record LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $claim$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1937076332,1);
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.control WHERE singleton AND enabled) THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM pgflow.scw_start_tasks(flow_slug,msg_ids,worker_id);
END $claim$;
ALTER FUNCTION pgflow.start_tasks(text,bigint[],uuid) OWNER TO ${owner};
CREATE OR REPLACE FUNCTION pgflow.start_flow(flow_slug text,input jsonb,run_id uuid DEFAULT NULL)
RETURNS SETOF pgflow.runs LANGUAGE plpgsql SET search_path='' AS $start$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1937076332,1);
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.control WHERE singleton AND enabled) THEN
    RAISE EXCEPTION 'PGFLOW_PAUSED' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT * FROM pgflow.scw_start_flow(flow_slug,input,run_id);
END $start$;
REVOKE ALL ON FUNCTION pgflow.scw_start_tasks(text,bigint[],uuid),
  pgflow.scw_start_flow(text,jsonb,uuid), pgflow.start_tasks(text,bigint[],uuid),
  pgflow.start_flow(text,jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pgflow.scw_start_tasks(text,bigint[],uuid),
  pgflow.scw_start_flow(text,jsonb,uuid) FROM ${worker};
GRANT EXECUTE ON FUNCTION pgflow.start_tasks(text,bigint[],uuid) TO ${worker};
`;
}
