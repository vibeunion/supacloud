# Worker Runtime Recipes

These optional recipes extend the existing pgflow worker. Bun/TypeScript stays
the default; Go is opt-in. They are not a production deployment or an iBOSS
implementation, and add no second scheduler or task ledger.

## Transactional Admission

`@supacloud/worker/admission` exposes `submitBoundedTask(sql, binding, prepare)`.
The mandatory application callback authorizes the current actor/entity/revision
and persists intent using the supplied transaction. Return an existing receipt
with `replay: true`, or the new input and operation key. Intent and PGMQ send
commit together; rejection rolls both back. The callback must not perform
network calls or external effects and must check operation-key/input conflicts.

Replay is checked before capacity, so an accepted operation stays readable when
the queue is full. Use the application's existing command/operation authority.
Do not add another job ledger in the callback.

The optional SQL feature is installed explicitly after pgflow:

```sh
# Render only; review and apply through the approved database deployment path.
bun run admission:render project-a
```

The renderer binds the project, holds an installation lock and records a
checksum. A changed definition requires an explicit migration. It neither
changes the pinned upstream migrations nor starts jobs.

Configure `supacloud_worker.admission_limits` with one `project` row and one row
per allowed `scw_` queue. Each requires `max_pending` and `max_per_second`.
Missing configuration fails closed. Counts include leased/retrying messages,
not only immediately visible messages. Project capacity covers its `scw_`
queues. Rate limits use a one-second fixed window, not a smooth-rate guarantee.
Choose budgets from the approved workload, not the fixture numbers.

Every producer locks the project budget before the queue budget. The small
budget table stores only quota configuration/counters. Only trusted server
producers may use this function/policy state. Keep browsers/tenants away from
PGMQ and expose the authorized domain command instead. This is not protection
from a database administrator or a legacy producer bypassing admission. Route
all relevant producers through it before claiming application-wide enforcement.

Map `WORKER_QUEUE_FULL`, `WORKER_PROJECT_FULL` and `WORKER_RATE_LIMITED` to a
bounded retryable response, such as HTTP 429 with `Retry-After: 1`. Other errors
are redacted. Retries retain the operation key; a timeout is an unknown result,
not permission to execute an external side effect again.

## Health And Timing

`@supacloud/worker/telemetry` wraps decode/authorization/execution and provides
`measure` for SQL reads, computation, writes and external calls. Histograms have
fixed buckets/stage labels only; they never contain task data or error text.

Loopback-only `/live`, `/ready`, `/metrics` endpoints distinguish process
liveness from progress. Readiness fails on missing/stale queue probes, stop,
excess queue age or overlong active work. Probes cannot overlap. The application
must supply bounded query/connection timeouts. The reporting recipe checks a
unique process name's fresh pgflow heartbeat as well as queue state; a successful
`SELECT 1` alone does not prove a working consumer.

Scrape through a local agent or authenticated proxy. Counters reset on restart;
durable domain receipts do not. Readiness is an admission/alert signal, never a
reason to blindly retry a side effect.

## Checkpointed Export

`packages/worker/examples/reporting` is an executable CSV-export recipe:

1. Apply `schema.sql` to a disposable/example database. Customer applications
   adapt it into their reviewed migrations, not a worker startup hook.
2. Insert authorized source rows, then freeze their revision. Database triggers
   prevent changes to a frozen source. Text size and positive keyset IDs are
   bounded; monetary integers remain exact strings.
3. Call `submitReport` with a **trusted authenticated actor**, stable operation
   UUID and source revision. An actor ID supplied by a browser is not trusted.
4. The independent worker reads numeric keyset pages and publishes immutable
   content-addressed chunks before committing checkpoints. Restarts verify and
   reuse committed chunks. Completion checks exported versus source row counts.
5. Unique domain receipts prevent repeated completion effects. Cancellation
   retains checkpoints; non-cancellation failures record bounded error/attempt
   information and become a domain failure when attempts are exhausted.
6. `downloadReport` rechecks actor/completed state and streams verified chunks.
   Text spreadsheet formulas are neutralized; numeric columns remain exact.

The local artifact adapter is for an operator-provisioned private directory,
not an untrusted-file sandbox or a multitenant storage service. Customer code
should adapt it to existing authorized object storage. Retain artifacts across
restarts and clean abandoned `.tmp-*` files with an operator retention job.
Do not delete shared content-addressed chunks during one operation's rollback.

Additional recipe environment:

| Setting | Purpose |
| --- | --- |
| `SCW_DOMAIN_PG_CONNECTIONS` | Separate domain SQL pool cap, 1-16 |
| `SCW_ARTIFACT_DIRECTORY` | Private persistent artifact directory |
| `SCW_REPORT_BATCH_SIZE` | Keyset page size, 1-1000 |
| `SCW_HEALTH_PORT` | Loopback probe/metrics listener |
| `SCW_MAX_QUEUE_AGE_SECONDS` | Queue-age readiness budget |

