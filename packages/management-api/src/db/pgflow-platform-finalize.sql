-- Never infer "local/dev" from a JWT secret and allow automatic data deletion.
CREATE OR REPLACE FUNCTION pgflow.is_local() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT false $$;

-- Claim admission is locked against enable/disable. Completion/failure remains
-- callable while paused so already-running handlers can finish normally.
ALTER FUNCTION pgflow.start_tasks(text, bigint[], uuid) RENAME TO _supacloud_start_tasks;
DO $$ BEGIN
    EXECUTE replace(pg_get_functiondef('pgflow._supacloud_start_tasks(text,bigint[],uuid)'::regprocedure),
        'start_tasks.', '_supacloud_start_tasks.');
END $$;
CREATE FUNCTION pgflow.start_tasks(flow_slug text, msg_ids bigint[], worker_id uuid)
RETURNS SETOF pgflow.step_task_record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(1937076332, 1);
    IF NOT EXISTS (SELECT 1 FROM pgflow._supacloud_state WHERE enabled) THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pgflow.workers w JOIN pgflow.worker_functions f USING (function_name)
        WHERE w.worker_id = start_tasks.worker_id AND w.queue_name = start_tasks.flow_slug
            AND f.enabled AND w.stopped_at IS NULL AND w.deprecated_at IS NULL
    ) THEN RETURN; END IF;
    RETURN QUERY SELECT * FROM pgflow._supacloud_start_tasks(flow_slug, msg_ids, worker_id);
END;
$$;

-- Provision a project-specific login without inheriting a cluster-wide role.
CREATE FUNCTION pgflow._supacloud_grant_worker(target_role text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = target_role AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb) THEN
        RAISE EXCEPTION 'A dedicated non-superuser login is required';
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA pgflow TO %I', target_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgflow TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgflow TO %I', target_role);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgflow TO %I', target_role);
    EXECUTE format('REVOKE ALL ON pgflow._supacloud_state FROM %I', target_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION pgflow._supacloud_start_tasks(text,bigint[],uuid), pgflow._supacloud_start_flow(text,jsonb,uuid), pgflow._supacloud_grant_worker(text) FROM %I', target_role);
    EXECUTE format('GRANT USAGE ON SCHEMA pgmq TO %I', target_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO %I', target_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgmq TO %I', target_role);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO %I', target_role);
END;
$$;
REVOKE ALL ON FUNCTION pgflow._supacloud_grant_worker(text) FROM PUBLIC;

ALTER FUNCTION pgflow.start_flow(text, jsonb, uuid) RENAME TO _supacloud_start_flow;
DO $$ BEGIN
    EXECUTE replace(pg_get_functiondef('pgflow._supacloud_start_flow(text,jsonb,uuid)'::regprocedure),
        'start_flow.', '_supacloud_start_flow.');
END $$;
CREATE FUNCTION pgflow.start_flow(flow_slug text, input jsonb, run_id uuid DEFAULT NULL)
RETURNS SETOF pgflow.runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(1937076332, 1);
    IF NOT EXISTS (SELECT 1 FROM pgflow._supacloud_state WHERE enabled) THEN
        RAISE EXCEPTION 'pgflow is paused' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT * FROM pgflow._supacloud_start_flow(flow_slug, input, run_id);
END;
$$;

REVOKE ALL ON SCHEMA pgflow FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgflow FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgflow FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgflow FROM PUBLIC;

CREATE FUNCTION pgflow._supacloud_runtime_status()
RETURNS TABLE(version text, bundle_sha256 text, enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT version, bundle_sha256, enabled FROM pgflow._supacloud_state WHERE singleton
$$;

CREATE FUNCTION pgflow._supacloud_recover() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(1937076332, 1);
    IF EXISTS (SELECT 1 FROM pgflow._supacloud_state WHERE enabled) THEN
        PERFORM pgflow.requeue_stalled_tasks();
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION pgflow._supacloud_runtime_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION pgflow._supacloud_recover() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT USAGE ON SCHEMA pgflow TO service_role;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgflow TO service_role;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgflow TO service_role;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgflow TO service_role;
        REVOKE ALL ON pgflow._supacloud_state FROM service_role;
        REVOKE EXECUTE ON FUNCTION pgflow._supacloud_start_tasks(text,bigint[],uuid) FROM service_role;
        REVOKE EXECUTE ON FUNCTION pgflow._supacloud_start_flow(text,jsonb,uuid) FROM service_role;
        REVOKE EXECUTE ON FUNCTION pgflow._supacloud_grant_worker(text) FROM service_role;
    END IF;
END;
$$;
