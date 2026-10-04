# Dedicated Worker Resource Delivery

Status: optional, private worker integration. This delivers configuration and
measurement evaluation, not a managed service or a customer capacity guarantee.
No mandatory Go runtime, second scheduler, task ledger or automatic deployment
is added. Optional recipes, admission and local runtime acceptance are described
in [Worker Runtime Recipes](worker-runtime-recipes.md).

## Scope And Acceptance

```gherkin
Scenario: Explicit resource budget
  Given a validated project and queue manifest
  When its Linux systemd service is rendered
  Then CPU, memory, process/thread count, stop time and runtime pool limits are explicit

Scenario: Invalid configuration
  Given a missing limit, privileged user or unsafe manifest value
  When a service is rendered or its worker is bootstrapped
  Then execution fails before starting a queue consumer

Scenario: Mixed workload regression
  Given approved limits and baseline plus concurrent batch/API measurements
  When latency, throughput, errors, batch completion or queue age exceed a limit
  Then the acceptance command exits nonzero with named failures

Scenario: Insufficient evidence
  Given missing measurements or API samples taken outside the batch window
  When acceptance is evaluated
  Then the command refuses to report a pass
```

## Application Entry Point

Build the private package with `bun run build` in `packages/worker`, and deliver
it with the application's locked dependencies. The application supplies the
actual domain handler; the platform cannot invent customer authorization,
report queries or effect receipts.

```ts
import { startQueueWorkerFromEnvironment } from "@supacloud/worker/delivery";
import { reportHandler } from "./report-domain.js";

await startQueueWorkerFromEnvironment(reportHandler);
```

`reportHandler` implements the existing `TaskHandler<T>` contract: decode,
authorize against the current entity/revision, then execute idempotently.
See `packages/worker/examples/report-worker.ts` for that domain boundary.
Keep artifacts in object storage and return domain receipts. Queue archive
does not prove a report, payment or device operation succeeded.

The helper requires all queue limits from the environment and forwards them
to the existing pgflow adapter. It neither implements polling nor installs
another signal handler. pgflow owns cooperative shutdown and queue retries.

## Render And Deploy

Use `packages/worker/examples/worker-delivery.json` as a non-secret manifest.
All values are explicit example settings, not customer sizing recommendations.
One manifest/service binds one project and queue. The entrypoint must reside
inside the declared release directory. Use an immutable release directory,
locked dependencies and a pinned, verified Bun binary.

From `packages/worker`:

```sh
bun run delivery:render examples/worker-delivery.json
```

This prints a service unit only. It does not contact a host, install migrations,
write secrets, enable services or start a consumer. Review the output, then
deploy it through the existing approved release process.

The secret environment file must be provisioned separately, owned by root
with mode `0600`, and contain:

- `EDGE_WORKER_DB_URL`: the least-privilege project worker connection.
- `SUPABASE_URL`: the corresponding project endpoint.
- `SUPABASE_SERVICE_ROLE_KEY`: use the existing nonprivileged placeholder for
  SQL-only workers, never a platform-wide service credential.

The database and URL must be verified against the target project; a matching
project label alone is insufficient. Provision pinned migrations and worker
grants using [the installation procedure](pgflow-installation.md). Startup
never installs them.

Generated `ExecStart` sets the non-secret project/queue/pool configuration
after loading the environment file. Bun runs with `--no-env-file`, so a
release-local `.env` cannot silently override these settings.

On a Linux systemd host, after identifying the approved environment and
reading `hostname` and `hostname -I`:

1. Verify the unprivileged user, executable, release ownership, dependency
   installation, secret-file permissions and database prerequisites.
2. Run `systemd-analyze verify` on the rendered unit before installation.
   The unit requires systemd resource controls supported by the target host.
3. Install through the release mechanism, reload systemd and start the service.
4. Read back `CPUQuotaPerSecUSec`, `MemoryMax`, `MemorySwapMax`, `TasksMax`,
   `MainPID`, `NRestarts` and recent logs. A rendered unit alone is not proof
   that host resource controls are enforced.
5. Submit one authorized domain operation and read its durable result receipt.
   Confirm the worker's engine heartbeat/queue progress. `Type=exec` and an
   active process prove process liveness only, not database readiness or useful
   progress. Alert separately on stale heartbeats, queue age and restart loops.
