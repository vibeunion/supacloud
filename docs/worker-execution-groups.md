# Worker execution groups

Status: implementation and local acceptance tooling. This is not a production
capacity certificate. No existing queues, approvals or workflows migrate
automatically.

## Placement and ownership

`interactive` means short asynchronous work; HTTP transactions stay in the API.
`batch` means bounded exports, reconciliation or billing shards. Runtime is a
separate dimension. Version 1 supports Bun and the pinned pgflow queue adapter.
Unsupported runtimes, hard-timeout claims and arbitrary scheduling tags fail
configuration validation.

An execution group binds exactly one compiled Job name, one versioned queue,
one Worker target and one project. Multiple replicas consume that queue through
the same existing engine. No new scheduler or task-result ledger is created.
PGMQ/archive state is not a business completion receipt.

## Configuration

The following goes inside the existing application's `delivery` configuration.
The `Reports` module must declare exactly one Job named `report.generate`.
The host exports `createDeliveryWorker(modules)` and returns a
`createExecutionGroupWorker()` handle. Reuse domain handlers or `executeJob`;
never wrap another polling Worker around pgflow.

```json
{
  "version": 1,
  "targets": [
    { "name": "reports", "kind": "jobs", "modules": ["Reports"], "isolation": "process" }
  ],
  "runtime": { "processIsolation": true, "durableQueue": true, "capabilities": [] },
  "build": { "workerApplications": [{ "target": "reports", "source": "host/reports.ts" }] },
  "execution": {
    "groups": [{
      "name": "reports-batch-v1",
      "target": "reports",
      "workloadClass": "batch",
      "executor": "pgflow-queue",
      "runtime": "bun",
      "queue": "scw_reports_v1",
      "taskKey": "report.generate",
      "definitionVersion": "1",
      "replicas": 1,
      "maxReplicas": 2,
      "concurrencyPerReplica": 1,
      "resources": { "cpuLimit": 1, "memoryLimitMiB": 1024 },
      "database": { "engineConnectionsPerReplica": 2, "handlerConnectionsPerReplica": 2 },
      "lifecycle": {
        "executionTimeoutSeconds": 120,
        "visibilityTimeoutSeconds": 180,
        "shutdownGraceSeconds": 30
      },
      "retry": { "maxAttempts": 3 },
      "admission": { "maxOutstandingOperations": 1000 }
    }]
  }
}
```

These are starting values, not an SLA. The visibility timeout must cover the
execution deadline, shutdown grace and 30 seconds of scheduling/settlement
margin. `maxAttempts` includes the first attempt; the pinned engine receives
`maxAttempts - 1`. There is no lease renewal. Short shutdown grace can force an
unclean exit while the engine is finishing its database poll.

The group is included in the compilation plan, object input digest, immutable
release inventory and runtime activation. Existing CLI build/import/configure/
activate operations remain the delivery path; new generic endpoints are not
required. Old schema readers reject unknown fields instead of ignoring policy.

## Systemd backend

The supported managed backend is Linux systemd with cgroup v2. A group produces
`target-r1`, `target-r2`, etc. Each replica keeps the same immutable executable
but receives its own environment file, unit, process identity and health record.
Environment configuration is still keyed by the logical target, not replicas.

The supervisor sets CPU quota, memory/swap limits, accounting, process-group
termination and shutdown deadlines. Both broker implementations accept and
validate the new resource directives. Readiness checks both `systemctl show`
and the actual cgroup `cpu.max`, `memory.max`, `memory.swap.max` values. Missing
controllers or unsupported resource reporting never count as verified limits.

Do not install only the Management API change: deploy the corresponding
`scripts/lib/systemd_unit_broker.sh` through the normal platform release path.
Do not attempt host systemd operations from the macOS development workspace.

The delivery entry verifies that the host adopted the exact execution policy
and exposes health plus a fatal-failure channel. Grouped Workers emit bounded
health records every five seconds. Startup-only logs are insufficient;
readiness requires a recent healthy record for the current PID/invocation and
verified resource controls. Database unavailability is unhealthy, not an
instruction to spin in an unbounded restart loop.

CPU/memory isolation is enforced at the OS boundary. Connection limits in the
group configure the two trusted pools and reserve capacity; they are not a
sandbox against arbitrary application code opening additional connections.
Use project-specific, non-superuser roles and database-side role limits where
required. A shared database/disk still shares lock, cache and I/O contention.

## Operator budgets

The Management API operator sets `SUPACLOUD_APPLICATION_WORKER_BUDGET_JSON`,
for example:

```json
{ "cpu": 4, "memoryMiB": 4096, "connections": 16, "concurrency": 8 }
```

This is the residual host budget after API, database, maintenance and existing
non-grouped services. It is not an application-controlled environment variable.
Missing/invalid budgets block grouped allocations.

The existing host-wide allocation transaction reserves maximum replicas,
including engine AND domain connections. Concurrent allocations cannot both
spend the last capacity. All unretired activation reservations count, even
after a failed activation or process shutdown. This deliberately requires
headroom for a replacement release until the prior activation is explicitly
observed stopped/unrouted and retired through the existing retirement path.
Never delete metadata to recover capacity.

## Database preparation and admission

Run the existing explicit pgflow installer for the target project's approved
database/profile. Migration `supacloud_002` adds admission accounting after the
existing pinned engine migrations. Startup performs no DDL.

