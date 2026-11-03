with input as (
  select :project_ref::text as project_ref
)
select
  t.id,
  t.project_ref,
  t.task_type,
  t.status,
  t.payload,
  t.result,
  t.error,
  t.retries,
  t.attempt,
  t.max_attempts,
  t.next_run_at,
  t.lease_until,
  t.started_at,
  t.completed_at,
  t.timeout_sec,
  t.idempotency_key,
  t.trace_id,
  t.cancel_requested_at,
  t.cancellation_reason,
  t.correlation_id,
  t.business_task_id,
  t.invoker_user_id,
  t.auth_authority_ref,
  t.metadata,
  t.function_slug,
  t.function_version,
  t.created_at,
  t.updated_at
from project_tasks t, input
where t.id = :id::uuid
  and (input.project_ref is null or t.project_ref = input.project_ref)
limit 1