6. In a disposable environment, kill a worker during a job and verify recovery
   and exactly one domain effect. Existing real-database recovery acceptance is
   opt-in in `tests/worker.test.ts`; it is separate from the delivery unit tests.

The unit sends SIGTERM, allows the configured grace period and then permits
systemd to kill the control group. Forced shutdown and OOM can leave effects
unknown. Reconcile using the original operation ID; do not blindly replay an
external side effect. Restart rate limiting can require operator intervention.

### Resource Boundaries

- `CPUQuota=100%` caps CPU time at approximately one CPU; it does not reserve a
  core for the API. `MemoryMax` and disabled swap constrain this worker's cgroup.
  Confirm behavior on the actual host. API headroom still needs separate sizing.
- `TasksMax` bounds processes/threads, not queue length. `concurrency` bounds
  pgflow execution and `maxPgConnections` bounds its configured SQL pool.
- Domain handlers creating another pool must cap it separately. Sum all pools
  across replicas, plus API and operational headroom. This profile is not a
  cluster-wide database connection quota.
- A separate process does not isolate database I/O, disk contention or an
  overloaded remote service. Apply workload-specific query timeouts, short
  transactions and storage limits where those resources are owned.
- Process limits are not queue admission control. Route trusted producers through
  the optional transactional admission helper before high-volume rollout.
- The filesystem is read-only except private temporary storage. Handlers should
  use object storage; persistent local filesystem workloads need a separately
  reviewed profile.
- The adapter has no lease renewal. Every job must finish within visibility
  timeout. Split batches or submit an external job and poll/reconcile later.

### Rollback

Stop the current unit and confirm its process group has exited before reverting
to a previously verified immutable release and its manifest. Review in-flight
messages for schema compatibility and reconcile unknown effects first. Do not
run old and new incompatible handlers on the same queue, shorten an active
lease, delete receipts or roll back pgflow migrations as an application rollback.
Keep schema versions compatible or introduce a separately managed versioned queue.

## Performance Acceptance

Before measuring, approve hardware, candidate digest, fixed dataset/rule
version, request arrival model, customer workload, concurrency, observation
window, sample floor and each SLO. No default here is a capacity promise.

Capture the same API workload before and during the real batch. Do not switch
to a lighter endpoint for the concurrent measurement. Use an offered-load
generator that records rejected/timed-out requests and missed arrivals; an
unconstrained closed-loop benchmark can conceal saturation.

The evaluator consumes measurements; it is NOT a load generator, profiler or
telemetry collector. It checks baseline and mixed throughput, P95/P99,
error rate, tail-latency regression, sample/window minimums, batch completion
and peak oldest queued-message age. The companion recipe adds stage histograms,
admission controls and opt-in recovery/load acceptance without running anything
against customer systems implicitly.

Input shape is shown in
`packages/worker/examples/performance-evidence.json`. That deliberately
undersampled synthetic example FAILS; do not use it as acceptance evidence.

- `startedAtMs` is Unix epoch milliseconds from the same clock; `seconds`
  describes the full observation window, including slow/failed requests.
- `latenciesMs` contains one finite positive duration per completed/failed
  request, including timeout duration. `errors` counts unsuccessful requests
  within that array. Do not discard failures or warmup selectively.
- Baseline must finish before the batch and mixed window. The entire mixed
  window must fall within the batch's running interval.
- `batch.completed` counts authoritative, successful domain receipts, not queue
  acknowledgments. `expected` is the fixed, nonzero workload size.
- `peakOldestQueueAgeSeconds` is the maximum observed pending age across the
  batch run, not merely the drained queue's final age.
- `evidence` identifies candidate, hardware, workload and retained raw artifact.
  These labels are required but not cryptographically verified. Keep original
  load-generator output, runtime metrics, failures and release manifests for review.

```sh
bun run performance:check /absolute/path/customer-measurements.json
```

Exit `0` means supplied measurements satisfy supplied limits. Invalid evidence
or a failed limit exits `1`. It does not prove collection integrity, production
deployment, resource enforcement, recovery or customer acceptance.

## Local Verification

```sh
bun test tests/delivery.test.ts
git diff --check
```

This single focused file covers unsafe configurations, runtime limit forwarding,
CLI errors, percentile calculation and fail-closed measurement gates. It does
not start a Linux service or run customer load. The separate opt-in runtime
test exercises disposable local infrastructure. Customer capacity/recovery
gates remain unaccepted until measured on the approved environment.
