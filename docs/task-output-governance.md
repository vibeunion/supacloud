# Shared task-output quotas and scheduled retention

This is resource governance for the opt-in [task output extension](./task-output-events.md),
not a new task engine, gRPC transport, Realtime protocol, or browser identity system.
The existing task state machine, per-task limits and attempt fencing remain authoritative.

## Shared project budgets

`public.project_task_output_quotas` is a private CONTROL-PLANE ledger. All Management
API/worker instances writing the same database share one project row. Its defaults are:

| Budget | Default | Accounting |
| --- | --- | --- |
| Retained producer payload | 64 MiB | `octet_length(payload::text)` on JSONB |
| Retained producer events | 100,000 | Across all tasks and attempts in the project |
| Producer events per minute | 6,000 | Database-clock fixed minute window |
| Producer payload per minute | 8 MiB | Same fixed window |

These count `output.delta`, `output.snapshot`, `progress` and `warning`. Lifecycle
records are exempt so output exhaustion cannot block completion/cancellation. These
are logical payload/event budgets, NOT a physical disk quota: indexes, row overhead,
WAL, lifecycle history, task results, replicas and backups are outside these counters.

An AFTER INSERT trigger charges only inserted events. Task, stream and then project
quota locks serialize concurrent writes. The clock and live attempt lease are checked
again AFTER acquiring the quota lock. Repeating an already committed event is still
acknowledged without charging again; a quota rejection rolls back the event, sequence,
per-task counters and project counters together. The API does not blindly retry writes.

The window is fixed, not sliding: adjacent minute boundaries permit bursts. A backward
clock adjustment does not reset a newer window. Retention/cascade deletion releases
retained capacity, never rate usage or per-task lifetime limits. Event UPDATE/TRUNCATE
is rejected to prevent invisible mutations/accounting drift. Do not disable triggers or
manually edit counters. Direct operator multi-project transactions should keep a
consistent project order; normal API appends affect one task per transaction.

Rate exhaustion returns `429 TASK_OUTPUT_PROJECT_RATE_LIMIT` with conservative
`Retry-After: 60`; retained capacity exhaustion returns `413 TASK_OUTPUT_PROJECT_STORAGE_LIMIT`
without timed retry guidance. Readers can continue replaying retained output. Database
failures/timeouts return the existing sanitized unavailable response, not a false success.

Limits are operator-controlled, not writable by project JWTs or delegated app users:

```sql
-- Trusted CONTROL-PLANE operator only. Preserve counters and existing policies.
INSERT INTO public.project_task_output_quotas(project_ref) VALUES ('your-project')
ON CONFLICT (project_ref) DO NOTHING;
UPDATE public.project_task_output_quotas
SET max_retained_bytes = 134217728, max_retained_events = 200000,
    max_events_per_minute = 12000, max_bytes_per_minute = 16777216
WHERE project_ref = 'your-project';
```

Lowering a limit below existing usage does not delete history; subsequent appends are
blocked until capacity is released or the operator changes the limit. Rate-limit values
are tuning defaults, not a production SLO. No connection/subscription quota is implied.

## Migration and mixed-version rollout

Run the existing `scripts/migrate-task-output-journal.ts --apply` after a verified backup
and control-database identity check. It now applies the journal AND governance SQL in
one transaction, with bounded lock/statement waits. Re-run it on installations that
used the initial journal revision. Existing retained events are backfilled into usage;
reapplication preserves custom limits and rate counters. Large installations should
schedule the migration: it intentionally locks task/journal tables while reconciling.
An over-budget existing project is retained, not truncated during migration.

The updated producer service calls the governed SQL function. Until the complete
migration is present, writes fail unavailable rather than silently operating without
shared limits; existing read history remains accessible. Older append callers are also
subject to database triggers after migration, but may expose generic quota errors.
Drain old execution workers as described in [attempt fencing](./background-attempt-fencing.md).
No production schema change is performed by submitting this PR.

## Bounded retention command

