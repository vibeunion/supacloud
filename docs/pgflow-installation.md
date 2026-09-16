# Optional pgflow Process Profile

This profile is opt-in and separate from human approval. It installs the complete
SQL migration set shipped by `@pgflow/core@0.16.0`; it does not replace pg_durable
or migrate existing workflow instances.

## Database Prerequisites

Run against the selected project database as its installation owner:

- PGMQ >= 1.5, including the `headers` attribute on `pgmq.message_record`.
- pg_cron and pg_net binaries, with pg_cron preloaded and configured for this
  database. The upstream migration installs both extensions.
- An initialized Vault (`vault.decrypted_secrets`) and Realtime database
  (`realtime.send(jsonb,text,text,boolean)`). Initialize the project's actual
  Realtime service first. Production installation never creates substitute
  Realtime functions.

The SupaCloud PostgreSQL Dockerfile already installs the extension binaries.
Pigsty must install equivalent packages for its selected PostgreSQL major.
Having a binary installed is different from enabling it in a project database.
Run this installer after SupaCloud project and Realtime initialization, not in
the empty-cluster `initdb` hook.

These prerequisites describe `PGFLOW_PROFILE=dedicated` (the default).
For Pigsty/shared clusters select `PGFLOW_PROFILE=shared`: only PGMQ and real
Realtime are required in each tenant database. The installer uses PostgreSQL's
parser to exclude the pinned upstream HTTP wakeup/cron setup statements, keeping
the engine SQL unchanged. pg_net and Vault are not required in this profile.
pg_cron remains in the cluster's existing metadata database. Never change
`cron.database_name` to onboard a tenant.

## Shared Pigsty And Runtime Roles

Run the following with administrative installer credentials. Existing application
accounts and database CONNECT grants are not modified automatically:

```sh
export PGFLOW_PROFILE=shared
export SUPACLOUD_PROJECT_REF=your-project
export PGDATABASE=your_project_database
bun run db:install --apply
PGFLOW_INSTALL_ACTION=roles bun run db:install --apply
# Publish the versioned Flow shape using a trusted deployment connection.
# Runtime startup verifies it; it cannot publish or recompile definitions.
PGFLOW_INSTALL_ACTION=queue-grants bun run db:install --apply
PGDATABASE=postgres PGFLOW_TARGET_DATABASE=your_project_database \
  PGFLOW_INSTALL_ACTION=schedule bun run db:install --apply
```

Replace `postgres` with the actual `cron.database_name`. The scheduler binds a
deterministic per-project job to its database, command and installer account.
Each 15-second invocation switches to the project's NOLOGIN recovery role and
calls the project-bound reaper. Both libpq and background-worker cron modes are
supported; in libpq mode the cron account must already have working host-local
authentication. Provision that through the cluster operator; never put passwords
in scheduled SQL. Monitor `cron.job_run_details` for actual successful executions.
For Pigsty's local peer-authenticated postgres account, set
`PGFLOW_CRON_SOCKET=/var/run/postgresql` when scheduling. This sets only that
project job's connection endpoint, not global cron or pg_hba settings.

The roles action creates deterministic `scw_owner_*`, `scw_worker_*` and
`scw_recovery_*` roles (names returned by `scripts/scheduler.ts:roleNames`).
Only the worker role should be given LOGIN and a generated password through
the operator's secret manager. Grant CONNECT to its tenant database, and only
the domain-table privileges the handler needs. Store the connection URL in a
root-owned service environment file with mode 0600.
Use TLS in runtime database URLs (`sslmode=verify-full` with the cluster CA and
matching server hostname for remote production connections). Pigsty may reject
unencrypted runtime connections even from loopback.
Pigsty's HBA rules must also admit the new login: add an exact `hostssl`
rule for the tenant database, generated worker role and worker host CIDR,
using `scram-sha-256`. Do not grant membership in a broad application role
merely to match its HBA rule. Persist the rule in the cluster's managed HBA
configuration before a later Pigsty reconfiguration.
Do not grant membership in the owner/recovery roles, superuser, BYPASSRLS or database creation privileges.
If databases permit PUBLIC CONNECT, remove it only as a separately reviewed
cluster policy change after preserving existing application grants.

