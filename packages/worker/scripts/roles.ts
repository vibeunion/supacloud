import { roleNames } from "./scheduler.js";
import { renderControl } from "./control.js";

export function renderRoles(projectRef: string): string {
  const { owner, worker, recovery } = roleNames(projectRef);
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('supacloud-pgflow-roles',0));
SELECT pg_advisory_xact_lock(1937076332,1);
DO $roles$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.installation WHERE project_ref='${projectRef}') THEN
    RAISE EXCEPTION 'PGFLOW_PROJECT_BINDING_MISMATCH';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['${owner}','${worker}','${recovery}'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',role_name);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
        OR (role_name<>'${worker}' AND rolcanlogin)))
      OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname=role_name) THEN
      RAISE EXCEPTION 'PGFLOW_RUNTIME_ROLE_PRIVILEGE_CONFLICT';
    END IF;
  END LOOP;
END $roles$;
-- The engine owner is NOLOGIN and owns only this tenant's engine objects.
GRANT USAGE,CREATE ON SCHEMA pgflow TO ${owner};
GRANT USAGE ON SCHEMA pgmq,realtime,supacloud_worker TO ${owner};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pgflow TO ${owner};
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgflow TO ${owner};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgflow TO ${owner};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO ${owner};
GRANT EXECUTE ON FUNCTION realtime.send(jsonb,text,text,boolean) TO ${owner};
GRANT INSERT ON realtime.messages TO ${owner};
DROP POLICY IF EXISTS supacloud_pgflow_broadcast ON realtime.messages;
CREATE POLICY supacloud_pgflow_broadcast ON realtime.messages FOR INSERT TO ${owner}
  WITH CHECK (extension='broadcast' AND topic LIKE 'pgflow:run:%');
-- These are fixed, audited engine entrypoints. No arbitrary SQL is accepted.
DO $entrypoints$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pgflow' AND p.proname IN (
      'start_tasks','complete_task','fail_task','track_worker_function','mark_worker_stopped','requeue_stalled_tasks'
    ) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ${owner}',fn.signature);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',fn.signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog',fn.signature);
  END LOOP;
END $entrypoints$;
-- Never let a runtime credential publish or destructively recompile definitions.
CREATE OR REPLACE FUNCTION pgflow.ensure_flow_compiled(flow_slug text,shape jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $verify$
DECLARE differences text[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pgflow.flows f WHERE f.flow_slug=ensure_flow_compiled.flow_slug) THEN
    RAISE EXCEPTION 'PGFLOW_DEFINITION_NOT_PUBLISHED';
  END IF;
  differences:=pgflow._compare_flow_shapes(shape,pgflow._get_flow_shape(flow_slug));
  RETURN jsonb_build_object('status',CASE WHEN coalesce(array_length(differences,1),0)=0 THEN 'verified' ELSE 'mismatch' END,
    'differences',coalesce(to_jsonb(differences),'[]'::jsonb));
END $verify$;
ALTER FUNCTION pgflow.ensure_flow_compiled(text,jsonb) OWNER TO ${owner};
REVOKE ALL ON FUNCTION pgflow.ensure_flow_compiled(text,jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgflow,pgmq,supacloud_worker TO ${worker};
GRANT SELECT ON supacloud_worker.installation TO ${worker};
GRANT SELECT ON pgflow.runs TO ${worker};
GRANT SELECT,INSERT,UPDATE ON pgflow.workers TO ${worker};
GRANT EXECUTE ON FUNCTION pgflow.ensure_flow_compiled(text,jsonb),
  pgflow.start_tasks(text,bigint[],uuid), pgflow.complete_task(uuid,text,integer,jsonb),
  pgflow.fail_task(uuid,text,integer,text), pgflow.track_worker_function(text,text),
  pgflow.mark_worker_stopped(uuid) TO ${worker};
GRANT USAGE ON SCHEMA pgflow TO ${recovery};
GRANT EXECUTE ON FUNCTION pgflow.requeue_stalled_tasks() TO ${recovery};
CREATE OR REPLACE FUNCTION supacloud_worker.recover(expected_project text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $recover$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.installation WHERE project_ref=expected_project) THEN
    RAISE EXCEPTION 'PGFLOW_RECOVERY_PROJECT_MISMATCH';
  END IF;
  RETURN pgflow.requeue_stalled_tasks();
END $recover$;
GRANT CREATE ON SCHEMA supacloud_worker TO ${owner};
GRANT SELECT ON supacloud_worker.installation TO ${owner};
ALTER FUNCTION supacloud_worker.recover(text) OWNER TO ${owner};
REVOKE CREATE ON SCHEMA supacloud_worker FROM ${owner};
REVOKE ALL ON FUNCTION supacloud_worker.recover(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA supacloud_worker TO ${recovery};
GRANT EXECUTE ON FUNCTION supacloud_worker.recover(text) TO ${recovery};
COMMENT ON ROLE ${worker} IS 'SupaCloud pgflow runtime: ${projectRef}; login/password provisioned separately';
${renderControl(projectRef)}
COMMIT;
`;
}

/** Called after trusted definition publication; grant only registered pgflow queues. */
export function renderQueueGrants(projectRef: string): string {
  const { owner, worker } = roleNames(projectRef);
  return `\\set ON_ERROR_STOP on
BEGIN;
DO $queues$
DECLARE name text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.installation WHERE project_ref='${projectRef}') THEN
    RAISE EXCEPTION 'PGFLOW_PROJECT_BINDING_MISMATCH';
  END IF;
  FOR name IN SELECT flow_slug FROM pgflow.flows WHERE flow_slug ~ '^scw_[a-z0-9_]{1,40}$' LOOP
    EXECUTE format('GRANT SELECT,UPDATE ON pgmq.%I TO ${worker}', 'q_'||name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON pgmq.%I,pgmq.%I TO ${owner}', 'q_'||name,'a_'||name);
    EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE pgmq.%I TO ${owner}', 'q_'||name||'_msg_id_seq');
  END LOOP;
END $queues$;
COMMIT;`;
}
