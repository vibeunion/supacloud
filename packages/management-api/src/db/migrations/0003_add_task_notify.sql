-- Migration: Add LISTEN/NOTIFY trigger on project_tasks table
-- When a task is inserted or its status changes, fire a PG NOTIFY

CREATE OR REPLACE FUNCTION notify_task_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'task_' || NEW.status,
    json_build_object(
      'id', NEW.id,
      'project_ref', NEW.project_ref,
      'task_type', NEW.task_type
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger fires on INSERT (new task) and UPDATE (status change)
DROP TRIGGER IF EXISTS trg_task_notify ON project_tasks;
CREATE TRIGGER trg_task_notify
  AFTER INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION notify_task_change();
