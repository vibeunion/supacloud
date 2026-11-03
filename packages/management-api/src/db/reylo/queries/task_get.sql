select
  id,
  project_ref,
  task_type,
  status,
  attempt,
  max_attempts,
  next_run_at,
  lease_until,
  started_at,
  completed_at,
  created_at,
  updated_at
from project_tasks
where id = :id::uuid
