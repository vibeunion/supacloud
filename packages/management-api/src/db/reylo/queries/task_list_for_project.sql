select
  id,
  project_ref,
  task_type,
  status,
  attempt,
  max_attempts,
  next_run_at,
  lease_until,
  created_at,
  updated_at
from project_tasks
where project_ref = :project_ref::text
order by created_at desc
limit :limit::int
