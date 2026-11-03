BEGIN;
SET LOCAL ROLE supacloud_approval_owner;

CREATE OR REPLACE FUNCTION approval.graph_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE child approval.runs;
BEGIN
  IF NEW.execution_version=3 AND OLD.status='pending' AND NEW.status<>'pending' THEN
    PERFORM approval.check_execution_version(3);
    UPDATE approval.graph_nodes SET status='cancelled' WHERE tenant=NEW.tenant AND run_id=NEW.id AND status='waiting';
    FOR child IN SELECT id, tenant, definition_key, definition_version, entity_id, requester, status, step_index, row_version, deadline, engine_id, wait_token, created_at, finished_at, recovery_attempts, recovery_after, recovery_error, timeout_failures, timeout_retry_after, business_snapshot, subject_resolver, execution_version, root_run_id, previous_run_id, review_round, graph_parent_id, graph_facts FROM approval.runs WHERE tenant=NEW.tenant AND graph_parent_id=NEW.id AND status='pending'
      ORDER BY id FOR UPDATE
    LOOP
      UPDATE approval.runs SET status='cancelled',row_version=row_version+1,finished_at=clock_timestamp() WHERE id=child.id;
      UPDATE approval.tasks SET status='cancelled' WHERE tenant=child.tenant AND run_id=child.id AND status='pending';
      INSERT INTO approval.events(tenant,run_id,kind,detail) VALUES(child.tenant,child.id,'graph_parent_ended',
        jsonb_build_object('parentRunId',NEW.id,'parentStatus',NEW.status));
      PERFORM approval.enqueue_wakeup(child.tenant,gen_random_uuid(),child.id,child.engine_id);
    END LOOP;
    PERFORM approval.enqueue_wakeup(NEW.tenant,gen_random_uuid(),NEW.id,NEW.engine_id);
  END IF;
  RETURN NEW;
END $$;
COMMIT;