The runtime cannot run migrations, delete runs, publish definitions or invoke
recovery. Security-definer entrypoints use locked search paths and a NOLOGIN
owner. Realtime INSERT permission is limited by a pgflow-topic policy when RLS
is enabled. After publishing another versioned flow, reapply queue grants.
Upstream sends public (`private=false`) run broadcasts including outputs.
Do not enable public Realtime broadcast subscriptions for sensitive workflow
data; this installer does not change the upstream event contract or the
Realtime server's channel authorization configuration.
Realtime tenants can hibernate without subscribers, leaving message partitions
out of date. Initialize/wake the actual tenant before broadcast acceptance and
monitor partition maintenance. `realtime.send` can swallow insertion errors:
successful workflow completion alone does not prove notification delivery.
The authoritative task API remains usable independently of broadcasts.
This role profile covers **native Flow execution**; standalone queue mode needs
a separately reviewed queue-specific grant profile and is not covered by this
least-privilege claim.

For SQL-only workers, upstream still requires `SUPABASE_SERVICE_ROLE_KEY` to be
nonempty. Use a nonprivileged placeholder, not a real service-role credential.
Handlers needing HTTP APIs must use a separate explicitly scoped credential.
Never interpret a restricted SQL login plus an unrestricted API key as least
privilege.

Rollback: stop the dedicated worker, unschedule only its `scw_recover_*` job in
the cron metadata database, and revoke LOGIN from its runtime role. Preserve
engine tables, migration receipts and run history; do not drop tenant data.
Switching profiles is refused rather than silently rewriting an installation.

## Install And Reapply

From `packages/worker`, install the locked dependencies:

```sh
bun install --frozen-lockfile
export SUPACLOUD_PROJECT_REF=your-project
export PGDATABASE=your_project_database
export PGHOST=your_database_host
export PGUSER=your_project_install_owner
# Supply credentials through PGPASSFILE or the execution environment.
bun run db:install --print
bun run db:install --apply
```

The installer checks the connected database name and binds the installation to
the project reference. A transaction-scoped advisory lock, SHA-256 migration
receipts, a version check and one transaction protect repeat/concurrent runs.
A failure rolls back the entire installation. Changed checksums, a different
project binding, unknown newer migration receipts or an untracked pgflow
baseline are refused, not adopted automatically.

The installer retains the upstream stalled-task recovery and log-cleanup cron
jobs, but removes `pgflow_ensure_workers`: process workers are supervised by
the process manager, not woken through Supabase HTTP functions. It revokes
engine/projection access from PUBLIC, anon and authenticated. Install and run
only with credentials scoped to this project; the trusted worker needs engine
write permissions. This profile does not provision login credentials.

## Unified Task Queries

The existing management API exposes a read-only projection, without duplicating
pgflow state into `project_tasks`:

```text
GET /v1/projects/{ref}/tasks?task_type=pgflow&limit=50
GET /v1/projects/{ref}/tasks/pgflow:{run_uuid}
```

Use project backend credentials or administrator authorization. Raw pgflow runs
do not carry a verified end-user identity, so user JWT ownership is not inferred.
The project database is resolved from the existing project registry and the SQL
projection also filters the installation's project binding.

The existing SDK can call `tasks.list({ taskType: "pgflow" })` and
`tasks.get("pgflow:" + runId)`. Default task listing is unchanged. Mixing pgflow
and other task types in one list filter is refused rather than returning
incorrect pagination. Function filters and DLQ filters do not apply.

| Native state | Public state |
| --- | --- |
| Started run, no attempted tasks | pending |
| Started tasks | running |
| Queued retried tasks, no started tasks | retry_scheduled |
| Completed run | succeeded |
| Failed run | failed |

Responses retain `executor` (kind, version, definition, native run ID/status),
`capabilities`, step counts and `blocked_reason`. Permanently stalled runs report
`PGFLOW_PERMANENTLY_STALLED`; they are not marked successful or automatically
converted to failed without authoritative engine evidence.
Raw handler error text and inputs are not exposed by this projection.
Results are returned only to the authorized backend/admin.

Cancel/retry on a pgflow task ID returns `409 TASK_ACTION_UNSUPPORTED`, before
touching the platform task ledger. Native per-step retries remain owned by
pgflow. Subscription/status push integration is not provided by this projection;
use polling. Domain APIs remain responsible for submission authorization and
idempotent external effects.

## Local Acceptance

