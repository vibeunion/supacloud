select
  coalesce(nullif(error, ''), 'Unknown error') as message,
  count(*)::int as count
from project_tasks
where project_ref = :project_ref::text
  and status in ('failed', 'dead_lettered')
  and updated_at >= now() - interval '24 hours'
group by 1
order by count desc, message asc
limit 5
