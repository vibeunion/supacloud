select
  id,
  task_id,
  project_ref,
  attempt_no,
  status,
  started_at,
  completed_at,
  duration_ms,
  error,
  response_status,
  logs,
  created_at,
  updated_at
from project_task_attempts
where task_id = :task_id::uuid
order by attempt_no desc