An operator provisions `supacloud_worker.admission_limits` with the exact
approved group name and maximum outstanding count. Application roles get
schema usage and only required function execution; they do not get permission
to raise quotas. Browser roles retain no access. Provision queue and handler
grants separately, using the selected project's existing least-privilege model.

The server-owned submission handler:

1. Authenticates and authorizes the current actor, object and revision.
2. Opens the existing domain transaction.
3. Calls `admitWorkerOperation` with a stable operation ID and canonical input fingerprint.
4. Writes domain intent and queue/outbox intent in that same transaction.
5. Returns the existing domain operation receipt.

Do not catch a capacity error and commit a partial transaction. Map a known
quota refusal to a retryable admission response. Returning an existing
authorized operation is a replay, not a new admission.

The quota row serializes competing admissions. Tokens retain an input
fingerprint, allowing idempotent replay after release without admitting a
second operation. They hold no business result or workflow state. Domain
terminal confirmation and `releaseWorkerOperation` must share a transaction.
Unknown results, retry exhaustion, archive and cancellation requests do not
release quota. Explicit application/operator reconciliation is required.
The reconciliation view detects accounting drift; it does not invent terminal
domain evidence. Do not delete tokens inside the supported idempotency window.

## Report export sample

`packages/worker/examples/report-export.ts` and `.sql` provide a bounded CSV
export with server-side authorization, immutable source revision, keyset-style
page callbacks, limited page/row/output sizes, incremental writes, immutable
object publication and transactional result/quota release.

Integrate the sample with the application's existing source and object storage
adapters. `open()` must write to a private, server-selected namespace and
conditionally publish immutable bytes. Repeating an operation must return the
same object for the same digest and reject different bytes. Do not use a
plain overwriting PUT as the idempotency implementation.

The sample uses PGMQ in the same PostgreSQL database: intent and queue insertion
are one transaction, so an additional dispatcher is unnecessary. For external
brokers, retain the existing transactional outbox and dispatcher instead.

`result()` reauthorizes access before returning an object reference. Actual
download authorization remains the storage/domain service's responsibility.
The filesystem writer under `scripts/fixtures` is a disposable test adapter,
not a production object-storage backend.

The sample restarts a bounded export from the immutable source after failure.
It is not a resumable multi-hour export: larger work must be split into
versioned shards/checkpoints or external jobs. Archived failures retain their
admission token until an authorized reconciliation confirms their outcome.

## Timeout, shutdown and version safety

The deadline covers validation, authorization and handler execution. The
signal is cooperative, not proof that an external operation stopped. A deadline
fails the host; the supervisor ends the process after the shutdown grace while
the message lease is retained. Synchronous CPU loops can block JS timers:
this mode is for trusted bounded/I/O work, not arbitrary hard-timeout compute.
Use an isolated supervised compute service for such tasks.

Do not switch to another implementation after a side-effect timeout. Preserve
the operation ID and reconcile the authoritative downstream result. Duplicate
delivery after a committed result must read the result instead of repeating
the effect.

An incompatible task version requires a new queue. In-place removal/change of
an old route is blocked unless `verifyWorkerRetirement` supplies actual domain
evidence: pause admission, confirm zero held operations and an empty queue
using `requireDrainedWorkerGroup`, then transition. The verifier must use the
old project's approved database connection. It must not trust caller-provided
booleans or a queue length observed before admission was paused.

For overlap, deploy distinct versioned applications and keep the old worker
running until drained; include both in the resource budget. A code rollback
never reverses completed payments, exports or device operations. No queue,
in-flight task or database migration is deleted or rewritten automatically.

## Metrics and acceptance

Health includes active/completed/failed/timed-out attempt counters, RSS and
bounded execution/queue-wait histograms with bucket ceilings
10/50/100/500/1000/5000/30000/+Inf milliseconds. Queue-wait is message age and
therefore includes previous attempts for retries. Health reflects the domain
probe and adapter lifecycle, not a guarantee of successful processing of every
future message. Collect engine queue/oldest-age and database lock/pool metrics
from the existing monitoring stack; keep operation IDs out of metric labels.

`acceptWorkerMixedLoad` provides paired, fixed-offered-rate API measurements
with an application-owned batch submission and completion probe. Saturated
clients count dropped requests instead of silently lowering load. It records
P95/P99, failures, scheduling lag, drain observation and explicit approved
thresholds. Request/completion adapters must honor abort signals. The caller
must record hardware, runtime/build versions, immutable dataset and confirm
batch/API overlap; the returned `passed` is not a production SLA certificate.
Run warmup and repeated steady/peak/long-soak experiments separately.

Focused local verification:

```sh
bun test scripts/worker-execution-groups.test.ts
WORKER_GROUP_DATABASE_ACCEPTANCE=1 bun test scripts/worker-execution-groups.test.ts
git diff --check
```

The opt-in test uses a disposable local PostgreSQL container and real child
processes. It covers admission contention/rollback/replay, host allocation
contention, version rejection, restart after object publication, no duplicate
published object, authorized result lookup, graceful stop and a hung handler.
It also exercises both broker validators, immutable artifact policy retention,
activation reservation guards and fail-closed route retirement.
It does not prove target-host cgroup enforcement or customer capacity.

Release gates still outstanding until performed on the approved target:
broker/platform rollout, least-privilege credentials, real cgroup readback,
approved customer mixed-load targets, long-soak and operator recovery signoff.
Implementation, local verification, merge, deployment and customer acceptance
must remain separate states.
