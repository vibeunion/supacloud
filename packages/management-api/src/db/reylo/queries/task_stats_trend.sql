select
  to_char(date_trunc('hour', updated_at), 'MM-DD HH24:00') as bucket,
  count(*)::int as failures
from project_tasks
where project_ref = :project_ref::text
  and status in ('failed', 'dead_lettered')
  and updated_at >= now() - interval '24 hours'
group by 1
order by 1 asc