The new command uses a separate single-connection pool and never runs DDL. Default mode
is dry-run; deletion requires `--apply`. Every dry-run/apply transaction checks a REQUIRED
physical database fingerprint derived from the PostgreSQL system identifier, database OID,
name and owner. Merely naming a database `supacloud_meta` is not sufficient.

```sh
# Run in the checked-out repository with DATABASE_URL provided securely.
bun run packages/management-api/scripts/task-output-retention.ts --inspect
# Independently verify that this is the intended control database. Set the returned
# fingerprint in SUPACLOUD_TASK_OUTPUT_CONTROL_FINGERPRINT only AFTER verification.
bun run packages/management-api/scripts/task-output-retention.ts --dry-run --limit 25
bun run packages/management-api/scripts/task-output-retention.ts --apply --limit 25
```

A batch processes at most 25 tasks by default (configurable 1..100), only terminal tasks
completed more than seven days ago. It retains final results, per-task lifetime counters
and the replay watermark. Active tasks are never pruned. A database advisory transaction
lock excludes overlapping cleanup batches across hosts; another instance reports
`lock_acquired: false`, not a fabricated successful batch. All accounting is committed
with deletion, and errors roll back the batch. There is no automatic retry on uncertain
COMMIT. A later scheduled pass is safe because already pruned history is excluded.

The JSON receipt reports `pruned_tasks`, a bounded `eligible_tasks` sample, `has_more`, and
`oldest_eligible_at` after execution. These are not full-table counts. A lost commit reply
returns a failing process status, not an inferred successful receipt. Logs never include
the connection string. Database restoration/owner changes require re-verifying the pin;
do not regenerate it automatically inside the scheduled job.

## Optional systemd deployment

Build and install the command from the reviewed checkout:

```sh
bun build packages/management-api/scripts/task-output-retention.ts --compile \
  --outfile /tmp/task-output-retention
sudo install -m 0755 /tmp/task-output-retention /usr/local/libexec/supacloud/task-output-retention
```

Create a root-owned, mode-0600 `/etc/supabase/task-output-retention.env` through the existing
secret provisioning process. It must contain `DATABASE_URL` and the independently verified
`SUPACLOUD_TASK_OUTPUT_CONTROL_FINGERPRINT`. Do not check credentials into Git or place them
on a command line. Use the control-database maintenance identity, never browser/API keys.

Install the service and timer from `infrastructure/systemd/` only after a successful manual
dry-run. The executable directory must already exist. The unit uses a dynamic OS user,
read-only filesystem, memory/process limits and a 30-second service timeout. The timer
runs once per minute with up to ten seconds jitter. Enabling it is an explicit operator
step, NOT something the application, migration or tests do automatically:

```sh
sudo install -m 0644 infrastructure/systemd/supacloud-task-output-retention.service /etc/systemd/system/
sudo install -m 0644 infrastructure/systemd/supacloud-task-output-retention.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now supacloud-task-output-retention.timer
```

Monitor failed service executions, oldest eligible age, backlog samples, per-project
retained/rate saturation and database storage. Sustained backlog requires adjusting batch
capacity/cadence after measurement. Seven days is an eligibility policy, not a guaranteed
physical deletion deadline. Containers/non-systemd deployments can run the same one-shot
command through their existing scheduler. Disabling the timer stops automatic deletion;
it does not remove retained data or disable quotas.

## Evidence and remaining boundaries

The dedicated PostgreSQL 16/18 CI exercises competing tasks, deduplication, independent
projects, byte/event budgets, rollback, migration reconciliation, expiry under contention,
terminal exemption, fingerprint rejection, dry-run, retained-capacity release, cascades,
cleanup exclusion, grants and the actual HTTP/service error mapping. The command is
compiled in CI and fails without the required pin/configuration.

This is not proof of production throughput, real-browser/GoTrue/model end-to-end behavior,
provider physical cancellation, multi-process runtime crash/Caddy reload recovery, or a
production timer installation. Those remain explicit rollout acceptance gates. The
shared ledger does not replace existing task concurrency, gateway limits or Realtime
connection controls, and does not claim exactly-once external execution.
