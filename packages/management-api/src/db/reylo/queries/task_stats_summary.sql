select
  count(*) filter (where status in ('leased', 'running'))::int as running,
  count(*) filter (where status = 'retry_scheduled')::int as retry_scheduled,
  count(*) filter (where status = 'dead_lettered')::int as dead_lettered,
  count(*) filter (
    where status in ('failed', 'dead_lettered')
      and updated_at >= now() - interval '24 hours'
  )::int as failed_last_24h,
  count(*) filter (
    where status = 'cancelled'
      and updated_at >= now() - interval '24 hours'
  )::int as cancelled_last_24h
from project_tasks
where project_ref = :project_ref::text