The sample binds `scw_reports` / `report.generate` and derives attempts from the
queue retry limit. The service manifest optionally accepts `artifactDirectory`
under `/var/lib/scw/<project>` and grants only that path write access. Provision
it with the worker user's ownership before starting. Keep source, chunking and
queue semantics compatible across rollback. Customer authorization, retention,
encryption and review policies remain application responsibilities.
The recipe includes `worker-delivery.json` and `runtime.env.example`; the
database/identity settings are deliberately empty until provisioned.

## Optional Go Adapter

`packages/worker/examples/go-accounting` is a standard-library-only service
normalizing bounded Accounting batches. It does not implement RADIUS, subscriber
authentication, direct BNG collection, financial deduplication or billing.

```sh
cd packages/worker/examples/go-accounting
go test main.go main_test.go
go build -trimpath -o accounting-worker .
```

Set `SUPACLOUD_PROJECT_REF`, `SCW_NATIVE_TOKEN` (at least 32 bytes, provisioned
separately), `SCW_NATIVE_CONCURRENCY` (1-32) and `SCW_NATIVE_ADDRESS` (explicit
loopback host/port). The version-1 `POST /v1/accounting/normalize` contract uses
the bound project, stable operation ID and at most 1000 records / 1 MiB.
Requests require a bearer credential; other projects, unknown fields, invalid
timestamps and noncanonical/overflowing uint64 counters are rejected.

Counters stay strings. Cumulative counters are NOT summed as billable traffic;
session reconciliation owns that policy. The service provides concurrent
admission (429), HTTP timeouts, health, authenticated metrics and bounded
SIGTERM draining. `worker.service` is a resource-limited deployment template,
not an installer. Provision the non-root user, immutable binary and root-owned
secret file, and retain a verified previous release for rollback.
The included `runtime.env.example` deliberately leaves the token empty so an
unconfigured service refuses to start.

`@supacloud/worker/native` is the typed TypeScript client. It validates matching
identity/results, enforces deadlines/body limits, refuses redirects and requires
HTTPS outside loopback. Use TLS/mTLS and network policy for remote deployment;
the default Go listener is intentionally private. Record calls under the
`external` timing stage.

Only this side-effect-free computation may be explicitly retried with the same
operation ID. Do not copy that behavior to payments, resource reservations or
device changes; retain their durable operation and unknown-result semantics.

## Local Acceptance

From `packages/worker`, with Docker, Bun, locked dependencies and optional Go:

```sh
SCW_RUNTIME_ACCEPTANCE=1 SCW_NATIVE_ACCEPTANCE=1 \
SCW_ACCEPTANCE_OUTPUT=/absolute/path/local-measurements.json \
bun test tests/runtime.test.ts
```

This single focused file uses the pinned disposable PostgreSQL fixture, a
separate limited Bun container, temporary artifacts and loopback ports. It
never reads application `.env` files or connects to a supplied production DB.
Normal completion/failure removes its containers/artifacts.

It verifies queue/project/rate budgets and rollback, frozen input, runtime
permission denial, repeated delivery after killing a worker following a committed
effect, checkpoint resume, download authorization, graceful stop, actual cgroup
limits, connection budgets and fixed-offered-rate API measurements during real
CSV exports. It also builds Go and exercises it through the TypeScript client.

The JSON retains raw samples, windows, workload, budgets and outcomes. These
short local regression limits are not customer SLAs. Customer acceptance still
requires approved hardware, scale, arrival patterns, failure scenarios and
longer observation. Local cgroup readback does not attest production systemd.

### Recorded Local Run: 2026-10-04

Source candidate: `233860f0` (includes the concurrent branch updates).
Raw evidence: [local acceptance JSON](worker-local-acceptance-2026-10-04.json).

| Observation | Result |
| --- | --- |
| Worker resource caps | 0.5 CPU, 256 MiB, no swap, 64 processes/threads |
| Concurrent CSV work | 300 exports x 10,000 immutable rows |
| Batch completion | 300/300, 41.540 seconds |
| Baseline / mixed observation windows | 10 seconds each, 500 requests each |
| API offered load during batch | 50 requests/second |
| API errors during batch | 0 |
| Baseline / mixed API P99 | 2.370 ms / 0.851 ms |
| Peak observed worker database connections | 4, budget 5 |
| Peak cgroup memory | 112,562,176 bytes |
| Runtime test / delivery test | 6 passed / 12 passed |

The runtime test also passed forced-kill redelivery with one completion receipt,
checkpoint resume, unauthorized download denial, empty exports, terminal failure
receipts and the built Go protocol/shutdown checks. Go's separate focused tests,
the package build and the scoped recipe typecheck passed. Temporary containers
were removed.

This is a short local regression, not a saturation test or a customer SLA.
Sequential sampling/cache warming can explain the lower mixed P99; it is not
evidence that batch work improves API latency. Customer equipment, real traffic
and long-duration fault/recovery acceptance remain separate release gates.

An earlier 2/3-second run on candidate `b062ccdd` failed the unchanged relative
P99 gate: baseline 2.392 ms, mixed 99.390 ms. Its
[failed raw sample](worker-local-acceptance-2026-10-04-short-window-failed.json)
is retained. The cause of that outlier has not been established. The subsequent
run increased sample windows and workload, retained the same latency/error
thresholds, and added database timing plus offered-arrival delay samples.
That pass does not erase the earlier failure or establish long-term stability.
