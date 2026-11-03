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
  and status in ('pending', 'retry_scheduled')
  and next_run_at <= now()
  and (lease_until is null or lease_until < now())
order by next_run_at asc, created_at asc
limit :limit::int
