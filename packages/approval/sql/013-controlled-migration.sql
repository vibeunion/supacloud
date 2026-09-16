BEGIN;
SET LOCAL ROLE supacloud_approval_owner;
CREATE TABLE approval.instance_migrations(
  tenant text NOT NULL,source_run_id uuid NOT NULL,target_run_id uuid NOT NULL,actor text NOT NULL,
  reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,source_run_id),UNIQUE(tenant,target_run_id),
  FOREIGN KEY(tenant,source_run_id) REFERENCES approval.runs(tenant,id),
  FOREIGN KEY(tenant,target_run_id) REFERENCES approval.runs(tenant,id)
);
CREATE TRIGGER approval_instance_migrations_immutable BEFORE UPDATE OR DELETE ON approval.instance_migrations
  FOR EACH ROW EXECUTE FUNCTION approval.immutable_record();
CREATE TRIGGER approval_instance_migrations_no_truncate BEFORE TRUNCATE ON approval.instance_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION approval.immutable_record();
CREATE FUNCTION approval.authorize_migration(p_tenant text,p_run uuid,p_actor text,p_target_version integer)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RETURN false; END $$;
CREATE FUNCTION approval.migrate_run(
  p_tenant text,p_actor text,p_request uuid,p_run uuid,p_expected bigint,p_target_version integer,p_snapshot jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r approval.runs; command jsonb; receipt jsonb; new_run uuid;
BEGIN
  command:=jsonb_build_array('migrate',p_actor,p_run,p_expected,p_target_version,p_snapshot,p_reason);
  receipt:=approval.replay(p_tenant,p_request,command);
  IF receipt IS NOT NULL THEN RETURN receipt; END IF;
  IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$'
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'APPROVAL_INVALID_MIGRATION'; END IF;
  SELECT * INTO r FROM approval.runs WHERE tenant=p_tenant AND id=p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_FOUND'; END IF;
  IF r.graph_parent_id IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_MIGRATE_GRAPH_ROOT'; END IF;
  IF r.status<>'pending' OR r.deadline<=clock_timestamp() THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING'; END IF;
  IF p_expected IS NULL OR r.row_version<>p_expected THEN RAISE EXCEPTION 'APPROVAL_STALE_VERSION'; END IF;
  IF p_target_version IS NULL OR p_target_version=r.definition_version OR NOT EXISTS(
    SELECT 1 FROM approval.definitions WHERE tenant=p_tenant AND key=r.definition_key AND version=p_target_version
  ) THEN RAISE EXCEPTION 'APPROVAL_MIGRATION_TARGET_INVALID'; END IF;
  PERFORM approval.check_execution_version(r.execution_version);
  IF approval.authorize_migration(p_tenant,p_run,p_actor,p_target_version) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'APPROVAL_MIGRATION_FORBIDDEN';
  END IF;
  PERFORM approval.cancel(p_tenant,r.requester,gen_random_uuid(),p_run,p_expected);
  receipt:=approval.start(p_tenant,r.requester,gen_random_uuid(),r.definition_key,p_target_version,r.entity_id,p_snapshot);
  new_run:=(receipt->>'id')::uuid;
  INSERT INTO approval.instance_migrations VALUES(p_tenant,p_run,new_run,p_actor,p_reason,clock_timestamp());
  INSERT INTO approval.events(tenant,run_id,kind,actor,detail) VALUES
    (p_tenant,p_run,'migrated_out',p_actor,jsonb_build_object('targetRunId',new_run,'targetVersion',p_target_version,'reason',p_reason)),
    (p_tenant,new_run,'migrated_in',p_actor,jsonb_build_object('sourceRunId',p_run,'sourceVersion',r.definition_version,'reason',p_reason));
  receipt:=receipt||jsonb_build_object('migrationSourceRunId',p_run);
  INSERT INTO approval.receipts VALUES(p_tenant,p_request,command,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON TABLE approval.instance_migrations FROM PUBLIC;
REVOKE ALL ON FUNCTION approval.authorize_migration(text,uuid,text,integer),
  approval.migrate_run(text,text,uuid,uuid,bigint,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval.migrate_run(text,text,uuid,uuid,bigint,integer,jsonb,text) TO supacloud_approval_operator;
COMMIT;
