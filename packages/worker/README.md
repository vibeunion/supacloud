# SupaCloud Worker

Optional, private process integration with the published `@pgflow/edge-worker`
and `@pgflow/dsl` 0.16.0 packages. Not yet a published or deployed platform
service. This package does not reimplement polling, retry, concurrency, queue
acknowledgement or DAG execution.

## Ownership

- Application HTTP/RPC: authenticate, authorize the entity, validate revision,
  commit the business intent and return an operation receipt.
- `@supacloud/js`: existing remote task/queue/workflow protocol clients.
- `@supacloud/worker`: start a project-scoped, dedicated Node/Bun worker process.
- pgflow: queue or native Flow execution, retry scheduling and worker lifecycle.
- Domain commands: side-effect idempotency, artifact storage, business state.

Do not add this package to the browser SDK, management API request process,
or the SupaCloud request-scoped Edge Runtime. Upstream installs process signal
handlers and can exit the process. One project and one queue/flow per process;
after stop/failure, let the process supervisor restart a new process.

## Queue Worker

```ts
import { createPgflowQueueWorker } from '@supacloud/worker';

const worker = createPgflowQueueWorker({
  projectRef: 'project-a',
  connectionString: process.env.EDGE_WORKER_DB_URL!,
  queueName: 'scw_reports',
  taskKey: 'report.generate',
  concurrency: 4,
  visibilityTimeoutSeconds: 300,
}, {
  decode: decodeReportRequest,
  authorize: authorizeCurrentReportRequest,
  execute: generateReportIdempotently,
});
await worker.start();
// On an application-owned shutdown: await worker.stop().
```

See `examples/report-worker.ts` for a typed domain integration factory. The
decoder and authorization policy are mandatory. The handler context exposes
project, queue, task, message ID, idempotency key, attempt and shutdown signal,
not database connections, service keys or environment variables. This context
restriction is not a sandbox: handlers are trusted server code.

The already-authorized producer uses the existing queue SDK's `send` method:

```ts
await supacloud.queue('scw_reports').send({
  schemaVersion: 1,
  projectRef: 'project-a',
  taskKey: 'report.generate',
  idempotencyKey: 'report:42:revision:3',
  input: { reportId: '42', revision: '3', sourceFileId: 'file-17' },
});
```

This call is message submission, not durable task result storage. Use the
application command receipt/outbox for atomic business intent and return its
operation ID to the caller. A queue message ID is not a report/task ID.
An idempotency key in the envelope alone does not deduplicate effects.

Only `scw_` queues are accepted to avoid taking over existing platform,
approval or `supacloud_internal_*` queues. Do not run the old queue worker and
pgflow worker against the same queue.

## Native Flow Worker

Use the native DSL rather than a second DSL translating every pgflow feature:

```ts
import { Flow } from '@pgflow/dsl';
import { createPgflowWorker } from '@supacloud/worker';

const flow = new Flow<{ fileId: string }>({ slug: 'scw_report_v1' })
  .step({ slug: 'extract' }, extractText)
  .step({ slug: 'analyze', dependsOn: ['extract'] }, analyzeText);
const worker = createPgflowWorker(flow, {
  projectRef: 'project-a',
  connectionString: process.env.EDGE_WORKER_DB_URL!,
});
await worker.start();
```

Flow handlers are native upstream handlers, not the queue-envelope wrapper:
they receive upstream resources and must perform their own decoding,
authorization, error redaction and idempotent domain commands. Flow input,
dependencies and results stay under the native pgflow contract. This package
does not make `supacloud.workflows.start()` start a pgflow DAG; that existing
method still targets SupaCloud's linear workflow RPC.

Version flow slugs when execution semantics change. Do not rewrite an active
slug and assume existing runs are isolated from handler changes.

## Process And Database Prerequisites

Host environment:

- `SUPACLOUD_PROJECT_REF`: must equal the configured project reference.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: required by upstream's process
  adapter even for ordinary queue mode. SQL-only workers use a nonprivileged
  placeholder key; never inject a real platform-wide service credential.
- Explicit `connectionString`: credentials for this project's database.
  The operator must verify it and the Supabase URL refer to the same project;
  matching a process label cannot prove database ownership.

Provision the upstream **0.16.0** database migrations and compatible PGMQ first.
Even queue mode uses `pgflow.workers` and worker-management functions. The
full upstream migration set also installs pg_cron/pg_net and references
Supabase Realtime/Vault functions; a plain PGMQ database is insufficient.
Review grants, search paths and scheduled jobs before installation.

Worker startup deliberately does not run DDL. An explicit `db:install` command
installs the pinned upstream migrations and private task projection, with
project binding, checksum receipts, an advisory lock and atomic rollback.
See `../../docs/pgflow-installation.md` for dedicated/shared installation and
native Flow least-privilege roles. Process mode uses the external supervisor for restarts;
the installer removes the upstream HTTP worker wakeup job.

## Guarantees And Limits

- Decode/project/task/authorization failures never enter the queue handler.
- Handler errors become bounded codes before reaching upstream retry logs.
  Upstream infrastructure logging needs a separate secret-redaction review.
- Queue mode retries and eventually archives according to upstream policy;
  archive is **not** a SupaCloud task-result record or a new dead-letter API.
- Shutdown is cooperative; cancellation cannot undo an external side effect.
- Leases permit repeat execution. Use idempotent external APIs or a domain
  outbox and reconcile unknown results. Never imply exactly-once effects.
- Queue jobs must fit within their visibility timeout. This adapter adds no
  lease renewal. Long OCR/GPU jobs should submit an external job and poll it in
  later steps, or use a separately verified lease-renewing executor.
- npm 0.16.0 declares numeric PGMQ message IDs, while the database driver can
  return bigint text. The queue boundary accepts exact positive int8 strings
  or safe integers and exposes text without changing upstream settlement IDs.
  Unsafe numeric values are refused; this cannot repair precision already lost
  by a custom database parser. Keep the upstream default int8 text parser.
  Native Flow mode retains upstream ID semantics.
- Artifact URLs, content and secrets do not belong in unbounded queue payloads;
  pass immutable object IDs/revisions and fetch through domain authorization.

Validation: `bun test tests/worker.test.ts` includes strict typing, emitted
artifact checks, pinned-package imports and local boundary/lifecycle tests.
Set `PGFLOW_DATABASE_ACCEPTANCE=1` to additionally exercise the full migrations,
task API projection and actual process kill/restart recovery in a disposable
database. This does not prove Supabase Edge compatibility, OCR throughput,
Realtime network delivery, or production rollout. The package remains private.
