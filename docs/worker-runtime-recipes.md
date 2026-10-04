# Worker Runtime Recipes

These optional recipes extend the existing pgflow worker. Bun/TypeScript stays
the default; Go and scriptc are opt-in native Worker runtimes. They are not a
production deployment or an iBOSS implementation, and add no second scheduler
or task ledger.

Managed execution groups own admission, versioned queues, resource budgets and
report export. See [Worker Execution Groups](worker-execution-groups.md) for
the current schema and application integration contract.

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

## Optional Go Adapter

`packages/worker/examples/go-accounting` is a standard-library-first service
normalizing bounded Accounting batches. It does not implement RADIUS, subscriber
authentication, direct BNG collection, financial deduplication or billing.

The community `supabase-go` module can be used by a Go Worker, but it is not the
official Supabase Go SDK. The upstream repository's September 2026 notice says
the codebase is not actively maintained and will be superseded by an official
SDK. Keep it optional until the official client is available and has passed the
same workload, timeout and failure tests. This recipe therefore places the
dependency behind the `supabase_sdk` build tag and uses it only for an
explicit, read-only readiness probe.

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

### Optional Supabase Go SDK probe

Build the SDK-enabled variant only when the customer has approved the
community-module supply-chain and compatibility review:

```sh
cd packages/worker/examples/go-accounting
go test -tags supabase_sdk .
go build -tags supabase_sdk -trimpath -o accounting-worker .
```

Set `SCW_SUPABASE_URL`, `SCW_SUPABASE_KEY`,
`SCW_SUPABASE_PROBE_TABLE` and optionally `SCW_SUPABASE_TIMEOUT_MS` (50-5000,
default 750). The table must be a single validated identifier. The SDK probe
runs only when `/ready` is requested; it is never on the Accounting request
path and does not claim, settle or retry queue messages.

`SCW_SUPABASE_KEY` is deliberately separate from the platform's
`SUPABASE_SERVICE_ROLE_KEY`. Use a project-scoped, least-privilege key with RLS
or a dedicated read-only probe relation. Do not put a service-role key in the
Go Worker's environment merely to enable this probe. A failed probe returns
unready without exposing upstream error text. The SDK's PostgREST path supports
request contexts, so the probe has a hard deadline; critical writes should
still use the existing transactional PostgreSQL/RPC boundary until the
official Go SDK and its context/transport behavior are reviewed.

Only this side-effect-free computation may be explicitly retried with the same
operation ID. Do not copy that behavior to payments, resource reservations or
device changes; retain their durable operation and unknown-result semantics.

## Optional scriptc Worker Runtime

`scriptc` is a build-time option for Workers that need a native executable
artifact. It is selected in delivery metadata with `runtime: "scriptc"` and
uses the same systemd resource limits, project identity, restart policy,
readiness boundary and artifact rollback as a Go executable. It does not add a
second queue, scheduler or task ledger.

The runtime manifest must point both `runtimePath` and `entrypoint` at the
content-addressed executable:

```json
{
  "runtime": "scriptc",
  "runtimePath": "/opt/scw/project-a/releases/candidate-001/report-worker",
  "entrypoint": "/opt/scw/project-a/releases/candidate-001/report-worker"
}
```

The optional `@supacloud/worker` helper discovers `scriptc` through
`SUPACLOUD_SCRIPTC_PATH` or `PATH` and invokes the pinned command shape:

```sh
scriptc build worker.ts -o report-worker
```

Use `dynamic: true` only after reviewing the resulting dependency and API
coverage. `scriptc` remains experimental and supports a subset of
JavaScript/TypeScript and Node APIs; build success is not behavioral
equivalence. Keep Bun/Go as the rollback candidates until differential,
cancellation, timeout, memory and long-duration acceptance pass.

## Local Acceptance

From `packages/worker`, run the focused delivery test and the managed execution
group test from the repository root:

```sh
bun test tests/delivery.test.ts
bun test ../../scripts/worker-execution-groups.test.ts
```

The execution-group suite includes the opt-in PostgreSQL acceptance and skips
it unless its disposable-database flag is explicitly enabled. These local
checks do not establish customer capacity or production deployment readiness.

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
