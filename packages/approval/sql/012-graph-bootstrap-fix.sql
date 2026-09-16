BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
-- A migration-time correction is allowed only before this execution version has
-- ever created an instance. Existing versions cannot be silently reinterpreted.
DO $$
DECLARE body text;
BEGIN
  IF EXISTS(SELECT 1 FROM approval.runs WHERE execution_version=3) THEN
    RAISE EXCEPTION 'APPROVAL_GRAPH_PATCH_REQUIRES_UNUSED_VERSION';
  END IF;
  body:=pg_get_functiondef('approval.start_graph(text,text,uuid,text,integer,text,jsonb,uuid,bigint,text)'::regprocedure);
  body:=replace(body,
    'UPDATE approval.graph_nodes SET selected=(matches=0) WHERE run_id=r AND node->>''choice''=group_key AND node ? ''default'';',
    'UPDATE approval.graph_nodes g SET selected=(matches=0) WHERE g.run_id=r AND g.node->>''choice''=group_key AND g.node ? ''default'';');
  EXECUTE body;
END $$;
CREATE TABLE approval.execution_bootstrap_corrections(
  version integer PRIMARY KEY REFERENCES approval.execution_versions(version),
  functions jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO approval.execution_bootstrap_corrections(version,functions,reason)
  SELECT 3,jsonb_build_object(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))),
    'Qualify graph routing column before the first v3 execution'
    FROM pg_proc p WHERE p.oid='approval.start_graph(text,text,uuid,text,integer,text,jsonb,uuid,bigint,text)'::regprocedure;
CREATE TRIGGER approval_bootstrap_corrections_immutable BEFORE UPDATE OR DELETE ON approval.execution_bootstrap_corrections
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_bootstrap_corrections_no_truncate BEFORE TRUNCATE ON approval.execution_bootstrap_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE OR REPLACE FUNCTION approval.check_execution_version(p_version integer) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE signatures jsonb; item record;
BEGIN
  SELECT v.functions||coalesce(c.functions,'{}'::jsonb) INTO signatures FROM approval.execution_versions v
    LEFT JOIN approval.execution_bootstrap_corrections c ON c.version=v.version WHERE v.version=p_version;
  IF signatures IS NULL THEN RAISE EXCEPTION 'APPROVAL_EXECUTION_VERSION_UNSUPPORTED'; END IF;
  FOR item IN SELECT * FROM jsonb_each_text(signatures) LOOP
    IF to_regprocedure(item.key) IS NULL OR md5(pg_get_functiondef(to_regprocedure(item.key)))<>item.value THEN
      RAISE EXCEPTION 'APPROVAL_EXECUTION_VERSION_DRIFT';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON TABLE approval.execution_bootstrap_corrections FROM PUBLIC;
COMMIT;
