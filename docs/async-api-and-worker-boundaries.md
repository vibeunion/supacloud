# Async API, SDK And Worker Boundaries

## Decision

Use APIs and packages together, for different ownership boundaries.
APIs own remote state and authority; SDKs expose those protocols; worker
packages host application code. Do not build a new endpoint family and a
second task ledger merely because a new execution library is introduced.

The implementation in `packages/worker` is an optional pgflow process adapter.
Existing queue, task, command, workflow and approval APIs retain their owners.
No existing run is migrated or consumed by a new engine implicitly.

## Workspace Inventory And Direction

| Capability | Existing owner | Public surface | Direction |
| --- | --- | --- | --- |
| Project lifecycle, deployments, secrets, worker configuration | management-api / CLI | Authenticated management HTTP API and CLI | Keep control-plane authority in the service |
| Background Function invocation and task state | background-function-worker / SDK tasks | Existing task API and `functions.invokeBackground` | Keep scheduling and caller identity; not a DAG DSL |
| Queue send/read/archive | PGMQ / SDK queue | Project data RPC and queue management API | Reuse; archive/fail aliases are not workflow retry |
| Linear durable workflows | workflow SQL / SDK workflows | Existing service-only workflow RPC | Do not relabel these receipts as pgflow runs |
| Transactional and external business commands | contracts / commands / db | Domain HTTP/RPC plus server package | Keep authorization, audit and uncertain-outcome semantics |
| Compiled Jobs | app / compiler / elysia worker | Job authoring package and generated runtime | Keep DI, validation and framework execution |
| Multi-step async DAGs | optional pgflow | Native DSL plus controlled server submission | Use separate execution ownership, versioned flow slugs |
| Dedicated pgflow process bootstrap | new worker package | Server-only package | Delegate scheduler/retry/ack to upstream |
| Human approval | approval / pg_durable | Authorized business facade and private engine RPC | Never derive approval state from a queue/flow result |
| Storage/artifacts and realtime | Existing project services / SDK | API and subscriptions | Store large results here, not in queue messages |

This was a boundary review of task/queue/workflow/worker owners, not a whole
repository refactor. The existing Elysia Worker is a compiled-Job executor;
pgflow EdgeWorker is an engine-owned queue consumer. Wrapping one polling
loop inside the other would add two schedulers and conflicting acknowledgement.
Reuse a business handler or `executeJob` behind a pgflow step instead.

## Submission And Results

Browser -> domain API -> authorize current entity/revision -> transactional
command + outbox -> dispatcher -> selected executor -> domain result receipt.
Browser reads the domain operation or existing task projection, not engine
tables. Backends may use the server SDK; Python and third-party systems use
the same HTTP contract, not a mandatory TypeScript runtime.

The dispatcher is the only owner of retrying submission intent. Carry one
stable operation ID. A transport timeout after submit/ack is an unknown
outcome, not permission to repeat an external effect under a new ID.

No new generic `/v1/workflow-runs` API is introduced by this change. Before
adding pgflow to the platform task API, add an explicit executor reference
(`kind`, versioned definition, native run ID) and domain authorization to the
existing task contract. Publish supported actions per executor: do not
advertise cancel/retry/progress uniformly when the engines differ.

Single jobs can already use the existing queue SDK and the new queue-envelope
worker. Native pgflow DAG submission/status uses upstream APIs from trusted
backend code after the project database is provisioned. A managed pgflow task
submission API is not introduced here. The optional installation profile and
read-only task API projection are now implemented; see `pgflow-installation.md`.
Native run IDs are exposed as `pgflow:{uuid}`, with explicit executor capabilities.

## Workload Placement

| Workload | Execution placement | Important boundary |
| --- | --- | --- |
| Small API/AI request | Async I/O worker/step | Rate limits, timeout, external idempotency |
| Local OCR, office conversion, GPU inference | Dedicated container/GPU worker | Resource isolation; do not claim Edge runtime compatibility |
| Large file batch | Bounded fan-out and aggregation | Object IDs; cap concurrency and output size |
| Report generation | Native DAG if multiple dependent steps | Bind source revision; persist artifact in a domain command |
| Approval follow-up | Outcome consumer + transactional outbox | Only authoritative approval outcomes initiate work |
| Slow external jobs | Submit once, poll/reconcile later | Queue lease must not stand in for external job ownership |

## Acceptance Criteria

```gherkin
Scenario: Project and task scope
  Given a process bound to one project and queue
  When a message names another project or task
  Then no business handler runs

Scenario: Current domain authorization
  Given a valid task envelope with a stale business revision
  When the domain policy rejects the input
  Then execution is refused with a bounded error code

Scenario: Independent process lifecycle
  Given concurrent start requests and a stop during startup
  When startup settles
  Then exactly one upstream worker is started and stopped

Scenario: Engine ownership
  Given a SupaCloud internal workflow queue
  When the pgflow adapter is configured to consume it
  Then configuration fails before opening a connection

Scenario: Failure evidence
  Given a handler throws a credential-bearing exception
  When the queue handler reports failure
  Then upstream receives a bounded code instead of the exception text
```

## Integration And Release Gates

The wrapper uses published npm packages and lockfile pins, not GitHub main
behavior. Upstream database migrations have additional extension/service
dependencies and are a separate installation responsibility. A private adapter
package is not a claim of a managed pgflow service.

Before managed rollout: target-environment migration acceptance, credentials and
worker grants, versioned flow deployment, external-job reconciliation and a
documented migration boundary. Local disposable database acceptance is available
through `PGFLOW_DATABASE_ACCEPTANCE=1` in the worker's focused test file.
Do not migrate active linear workflows or approvals as part of a package
upgrade. No remote environment was modified by this change.

Reference sources inspected: upstream `pgflow-dev/pgflow` edge-worker README
and process adapter, and the installed npm 0.16.0 implementation/types/SQL.
The main-branch README describes exact string message IDs; npm 0.16.0 still
declares numbers, although its default database driver can return int8 text.
The adapter validates both without numeric coercion or mutation of settlement
IDs. Installation and capability claims must follow the pinned release rather
than that newer documentation.
