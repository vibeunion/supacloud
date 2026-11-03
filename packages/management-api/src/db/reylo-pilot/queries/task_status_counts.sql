select
  status,
  count(*)::int as count
from project_tasks
where project_ref = :project_ref::text
group by status
order by status