```sh
cd packages/management-api
bun install --frozen-lockfile
cd ../contracts
bun run build:js
cd ../supacloud-js
bun install --frozen-lockfile --force
cd ../worker
bun install --frozen-lockfile
PGFLOW_DATABASE_ACCEPTANCE=1 bun test tests/worker.test.ts
```

The test creates and destroys its own loopback-only database container using
`supabase/postgres:17.6.1.136`. It applies all pinned engine SQL, checks install
idempotence, checksum and project protections, checks real task routes, and
kills/restarts the actual process worker before/after an idempotent domain
write. Recovery uses real elapsed time and the scheduled upstream reaper.

The fixture implements the database Realtime broadcast contract using the
upstream send implementation and verifies durable event insertion. It does not
run a Realtime network server or claim broadcast delivery acceptance.
This local test is not a Pigsty rollout, production deployment, PostgreSQL 18
acceptance, or proof that arbitrary external APIs are exactly-once.
The dedicated fixture elevates its test login for installation. The separate
shared fixture runs two tenants on PostgreSQL 18 with non-superuser workers,
RLS-protected Realtime tables and centrally scheduled crash recovery:

```sh
docker build -t supacloud-pgflow-test:pg18 -f tests/fixtures/Dockerfile.pg18 .
PGFLOW_DATABASE_ACCEPTANCE=1 PGFLOW_SHARED_ACCEPTANCE=1 bun test tests/worker.test.ts
```

It verifies forbidden DDL, run deletion, migration access, definition deletion,
reaper access and cross-tenant connections, plus persisted completion broadcasts.
Actual target deployment remains a separate acceptance gate.

For a test host with local postgres administrative access and a preconfigured
exact TLS HBA rule, the explicit remote probe is:

```sh
PGFLOW_TEST_ACCEPTANCE=1 SUPACLOUD_PROJECT_REF=your-test-project \
  PGDATABASE=your_test_database PGFLOW_CRON_SOCKET=/var/run/postgresql \
  bun scripts/acceptance.ts
```

This installs the shared profile, uses a separate versioned acceptance flow and
dedicated evidence tables, kills/restarts a real restricted worker and checks
two attempts, one effect, one completion broadcast and successful cron execution.
Temporary runtime credentials are revoked in `finally`; receipts and run history
are preserved. It refuses to overwrite an existing LOGIN-enabled runtime account.
It is a test probe, not a production workload deployment command.

### Verified On September 16, 2026

Updated acceptance: the combined single-file command completed with 16 passing
tests, 115 assertions and no skips/failures (195 seconds), including PostgreSQL
18.4 dual-tenant least-privilege crash recovery and Realtime RLS insertion.

Actual test host `192.168.200.112`, project `stmiwixcxpdjuftnjxqu`, PostgreSQL
18.4: run `685d84ce-2353-4a76-962d-6c1f69672b78` completed after SIGKILL/restart
with two attempts, one domain effect and one persisted completion broadcast.
The existing central cron used peer authentication over its local socket.
The runtime used a tenant-specific TLS HBA rule and its temporary LOGIN was
revoked after acceptance. Realtime was awakened through a real tenant channel,
not replaced with a database fixture.

The test management service was backed up and replaced with binary SHA-256
`c04b2dd34996ef3bf4f112f46f8ea86204689be4380b26f5282d7d8e1e8da822`.
Live task list/detail returned 200, anonymous access 401, cancel/retry 409.
These are test-environment results, not production deployment evidence.

The earlier dedicated-profile command completed locally with 14 passing tests, no failures or skips,
and 109 assertions (about 96 seconds). It exercised:

- All 23 upstream migrations plus the task projection, atomic rollback after
  an intentional final-statement failure, and concurrent repeat installation.
- Project binding, checksum mismatch refusal, anonymous engine access denial,
  active stalled-task cron recovery and disabled HTTP worker wakeup.
- Actual task routes and SDK reads against the real projection (authentication
  and project registry injected for the isolated route fixture), including
  wrong-project reads, unsupported actions, invalid filters and bounded 503s.
- Normal completion, real handler failure/retry, and forced process termination
  before and after the domain write. Both interrupted runs completed after
  restart with one persisted domain effect per operation.

The database image is pinned to manifest digest
`sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00`.
The test disposes of its workers and database. No remote deployment is part of
this evidence.
