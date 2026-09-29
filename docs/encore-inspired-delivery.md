# Application Delivery Implementation

Status: PARTIAL. Local evidence is not platform integration or production acceptance.
Source: user request on 2026-09-24 to implement the Encore-inspired direction.

## Current Acceptance Status (2026-09-28)

Current priority: run the same representative business workflow end to end on
the dedicated full-platform target. Individual Auth, Storage, Realtime, queue,
systemd, Caddy, recovery, or API smoke checks are supporting evidence only; they
must not be promoted to full acceptance of the business workflow.

Current verified evidence:

- Management API and CLI typechecks pass for the current delivery source.
- SupAuth compatibility PR #124 merged on 2026-09-27 as
  `a324c4403195c3b69feebb44854d01e40ff999b2`. This is code integration,
  not live collaborator/RBAC acceptance.
- Native activation/allocation verification passes with 11 tests.
- Dedicated-platform evidence covers OIDC discovery and signed login/refresh,
  OAuth PKCE, Storage/PostgREST RLS, Realtime transport/CDC, queue transport,
  and systemd/Caddy runtime components as separately scoped checks.
- The dedicated-tenant Workflow SDK `start` ownership blocker is resolved by
  the actual `renderPlatformRpcOwnershipSql` executed inside a transaction,
  guarded by dedicated-tenant metadata. The live Workflow fixture passed all
  nine boolean evidence fields; this is narrow RPC/queue acceptance.
- Native PostgreSQL ownership regression passes (one test, 81 assertions),
  alongside 80 related unit tests and the current Management API typecheck.

Current blockers:

- The shipped upload/approval/async-worker workflow passed the dedicated
  systemd business fixture, but not the default Management API activation path.
- The complete local starter/native regression passed as recorded below.
  This does not close full-platform acceptance.
- Default activation composition includes a real compatibility verifier,
  runtime, readiness and gateway; their combined live API workflow remains
  unverified.
- Business upgrade/rollback and independent record/object recovery have scoped
  evidence below. Full-platform migration-ledger compatibility and recovery of
  schema, roles/grants, functions/triggers, RLS, serving Storage, Realtime,
  activation manifests and gateway configuration remain unclosed.
- Live SupAuth collaborator/RBAC acceptance still needs a real GoTrue-backed
  subject; the emulator's virtual `admin` subject was rejected.
- Datas capacity is no longer a blocker. On 2026-09-28 the acceptance VM reported
  533 GB available and the actual `supacloud-management-api` unit was running
  with HTTP 200 from `/health`. There is no `supacloud.service` unit.
  Default-activation project `ttzatqixbiaxhyratbvh` remains INACTIVE.

The historical entries below retain their original dates and outcomes. Earlier
Realtime failures, the incorrect unchanged-config migration retry, and
intermediate typecheck failures are historical observations; they are not the
current status. The earlier Workflow SDK `start` failure with `42501` is also
resolved for the dedicated acceptance tenant by the repair and live evidence
recorded below; this does not establish the full business workflow.

GoTrue remains authoritative for users, sessions, signing and JWKS; SupAuth is
the management/RBAC overlay, not a second issuer. Passing OAuth identity checks
with a test access resolver does not prove live membership/RBAC authorization.

## Contract

Goal: make an AI-assisted business change verifiable from local development
through self-hosted delivery, without cloning Encore's runtime or cloud platform.

The full acceptance scope is:

1. A representative application exercises authenticated identity, object-level
   authorization, persistent transactions, idempotency, audit, asynchronous work
   and file upload. Its failure paths are tested, not just its happy path.
2. The same business contracts run against Lite and a dedicated full-platform
   test environment. Reports explicitly distinguish memory, embedded PostgreSQL,
   native PostgreSQL and external identity/storage evidence.
3. ApplicationGraph remains the source of application structure. Diagnostics,
   request execution metadata and bounded AI context can be correlated without
   including tokens, request bodies or private application data.
4. Delivery checks cover immutable artifacts, migration compatibility, health,
   failure receipts, application rollback and the separate data recovery path.
   A local module factory is never presented as a deployable HTTP application.

Non-goals: rewrite the framework, add a universal workflow engine, migrate hosting,
implement a second identity provider, reproduce all cloud-provider integrations,
or automatically commit, publish, deploy or write production state.

Stack: existing Bun/TypeScript, compiler and Elysia adapter. Persistence: existing
PostgreSQL contracts, with Lite's embedded database as a separate test profile.
Deployment target: existing SupaCloud self-hosted platform. Credentials must be
provided by an explicitly selected environment, never copied into fixtures.

Orchestration: native, one writer and one read-only verifier for local
medium-risk implementation. Changes to production authorization, destructive
migrations or live deployment require a new risk decision and authorization.
There are no writer leases in the local coordination directory at startup.
The agmesh executable is unavailable; no coordination database records are
manually rewritten. This contract records the user-authorized local scope.
Existing uncommitted Lite changes are outside the write scope.

## Evidence Inventory

| Requirement | Current status | Existing evidence | Remaining acceptance |
| --- | --- | --- | --- |
| 1. Business workflow | Real-platform representative workflow passed; broader acceptance PARTIAL | Shipped compiled HTTP/Worker archive passed upload, approval, idempotency, audit, native Workflow queue and durable result checks on the dedicated tenant for v1, v2 and v1 rollback; native ownership regression passed 81 assertions | Live SupAuth membership/RBAC; default Management API activation/gateway workflow and independently restored application data |
| 2. Environments | PARTIAL | Complete local starter regression passed; dedicated-platform OIDC/PKCE, Storage/PostgREST RLS, Realtime, queue and systemd/Caddy evidence; same shipped approval/upload/Worker workflow now passes real systemd execution with tenant Caddy service origins | Default management activation/gateway, live SupAuth overlay and independent platform recovery |
| 3. Feedback | Core implementation complete; platform collection incomplete | ApplicationGraph-based bounded context, diagnostic repair, immutable snapshots/artifact identity and detached HTTP failure correlation without source checkout | Environment/release-associated runtime feedback from the full-platform business workflow; supplied events remain untrusted hints |
| 4. Delivery | PARTIAL | Immutable HTTP/Worker artifacts, migration ledger checks and native old/new execution; real-platform v2 schema refusal before migration, v2 business execution, v1 rollback and exact per-run retained data; default activation composition and concrete starter compatibility verifier implemented locally | Real-platform verification of the default activation/verifier composition and migration ledger; independent application-data recovery |

## Implementation Order

First remove the synchronous-only storage assumption from the default review
starter. Test asynchronous reads/writes and rejection propagation through the
compiled HTTP route while preserving the lightweight memory demo.

Then connect persistent adapters and shared environment scenarios. Reuse existing
durable commands and queue contracts instead of writing another idempotency or
workflow engine. Failed authorization must remain failed on replay.

Finally integrate feedback and delivery using the existing compiler and release
surfaces. Missing credentials, approval or external infrastructure are reported
as incomplete acceptance, not replaced by mocks or silently skipped checks.

## Verification

- Starter unit tests and generated application tests.
- Packed package starter smoke: compile, drift checks, typecheck, HTTP, repair,
  watch/restart and production bundle boundaries.
- Targeted persistent/environment suites as their adapters are connected.
- Current diff review plus independent verifier before closing implementation.

Run the complete local starter check with:

```sh
bun run verify:starter
bun run verify:starter --postgres-bin /path/to/postgresql/bin
SUPACLOUD_STARTER_POSTGRES_BIN=/path/to/postgresql/bin bun --no-env-file test scripts/lib/starter-postgres.test.ts
SUPACLOUD_STARTER_POSTGRES_BIN=/path/to/postgresql/bin bun --no-env-file test scripts/lib/starter-lite.test.ts
```

The first command exercises the compiled review handler and attachment Job
against the actual Lite PGlite backend with loopback HTTP and filesystem Storage.
The second also creates a new password-protected PostgreSQL
cluster on loopback, runs the persistent command scenario and removes the cluster after stopping
it, then runs the attachment scenario against Lite's native PostgreSQL engine
using the explicitly selected local installation and its private Unix socket.
It does not accept or connect to an existing database URL. If shutdown fails,
the cluster directory is retained rather than deleting an active database.
SIGINT/SIGTERM cancellation stops in-flight native queries by shutting down the
owned cluster, then drains its pool and removes its directory. The third command
tests initialization and an observed active long-running query under both signals.
The Lite helper suite tests shared restart, preserved database/HTTP credentials,
cancellation during restart and listener shutdown on PGlite and native PostgreSQL.
Without the explicit binary directory the native tests are skipped.

All three database profiles verify duplicate requests, distinct-key version races, real database
close/reopen, current command permissions, object ownership, membership revocation,
rollback after a write or audit failure, and metadata-only execution events.
The native profile uses Lite's SQL queue compatibility layer plus the canonical
Workflow/Command SQL modules. It is not evidence for the native pgmq extension or
the complete multi-project platform.

Identity uses real signature verification with an ephemeral local ES256 key and
synthetic application membership. This does not prove a live SupAuth login.
The fixture is a test host, not a production adapter included in the generated app.

## Phase 1 Results

Verified locally on 2026-09-24 with Bun 1.4.0:

- CLI starter/app-tools suite: 30 tests, 263 assertions, no failures.
- CLI typecheck and root `typecheck:tools`: passed.
- Native interruption regression suite: 4 tests, 20 assertions, no failures;
  no surviving postmaster PID or temporary cluster directory on successful cleanup.
- `bun --no-env-file scripts/check_app_starter.ts --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin`: passed, exit 0.
- The packed command, HTTP and Edge starters passed compile, generated artifact
  drift, application typecheck, tests and bundle checks.
- The persistence fixture passed on both database profiles, including shutdown
  and restart with existing data, eight duplicate requests, two distinct-key
  competitors, and rollback with no committed receipt/audit after injected failure.
- Independent review found missing explicit command permission enforcement and
  a membership-denial test masked by an earlier ownership denial. Both were
  corrected; permissions, ownership and membership now have separate denial and
  restored-access assertions.
- The same verifier identified cancellation cleanup for the detached PostgreSQL
  process. Signal propagation, idempotent cleanup and the four interruption
  regressions were added. Normal packed smoke was rerun successfully afterward.

These results cover the source under test, not npm publication, CI, deployment,
production authorization, production queue extensions or live user-center access.
The generated app's supported Bun requirement has not been changed.
Other writers' concurrent commands/compiler/Lite changes were preserved.

Next: extend this same reference workflow with persistent asynchronous work and
file upload, connect an explicitly selected full-platform test target, then close
the feedback and immutable delivery/recovery requirements above. The overall
goal remains active; Phase 1 is not a substitute for those acceptance items.

## Phase 2 Follow-Up

Started 2026-09-25. Parent: Phase 1 above. Source: continuation of the same
user-authorized goal. Reason: jobs and private file upload remain unproven in the
representative workflow. The original four acceptance requirements are unchanged.

Scope: generated review attachment Job and host contract, real Lite Storage and
Artifact registration, transactional Workflow submission, compiled Job execution,
durable result and acknowledgement recovery. Reuse existing protocol owners.
Native orchestration continues with one writer and one read-only verifier for
this local medium-risk change. No production hosts or published packages are
modified. The full-platform and production delivery requirements remain open.

Integration exposed a compiler defect: direct external dependencies of generated
request/job-scoped providers were read from services but never forwarded from
the host dependency bag. Phase 2 includes a narrowly scoped generator fix and a
compiled regression for both scopes; unrelated client-generation changes remain
owned by their original writer. Only referenced external tokens are forwarded.
Borrowed tokens are non-enumerable and are excluded from instance teardown,
including the special DESTROY_REF branch. Application-owned instances still
receive teardown; the actual Worker path is covered separately.

## Phase 2 Local Results

- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin`: passed, exit 0, after the scoped dependency,
  borrowed lifetime, Storage ownership and cleanup corrections.
- The command, HTTP and Edge templates passed packed compilation, typecheck,
  tests, artifact drift, bundle and bounded-context checks. The development
  HTTP/watch/restart and diagnostic repair checks also passed.
- The shared persistent command scenario passed on Lite/PGlite, independent
  native PostgreSQL and Lite/native PostgreSQL. Both Lite profiles additionally
  passed real HTTP uploads, private filesystem Storage, immutable Artifact
  registration, same-transaction approval/Workflow submission and compiled Job
  execution. Independent bare PostgreSQL explicitly reports no Storage coverage.
- Attachment failures cover audit rollback without a queued run, result commit
  rollback followed by retry, a lost acknowledgement followed by database restart
  and actual lease expiry, stale acknowledgements, idempotent durable results,
  revoked membership on replay and a revision change between read and commit.
- Storage ownership checks separately deny another subject's prefix, a subject's
  own prefix containing another review ID, and access after ownership transfer.
  Restoring ownership restores the same object's readable contents.
- Focused compiler/static-DI/Worker/starter/PGlite lifecycle suite: 62 tests,
  290 assertions, no failures. A separate explicit-native lifecycle run covered
  PGlite and native-Lite restart/cancellation plus the existing PostgreSQL
  SIGINT/SIGTERM regressions: 9 tests, 41 assertions, no failures.
- CLI typecheck and root `typecheck:tools`: passed.
- Independent review findings about borrowed dependency teardown and masked
  Storage ownership assertions were fixed and re-reviewed with no remaining
  blocking finding. Tracked diff and new-file whitespace checks passed.

This is local evidence from Bun 1.4.0 and the explicitly selected PostgreSQL 18
installation, not a change to the advertised supported runtime requirement.
The durable upload/registration/queue/worker adapters here are a test host.
The generated memory demo does not acquire production services or start a worker.
Identity remains locally signed synthetic SupAuth-compatible verification;
native queue behavior remains Lite SQL compatibility, not native pgmq.

The original four requirements remain active. Next acceptance still includes an
explicitly selected full-platform test target with real identity and production
host adapters, correlated application/execution diagnostics and bounded AI repair,
and immutable application activation, migration checks, rollback and separate
data recovery. No remote deployment, publication, commit or push was performed.

This document is a scope and evidence ledger, not a claim that any missing
acceptance item is complete.

## Phase 3 Follow-Up

Parent: Phase 2 local results. Source: continuation of the same authorized goal.
Reason: compiler inspection and runtime events still need a bounded, metadata-only
correlation path. The original four acceptance requirements remain unchanged.

Scope: a read-only compiler execution-context API and CLI mode, strict observation
input and output budgets, source/diagnostic projection without source expressions,
and a packed starter regression using actual failed command events. Observations
are untrusted hints matched against the current ApplicationGraph, not proof of a
deployed build, audit receipt, root cause or successful rollback. Semantic fixes
remain explicit preview/write operations; no privileges or repair values are inferred.
Native orchestration: one writer and one read-only verifier. No production access,
deployment, publication or unrelated compiler/client refactor is authorized.

## Phase 3 Local Results

- Added `createExecutionContextPack` and
  `context <subject> --events <file> --request-id <id> --json`. The original
  context mode is unchanged. The execution projection accepts only approved
  metadata and omits source expressions, diagnostic messages and semantic repair
  payloads. Usage and limitations: `docs/execution-context.md`.
- Input is bounded to 1 MiB and 2,048 events; the API independently checks
  canonical UTF-8 bytes. Formatted output is bounded to 32 KiB with explicit
  projection caps and omission counts. Invalid input never echoes its contents.
  Absolute, parent-traversing and URL-shaped source paths are omitted.
- Actual permission rejection, a custom executor failing before authorization,
  and compiled attachment Job failures are captured from the packed local
  reference app and correlated through the current graph. The static command
  plan now includes the real `commandExecutor` observation boundary.
- Source diagnostics are projected with repair readiness. The smoke separately
  exercises an explicitly selected semantic fix through preview, write and
  recompilation; execution context never chooses policy or applies a fix.
- Regression coverage includes alias ambiguity, request isolation, source-value
  omission, valid oversized JSON, trailing whitespace, multibyte UTF-8 budgets,
  output limits and inspection of valid source with drifted or missing artifacts
  without rewriting or recreating those artifacts.
- Focused execution-context/CLI/inspection/repair/starter suite: 41 tests,
  240 assertions, no failures. Compiler test typecheck, CLI typecheck,
  `typecheck:tools`, public API snapshots and tracked diff checks passed.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin`: passed, exit 0. All three database
  profiles and command/HTTP/Edge packed template checks remained green.
- Independent review's API budget, executor event coverage and read-only
  regression gaps were corrected and re-reviewed without a remaining blocking
  finding. The five new compiler exports are reflected in its public API
  snapshot; the limit constant has an explicit readonly type.

Correlation is deliberately marked `current-graph-only`, `eventsTrusted: false`
and `deploymentVerified: false`. This does not authenticate observation records,
prove root cause, attest a deployed binary, or substitute for durable audit.
Opaque IDs and static naming still require the host's privacy policy.

The overall goal remains active. Full-platform/live identity acceptance and
immutable application activation, migration compatibility, failure receipts,
application rollback and separate data recovery are still open. No remote write,
deployment, publication, commit or push was performed.

## Phase 4 Follow-Up

Parent: Phase 3 local results. Source: continuation of the original authorized
implementation goal. Reason: immutable module factories are not runnable HTTP
applications. All four original acceptance requirements remain unchanged.

First scope: extend the existing delivery builder with an explicit, typed HTTP
host composition module per target. Bundle host adapters with the target's
compiled modules, preserve factory-only builds, and verify the resulting process
outside the source checkout. Host code owns identity and persistence; the compiler
does not invent credentials, memory fallbacks or a second deployment engine.
Immutable build publication is not application activation or host attestation.

Stack profile: existing Bun/TypeScript compiler and Elysia runtime, selected from
repository manifests and this contract. Deployment profile: existing SupaCloud,
private infrastructure backend; external secrets remain runtime inputs.
Native orchestration continues with one writer and one read-only verifier.
Local deterministic tests and owned loopback processes are authorized; remote
activation, publication and production writes remain unauthorized.

Subsequent acceptance remains runnable reference-business host adapters,
full-platform/live identity, delivered-build feedback, migration compatibility,
health/failure receipts, activation/rollback and separate data recovery.

## Phase 4 Local HTTP Build Results

- `build.httpApplications` explicitly selects an HTTP host source per target.
  The builder type-checks `createDeliveryApplication(modules, lifecycle)` and
  bundles its real runtime with the target's compiled modules. Job targets cannot
  be mislabeled as HTTP applications; unconfigured targets keep factory output.
  HTTP object hashes bind `entryKind: "bun-http-application"` while existing
  factory inventories remain readable. Every manifest still says
  `deploymentReady: false`.
- Detached tests remove the source checkout and dependency links before starting
  the immutable bundle. Real Elysia HTTP routes, 404 handling, SIGINT/SIGTERM and
  exactly-once host cleanup passed. Different caller working directories reuse
  the same object and do not rewrite the selected manifest.
- Runtime cancellation is registered before host initialization. Tests cover
  initialization interruption and repeated signals, active streaming connections,
  throwing fetch handlers, invalid host results, occupied ports, stuck close
  operations and the combined startup-failure/stuck-close cases. Forced drain
  and cleanup deadline expiry exit nonzero rather than claiming success.
- Actual Elysia dependencies exposed a literal-only dynamic-import helper and
  unreliable same-process Bun resolution after analysis. The bundler statically
  expands only private, pure helpers whose every use has a literal specifier;
  original bytes remain in the input snapshot. Fresh Bun subprocesses isolate
  resolution, and a validated internal protocol returns artifact bytes/hashes.
  Compiler packaging now includes the worker entry. No dependency prewarming,
  framework replacement or external package fallback was introduced.
- The root-directory delivery suite passed: 54 tests, 371 assertions, no failures.
  It includes original factory/plan/CLI behavior, HTTP execution, malformed
  configuration, failed-build pointer preservation, source changes, emitted
  dependency checks, child cancellation and caller termination. Lifecycle
  verification also passed from the compiler package directory.
- Compiler `typecheck:test`, root `typecheck:tools` and `check:public-api` passed.
  The public API remains 301 app symbols and 167 compiler symbols.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed with exit 0. The installed packed
  compiler's worker built the stateless HTTP starter, whose moved bundle served
  real GET/POST requests and shut down successfully. Existing command/HTTP/Edge
  templates, all three database profiles, private upload/Job recovery, diagnostic
  feedback, explicit repair, drift checks and dev restart remained green.
- Independent review found no remaining blocking finding. The child-termination
  test observes cancellation near startup; it does not separately synchronize
  caller death with an already-running long bundle. That narrower watchdog
  evidence gap is retained, not promoted to full in-flight recovery proof.

These are local macOS results using Bun 1.4.0 and PostgreSQL 18. They do not change
the supported Bun requirement or prove other operating systems. The runnable
packed HTTP example is stateless; the persistent reference business workflow
still uses its verified test host, not a delivered production host adapter.
Application readiness, credential integration, migrations, activation, rollback
and data recovery are not inferred from the listener event or the build pointer.

The overall goal remains active with all four original requirements intact.
Next work connects runnable reference-business adapters and Job execution to
the existing platform-owned delivery/activation boundary, then verifies the
full-platform target, delivered-build feedback, migration compatibility,
failure receipts, application rollback and separate data recovery.
No remote deployment, production write, publication, commit or push was performed.

## Phase 5 Follow-Up

Parent: Phase 4 local HTTP build results. Source: continuation of the authorized
implementation goal after the Encore direction discussion. Reason: the durable
approval composition is still owned by a test fixture rather than a shipped host.
All four acceptance requirements and the original non-goals remain unchanged.

First scope: ship the reference PostgreSQL approval adapters with the starter,
using the existing transactional command implementation and compiled handler.
Move synthetic identity, failure injection and test data outside those adapters;
run the existing persistent/replay/failure scenarios against the shipped code.
Provide an explicit HTTP delivery host using runtime-injected configuration,
without running migrations or seeding identity at startup. One application
database is bound to one project/tenant; the host must check that binding.
Attachment submission remains a same-transaction host extension, not a second
workflow engine. Runnable attachment worker/full-platform integration and the
remaining delivery/recovery requirements are still required.

Stack/profile: existing Bun/TypeScript, Elysia, PostgreSQL and SupaCloud
self-hosted platform. Native medium-risk local implementation, one writer and
one read-only verifier. No live credential use or production/remote writes.
The coordination manifest exists but agmesh is unavailable; read-only SQLite
inspection found no task claiming this starter scope. No coordination records
are manually rewritten and no framework deployment is attempted.

## Phase 5 Local Approval Host Results

- The command starter now includes `src/host/review-postgres.ts`,
  `src/delivery-host.ts`, `migrations/001-review.sql` and host unit tests.
  Commands/contracts/database packages are runtime dependencies. The adapter
  reuses the existing transactional command store and compiled approval handler,
  including current permission/ownership checks on replay, transaction-bound
  reads/writes, receipt and audit commit, and conflict handling.
- One database has an explicit project/tenant binding. Wrong or absent bindings
  reject initialization; a binding changed while the process is running rejects
  replay. Restoring membership/permission/binding restores authorized access.
  The migration enables RLS and defaults approval permission to false. The HTTP
  process never creates tables, grants access, seeds members or signs tokens.
- Persistent acceptance now calls the shipped adapter instead of copying its
  composition in the test host. Failure switches wrap only the test database;
  attachment enqueue still receives the approval transaction. Both Lite backends
  retained private upload, immutable Artifact, atomic Workflow submission,
  compiled Job execution, commit failure, lease expiry, stale acknowledgement,
  revoked membership and changed-revision checks.
- The installed packed compiler builds the actual PostgreSQL HTTP host. Its
  copied bundle runs from a separate directory without source/dependency links.
  A temporary HTTPS JWKS server and signed test tokens exercise the actual remote
  verifier; no pinned test key resolver is built into the host. Missing credentials,
  wrong audience and a different owner fail. Approval and process-restart replay
  produce one business transition, one receipt and one audit. Membership revocation
  denies replay; wrong-tenant startup exits nonzero without a listener event.
  Both successful processes stop gracefully and close their database pool.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0. The generated command
  project's typecheck and 14 tests passed; all three database profiles, detached
  approval delivery, stateless delivery, command/HTTP/Edge templates, diagnostic
  repair, drift, environment isolation and development restart checks passed.
- CLI typecheck and root `typecheck:tools` passed. Starter unit tests passed
  (13 tests, 82 assertions); the combined app-tools/starter regression passed
  (33 tests, 294 assertions). The explicit-native PostgreSQL interruption suite
  passed (4 tests, 20 assertions), covering startup and active-query SIGINT/SIGTERM
  cleanup. Current diff and new-file whitespace checks reported no errors.
  The final packed-smoke directory was confirmed removed.
- The independent read-only verifier reviewed the entire Phase 5 scope and
  reported no unresolved blocking finding. Native tests use an owned temporary
  superuser; they do not prove production-role grants/RLS policies. The starter
  README now states that GRANT alone is insufficient and forbids treating that
  fixture role as production configuration.

These are local macOS/Bun 1.4.0/PostgreSQL 18 results. Test certificates require
local OpenSSL and are removed with the owned temporary files. HTTPS/JWKS here
proves signature verification against a test issuer, not actual SupAuth login.
Job output remains a module factory and `deploymentReady` remains false.
The shipped HTTP host currently binds approval, not attachment upload/worker
execution. The test-only attachment composition has not been promoted to
production merely because its tests passed.

The original goal remains active. Next: deliver the existing Artifact/Workflow
attachment adapters and compiled worker, verify dedicated backend-role policies,
then exercise the selected full-platform identity/storage/queue target. Delivered
build feedback, migration compatibility, activation health/failure receipts,
application rollback and separate data recovery remain required. No commit,
push, publication, remote deployment or production write was performed.

## Phase 6 Follow-Up

Parent: Phase 5 local approval host results. Source: continuation of the original
authorized goal. Reason: the next business delivery needs an independently
executable worker, while the current immutable builder can only compose HTTP
hosts. All four requirements remain unchanged.

First scope: add an explicit typed worker host boundary to the existing delivery
builder, preserve factory output, and verify detached compiled Job execution,
signal cancellation, bounded shutdown and failure exit status. Reuse the existing
Worker runtime; do not introduce a queue, retry engine or deployment controller.
This prerequisite is not acceptance of the reference attachment workflow.
Following work must connect its production Artifact/Workflow adapters and worker,
verify backend-role policies and complete the full-platform/delivery/recovery
requirements recorded above.

Existing Bun/TypeScript compiler and Elysia Worker remain the selected stack.
Native medium-risk local work: one writer and one read-only verifier. Coordination
inspection found no new task claiming this scope; agmesh remains unavailable.
No remote deployment, credentials, publication or production writes are used.

## Phase 6 Local Worker Entry Results

- `delivery.build.workerApplications` explicitly binds TypeScript worker hosts
  to Job targets. The typed factory receives the target's compiled modules and
  lifecycle signal, and returns `start`/`close`. HTTP/worker target mismatches,
  duplicate hosts, unsafe/missing sources and invalid host types preserve the
  previously selected immutable manifest.
- Executable worker objects use `entryKind: "bun-worker-application"` with the
  discriminator included in their identity. Existing factory and HTTP object
  formats remain readable. Manifest parsing also rejects an executable kind
  incompatible with its target. No new public export was added.
- Detached tests remove the source project and dependency links before running
  the copied bundle. The existing Elysia Worker executes the compiled Job and
  acknowledges its result; no new queue or retry engine is introduced.
  A file-controlled in-flight Job proves SIGTERM shutdown waits for completion
  and acknowledgement. SIGINT/SIGTERM close the host exactly once.
- Cancellation after the factory returns invokes close even while start is
  pending. Tests cover start that needs close to unblock, indefinitely stuck
  factory/start, invalid returned methods, startup failure, failed/stuck cleanup,
  duplicate signals and suppressed startup events after cancellation.
- Independent review found two lifecycle issues: abort-listener errors could
  escape sanitization with successful exit, and pending start did not invoke
  available close. Both were corrected and independently rechecked. Uncaught
  exceptions and unhandled rejections, including synchronous/asynchronous abort
  callbacks, now trigger bounded failed shutdown with generic output. Tests
  assert nonzero exit, no private error/source text and exactly-once cleanup.
  Successful cancellation waits for both start and close, not merely one.
- Final full delivery suite passed: 57 tests, 490 assertions. Compiler
  `typecheck:test`, root `typecheck:tools` and `check:public-api` passed; the public
  API remains 301 app symbols and 167 compiler symbols. Current diff and all new
  worker files had no whitespace diagnostics.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0. The installed packed
  compiler built the Edge starter's executable worker. Its copied bundle executed
  the compiled Job, recorded acknowledgement, reused immutable output and shut
  down gracefully. All three persistence profiles, persistent and stateless HTTP
  delivery, original templates, diagnostic repair, drift, environment isolation
  and development restart acceptance remained green.

These are local macOS/Bun 1.4.0/PostgreSQL 18 results. The worker smoke uses a
deterministic single-claim test transport, not a durable queue. Its startup event
is not queue health, deployment attestation or successful business processing.
The reference attachment's production adapters/Workflow transport are still not
connected to this executable host. `deploymentReady` remains false.

The original goal remains active. Next: connect the actual Artifact/Workflow
attachment adapters to the HTTP approval transaction and independent compiled
worker, with explicit queue ownership and failed-settlement behavior; then verify
backend-role policies and the selected full-platform target. Delivered-build
feedback, migrations, activation/failure receipts, application rollback and
separate data recovery remain required. No commit, push, publication, remote
deployment or production write was performed.

## Phase 7 Follow-Up

Parent: Phase 6. Source: continuation of the original implementation goal.
Reason: the executable worker boundary still lacks the reference workflow's
shipped persistence adapters and durable transport.

First move attachment storage, authorization, transactional enqueue and durable
result persistence into the generated application. Keep synthetic identities,
Storage provisioning and fault injection in test fixtures. Reuse public Artifact
SDK and CommandDatabase contracts. Check project/tenant binding, current
permissions, immutable object metadata and conflicting durable results.
Then connect durable Workflow transport and executable worker delivery.
Native medium-risk execution remains one writer plus one read-only verifier.
The four original acceptance requirements and remote-write restrictions remain
unchanged; adapter extraction alone is not worker or full-platform acceptance.

## Phase 7 Adapter Extraction Results

- Generated applications now include `src/host/review-attachments.ts` and
  `migrations/002-review-attachments.sql`. Artifact reads, transactional enqueue,
  authorization and idempotent result persistence no longer live solely in the
  test fixture. Generated dependencies include the public SDK and its Supabase
  peer; adapters do not require a fictitious management endpoint.
- Both attachment tables enable RLS without granting public access. The adapter
  checks database project/tenant binding at initialization and authorization,
  current approval permission and membership, owner/revision, exact registered
  path, artifact type, MIME type and declared/downloaded size. The compiled Job
  still validates the content digest. Durable result conflicts are rejected.
- Real Lite/PGlite and Lite/native PostgreSQL scenarios now import the shipped
  adapter and migration. They preserve private HTTP upload, immutable registry,
  same-transaction submission, commit rollback, actual restart/lease expiry,
  stale acknowledgement and revision-change recovery. Additional assertions
  reject changed database project/tenant, revoked approval permission, mismatched
  object paths and conflicting persisted results. Fault switches remain in the
  test-only database wrapper, outside generated production source.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0. Command/HTTP/Edge templates,
  all three persistence profiles, detached HTTP approval, executable worker
  smoke, repair/drift checks and development restart remained green.
- Starter tests: 14 passed, 98 assertions. CLI `tsc --noEmit` and root
  `typecheck:tools` passed. Current tracked diff and new adapter/fixture whitespace
  checks had no diagnostics. Independent review found no remaining blocker;
  compiler-rejected assertions/implicit-any were replaced with boundary parsing.

This remains local macOS/Bun 1.4.0/PostgreSQL 18 evidence, not production-role
acceptance. The service client's project origin is still an operator-provisioned
assumption, not an attestation. Upload/registration/binding and Storage policy
provisioning are still fixture-owned. The detached worker smoke still uses its
test transport: the reference attachment's durable Workflow worker composition
has not been delivered. Full-platform identity/storage/queue acceptance,
restricted roles, delivered-build feedback, migrations/activation/failure
receipts, application rollback and separate data recovery remain open.
No commit, push, publication, deployment or production write was performed.
The original goal remains active; `deploymentReady` remains false.

## Phase 8 Follow-Up

Parent: Phase 7. Source: continuation of the original implementation goal.
Reason: shipped attachment adapters still need durable Workflow execution and
an executable host with fatal settlement supervision.

Add an optional fatal promise to worker delivery hosts, then compose the existing
Worker, Artifact adapters and Workflow SDK in the generated application.
Queue ownership must be explicitly exclusive to this reference workflow;
unsupported workflow/version/step and uncertain settlement stop consumption.
Verify the durable path against the owned Lite backends and a detached executable
against native Lite. Keep the existing single writer/read-only verifier model.
No production access or remote writes are authorized; all original acceptance
requirements remain open until their own evidence exists.

## Phase 8 Durable Worker Results

- Generated `src/host/review-attachment-worker.ts` composes the existing Worker,
  compiled reference Job, PostgreSQL adapter and public Workflow SDK. It requires
  explicit exclusive queue ownership and the exact reference Job registration.
  Supported workflow/version/step and the run's database attachment binding are
  checked before execution. Unsupported claims remain unsettled; polling stops
  instead of failing or repeatedly consuming another workflow's work.
- Ordinary Job failures use canonical Workflow retry/fail. Uncertain completion
  or failure settlement latches a fatal promise and stops new claims. Both Lite
  backends verify actual retry followed by success, completion applied with its
  response lost, retry applied with its response lost, resumption of pending work,
  and unknown name/version/step or unbound run rejection.
- Generated `src/delivery-worker.ts` accepts runtime-only database/service settings,
  including an explicit private Unix socket alternative to DATABASE_URL. It owns
  the SQL pool and cleanup, never migrates, seeds or signs synthetic identities.
  Worker delivery entries now optionally observe `failure: Promise<never>`,
  including while start is pending. Rejection or unexpected fulfillment causes
  bounded failed shutdown with generic output, not a healthy idle process.
- The packed native-Lite scenario builds this shipped host, reuses its immutable
  object and executes a copied bundle in a detached directory. It claims the
  actual Workflow, executes the compiled attachment Job and commits the expected
  result before completion. A second process rejects an unknown Workflow with
  nonzero exit and leaves its claim unsettled. Graceful completion exits zero.
- This real driver path exposed a JSON binding defect: Bun SQL encoded serialized
  JSON passed directly to a jsonb parameter as a JSON scalar. A separate owned
  PostgreSQL reproduction confirmed it. Enqueue and result INSERT now bind
  `::text::jsonb`; no fallback accepts malformed durable records. The native
  preflight verifies the same adapters through Bun SQL, including idempotent
  enqueue and an intentionally rolled-back result write. Counts prove zero
  results after preflight and exactly one after the detached worker completes.
- Independent review's cwd-dependent fixture path issue was corrected by passing
  the generated project root explicitly. The fixture also observes child exit
  and terminal workflow failures instead of waiting indefinitely for success.
  Final read-only review had no remaining blocker.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0, including the final row-count
  assertions, all original profiles/templates, HTTP/worker delivery, repair/drift
  and development restart checks. The subsequently run complete delivery suite
  passed 57 tests / 508 assertions. Starter tests passed 15 / 114 assertions.
  CLI and compiler test typechecks, root tools typecheck and public API checks
  passed; exports remain 301 app / 167 compiler symbols.
- An earlier concurrently run HTTP suite saw declarations temporarily disappear
  while packed smoke rebuilt shared dist files. The final complete delivery suite
  ran after smoke finished and passed; no concurrent rebuild evidence is counted
  as successful verification.

This is local macOS/Bun 1.4.0/PostgreSQL 18 evidence. Native Lite still uses the
SQL queue compatibility layer, not the production pgmq extension. Service-origin
binding and exclusive queue ownership remain operator assumptions, not platform
attestations; repeated automatic restarts can exhaust an unknown run's attempts.
The standalone HTTP host still delivers approval only: upload/registration/binding,
Storage policies and its attachment enqueue composition remain to be shipped.
Real full-platform identity/storage/queue, restricted backend roles, delivered-build
feedback, migration/activation/failure receipts, application rollback and separate
data recovery remain required. No commit, push, publication, remote deployment or
production write occurred. The original goal stays active and deploymentReady
remains false.

## Phase 9 Follow-Up

Parent: Phase 8. Source: continuation of the original implementation goal.
Reason: upload/registration/HTTP composition and Storage policies are still
fixture-owned. Ship compiled preview/registration routes with trusted identity,
server-derived paths, bounded private uploads, immutable Artifact registration
and transactional audited binding. Keep the cross-service operation explicitly
two-phase: failed binding can leave retained immutable evidence.
Wire opt-in HTTP attachment composition and verify the detached HTTP-to-worker
path against owned native Lite. Native medium-risk execution remains one writer
and one read-only verifier. All four original requirements and production/remote
write restrictions remain unchanged.

## Phase 9 Upload Delivery Results

- Generated preview and registration routes use request-scoped trusted identity,
  validate the review revision and derive object paths from database membership.
  Caller-supplied body fields cannot override the route review ID or object path.
  Registration downloads the private bytes, validates MIME essence and size,
  computes SHA-256 and registers immutable Artifact evidence before transactional
  binding through the existing Command store. Binding rechecks authorization,
  writes one audit event and permits exact replay after the corresponding approval.
- Migration 003 ships the private, text-only, 1 MiB bucket and membership/read
  policies. Restrictive Storage fences prevent mutation or deletion of protected
  bytes even in the presence of broader permissive host policies. The test installs
  such a broad policy and checks ownership transfer and permission revocation.
  An unrelated bucket remains writable: distinct update bytes are downloaded and
  compared; deletion is verified by both failed download and zero database rows.
- Failed binding retains the registered Artifact without inventing a committed
  attachment. Tests cover retry, conflicting registration, revision mismatch,
  and revocation between external registration and binding with no binding,
  receipt or audit. Expected authorization denial returns 403; unexpected failures
  remain failures rather than being converted to permission denial.
- The generated HTTP host opts into uploads and attachment enqueue explicitly.
  Native Lite verification starts the actual detached HTTP executable, uploads
  and registers private bytes, approves and enqueues, then starts the detached
  Worker to execute the compiled Job and persist its result. The approval-only
  host explicitly returns 501 for authenticated upload requests.
- Final exact-source `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0. It includes PGlite,
  independent native PostgreSQL and native Lite profiles, packed templates,
  repair/drift and development restart checks, and detached HTTP/worker delivery.
  Starter tests passed 16 tests / 132 assertions. CLI, tools and compiler test
  typechecks passed. Public API checks passed with 301 app / 167 compiler exports.
  After starter smoke completed, the complete delivery suite passed 57 tests /
  508 assertions with no concurrent shared-dist rebuild.
- Independent read-only review closed the unrelated-bucket false-positive gap
  after the test was strengthened; no additional blocking finding remained.

This remains local macOS/Bun 1.4.0/PostgreSQL 18 evidence with synthetic signed
identity and Lite's SQL queue compatibility layer, not live SupAuth or native
pgmq acceptance. Backend fixtures still use their owned privileged database role.
Full-platform identity/storage/queue, restricted backend grants, service-origin
and exclusive queue attestation, delivered-build feedback, migration compatibility,
activation/health/failure receipts, application rollback and separate data recovery
remain required. No commit, push, publication, remote deployment or production
write was performed. The original goal remains active and deploymentReady=false.

## Phase 10 Follow-Up

Parent: Phase 9. Source: continuation of the original implementation goal.
Reason: detached hosts still use privileged fixture database connections.
Ship explicit reference runtime role grants/RLS, separate HTTP/worker accounts
and verify their denied operations and real detached business path on native Lite.
Keep setup, synthetic identity and platform service-key access explicitly separate
from application SQL access. Existing Bun/TypeScript/PostgreSQL profiles remain;
no framework, database or hosting migration is in scope.
Native medium-risk execution keeps one writer and the same read-only verifier.
No production role changes, remote writes or deployment are authorized.

## Phase 10 Runtime Role Results

- Migration 004 ships explicit NOLOGIN, non-superuser, non-BYPASSRLS reference
  roles. Existing cluster-wide role names fail instead of being adopted.
  Runtime LOGIN provisioning remains administrator-owned and outside generated
  source. HTTP receives approval, attachment binding, append-only command
  receipt/audit and Workflow-start permissions. Worker receives authorization
  reads and result insertion, not approval, binding or SQL Workflow submission.
- Authorization row locks retain narrowly selected UPDATE column privileges.
  Restrictive RLS checks prevent those privileges from changing members,
  application binding or existing attachments; Worker review writes are also
  prohibited. Neither role owns the schema or application tables.
- The owned native-Lite fixture applies the shipped migration and creates two
  separate unprivileged LOGIN accounts. Actual SQL connections verify current
  and session identity plus all privileged role flags. Negative checks cover
  CREATE/ALTER/TRUNCATE, membership/binding mutation, cross-role/service-role
  assumption, deletion, receipt/audit mutation, Worker approval/binding/queue
  submission and HTTP result insertion.
- Detached HTTP now uses the HTTP LOGIN for the actual upload, registration,
  approval, enqueue and restart/replay scenario. The independent Worker and its
  Bun SQL preflight use the Worker LOGIN, verify SQL enqueue denial, retain the
  controlled result rollback test and complete one durable Job result. Unknown
  Workflow handling still exits nonzero without settling another workflow.
- Final `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0, across the original
  profiles/templates and the restricted-login native-Lite scenario.
  Starter unit tests passed 17 tests / 143 assertions. CLI and tools typechecks
  passed; public API checks remain 301 app / 167 compiler exports. Current diff
  and new-file whitespace checks passed. The same independent read-only reviewer
  found no blocking issue and independently confirmed the starter unit tests.

This proves the local SQL role boundary, not full-platform least privilege:
Storage/Workflow HTTP clients still hold a separately privileged service key.
Fixture setup, in-process scenarios and independent native PostgreSQL approval
tests still use owned administrator connections. Request-level object authorization
remains in the trusted adapters, not per-request backend RLS. Live identity,
service-origin/queue ownership attestation, delivered-build feedback, migration
compatibility, activation/failure receipts, application rollback and separate data
recovery remain required. No remote writes, publication or deployment occurred;
the original goal remains active and deploymentReady=false.

## Phase 11 Follow-Up

Parent: Phase 10. Source: continuation of the original implementation goal.
Reason: execution context still joins observations to current source only.
Persist sanitized target-projected execution structure in immutable build objects,
then add explicit read-only artifact selection and integrity-checked context.
Reject mismatched claimed object identity; retain eventsTrusted=false and
deploymentVerified=false. Build association is not runtime attestation.
Keep the existing compiler/TypeScript stack and one writer with the same read-only
verifier. No remote state or production deployment is in scope. Actual detached
feedback and full-platform acceptance remain required until verified.

## Phase 11 Build Feedback Results

- Each target now carries a sanitized `bundle/execution-context.json` in its
  immutable hashed inventory. Shared module/file/diagnostic dictionaries remove
  repeated dependency-neighborhood text. The serializer validates the schema and
  1 MiB budget before publication; a 160-module dependency chain round-trips
  through the compact representation and retains current-context behavior.
- `context` accepts explicit `--delivery-manifest` and `--delivery-target` with
  the existing subject/events/request-ID/JSON options. This branch runs before
  current configuration and source analysis. It checks the caller's claimed
  target/object ID, all inventoried files and the hashed `target.json` against the
  manifest target and executable kind. Missing, changed, extra and symlinked
  entries are rejected without falling back to current source.
- Archive reads are bounded by JSON, file-count, per-file and total-byte limits.
  The existing 32 KiB output budget includes the added identity. Event validation
  and matching are shared with the original current-source API; that API retains
  its argument validation order, request isolation, omission counts and privacy
  behavior. No new root package API exports were required for the CLI mode.
- A real detached HTTP executable emits a failed-handler observation through the
  runtime observer. Its original source project is deleted before inspection.
  Both the loader and CLI correlate the captured event to the archived build,
  without exposing the thrown business value. Tests reject wrong identity,
  wrong target, manifest-only relabeling, modified snapshot/executable, unlisted
  files, missing snapshot and symlink replacement.
- Independent review found manifest-only target relabeling and oversized repeated
  snapshot text. Both were corrected with regression tests; final read-only
  review had no blocking finding. An intermediate test stderr typing error was
  corrected before final typechecks.
- Final delivery/context regression suite passed 69 tests / 627 assertions.
  The subsequent exact-source `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0, including packed templates,
  all existing persistence profiles, restricted native-Lite logins, detached
  HTTP/worker execution, repair/drift and development restart checks.
  Compiler test, CLI and tools typechecks passed. Public API checks remain
  301 app / 167 compiler exports. Earlier smoke predating the review fixes is
  not counted as the final evidence.

The new result says verified-build-snapshot, not verified deployment. Object
identity is supplied by the collector, events remain untrusted and the archive
manifest is not a signed runtime attestation. The verified detached feedback is
local; full-platform identity/storage/queue, service-origin and exclusive queue
acceptance, migration compatibility, activation/health/failure receipts,
application rollback and separate data recovery remain open.
No commit, push, publication, remote deployment or production write occurred.
The original goal remains active and deploymentReady=false.

## Phase 12 Follow-Up

Parent: Phase 11. Source: continuation of the original implementation goal.
Reason: application artifact identity does not yet cover its required migration
bytes or distinguish project migrations from operator-only provisioning.
Archive explicitly selected project-relative SQL, versions, names and executor
declarations into every target's immutable inventory. Reuse the existing platform
migration ledger/risk/promotion owners for subsequent reconciliation and execution;
do not introduce a second SQL parser or migration runner in the compiler.
Raw-file identity is not the platform's semantic ledger checksum, compatibility
evidence or execution authorization. All original acceptance requirements remain.
Existing Bun/TypeScript, PostgreSQL and self-hosted target choices are unchanged.
Native medium-risk execution remains one writer and the same read-only verifier;
no remote migration, publication, activation or production write is authorized.

## Phase 12 Migration Identity Results

- Explicit migration declarations now archive exact SQL bytes into every target's
  immutable inventory. SQL-only changes invalidate target identities even when
  bundled executable bytes are unchanged. Undeclared SQL is not discovered.
- Project migrations and operator provisioning have separate archive directories.
  The reference starter declares 001-002 as project migrations and 003-004 as
  operator provisioning: Storage policy ownership and cluster roles must not be
  assumed available to the normal project migration role. Both detached delivery
  fixtures assert the two-plus-two split.
- Metadata states `digestScope: raw-sql-bytes`, `compatibility: not-proven`,
  `executionPerformed: false` and `dataRecovery: separate-required`. This is not
  the platform's canonical migration checksum or a claim about database state.
  No SQL execution or second migration parser was added.
- Declarations reject duplicate versions/sources, invalid int64 versions and
  unsafe paths. Reads reject symlinks, non-files, invalid UTF-8, empty SQL and
  exceeded byte budgets. Generated-output inputs are rejected before publication,
  leaving the previously selected manifest unchanged.
- Independent review closed the Storage-policy executor classification finding.
  It also identified a generated-input test that could pass on file absence;
  the fixture now creates valid nonempty SQL before asserting rejection and
  pointer preservation. The reviewer confirmed closure without modifying files.
- Final delivery/context/starter unit suite passed 88 tests / 814 assertions
  after that test correction. Compiler test, CLI and tools typechecks passed.
  Public API checks passed with 301 app / 167 compiler exports; diff whitespace
  checks passed.
- `bun run verify:starter --postgres-bin /opt/homebrew/opt/postgresql@18/bin`
  passed, exit 0. This includes packed templates, persistence profiles,
  restricted native-Lite logins, detached HTTP/worker execution, the migration
  archive split, repair/drift and development restart checks. The subsequent
  compiler regression run did not overlap the shared package rebuild.

Next: reconcile the archived inputs with the existing canonical migration ledger
and prove old/new application compatibility and activation/recovery on the
appropriate test target. Full-platform identity/storage/native queue acceptance,
environment-associated feedback, actual migration execution receipts, health and
failure receipts, application rollback and separate data recovery remain open.
No commit, push, publication, remote migration or production write occurred.
The original goal remains active and deploymentReady=false.

## Phase 13 Follow-Up

Parent: Phase 12. Source: continuation of the original implementation goal.
Reason: archived SQL must be compared with canonical ledger identity before any
application activation. Add read-only verified archive loading and an explicit
Management API inventory comparison, preserving raw-byte versus normalized
checksum distinctions and operator provisioning as a separate requirement.
No SQL execution, new parser, production writes or migration authorization is
included. Existing Bun/TypeScript/PostgreSQL and self-hosted choices remain.
Native medium-risk execution keeps one writer and the same read-only verifier.
All four original acceptance requirements remain active.

## Phase 13 Read-Only Ledger Results

- `readDeliveryMigrationArchive` shares the complete inventory verifier with
  build-associated execution feedback. It validates the hashed target, bounded
  archive schema, executor-specific paths and exact SQL bytes without loading
  current source. Tests also rehash deliberately malformed metadata to prove
  semantic checks, not just digest mismatch, reject unsafe archives.
- `database delivery_migration_plan` binds output to target/object identity and
  the selected project. It compares canonical normalized checksums separately
  from raw-file hashes, reports ledger matches/pending/name or checksum conflicts/
  out-of-order inputs, and leaves operator provisioning independently unverified.
  No SQL is printed and no migration or activation is performed.
- Review found the original migration-list GET initializes/reconciles ledgers.
  The new command therefore uses only `/database/migrations/inventory`, a new
  authenticated read-only route. The old route is unchanged; there is no fallback
  for older servers. The response must bind `project_ref` and `read_only: true`.
  Stored checksum drift and canonical/legacy divergence fail closed without
  repair or SQL disclosure.
- Route tests assert only SELECT queries and zero calls to metadata initialization,
  reconciliation, role provisioning, migration leases and transactions, including
  empty/missing tables, divergent ledgers and authorization denial. Independent
  review closed the write-like GET finding and the initially missing zero-call
  spy assertions; all reported findings are closed.
- A new owned native PostgreSQL test proves missing ledgers remain absent, exact
  normalized identity survives restart, the planner leaves ledger rows unchanged,
  operator roles are not created, and changed SQL is rejected. It exposed Bun's
  SQLSTATE in `errno` rather than `code`; the reader now recognizes both while
  continuing to propagate permission and connectivity errors.
- Final delivery/context/database/starter regression: 207 tests / 1,162 assertions.
  Read-only route regression: 14 tests / 80 assertions. Ledger/promotion tests:
  22 tests / 59 assertions. Delegated capability mapping: 6 tests / 40 assertions.
  `SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin bun
  --no-env-file test scripts/lib/delivery-migration-plan.test.ts`: 2 tests /
  100 assertions. These are local checks; the native test bridges the real
  ledger through a test transport, not a deployed Management API instance.
- Compiler build/test typecheck, CLI build/typecheck and tools typecheck passed.
  Public API check passed with 301 app / 169 compiler exports; the two new
  compiler exports are the archive reader and its result type. Diff whitespace
  checks passed. `bun run verify:starter --postgres-bin
  /opt/homebrew/opt/postgresql@18/bin` passed, exit 0, after the shared-reader
  changes; its package rebuild did not overlap delivery regression tests.
- Management API full typecheck remains PARTIAL: it reports
  `src/services/realtime-bun.service.ts(158,43): TS2339`, `SQL.listen` missing
  from the installed SQL type. That file has no diff and was not modified.
  Passing focused tests are not represented as a green whole-package typecheck.

This is a read-only ledger identity check, not a deployment authorization or
old/new application compatibility certificate. Actual migration execution
receipts, operator verification, full-platform identity/storage/native queue and
environment-associated feedback, activation/health/failure receipts, application
rollback and separate data recovery remain required. No commit, push, publication,
remote platform API request, remote migration or production write occurred.
The original goal remains active and deploymentReady=false.

## Phase 14 Follow-Up

Parent: Phase 13. Source: continuation of the original implementation goal.
Reason: ledger identity checks alone do not prove migration execution or old/new
application compatibility. Exercise the existing Management API mutation route,
project migration role, locks, leases and ledger on a newly owned local native
PostgreSQL cluster. Compare two detached immutable application builds across an
additive schema change, failed migration and application rollback.
This is a dedicated local fixture, not the full-platform test environment or a
production deployment. Existing stack/database choices and all four original
requirements remain. No remote mutation, publication or production authorization
is added. Native medium-risk work keeps one writer and the same read-only verifier.

## Phase 14 Local Migration Execution Results

- Added an opt-in, process-isolated native test using the shipped Management API
  migration route, actual master-bearer authorization, distinct control/project
  databases, advisory locks, replacement journal, migration-role preparation,
  ledger leases and canonical/legacy ledger writes. Only project existence lookup
  is synthetic; SQL execution, authorization and migration implementation are not
  mocked. No second migration runner or production code change was introduced.
- Two immutable compiled HTTP fixtures are archived, then their source checkout
  is deleted. The old build reads/writes the original schema. The new build fails
  before listening until its archived additive SQL is applied through the actual
  route. Both builds then read/write concurrently, and restarting the old build
  preserves data written to the new column. Both work after a database restart.
- Receipts match the existing canonical normalized migration checksum. Exact
  replay returns 409, changed content under the same identity is rejected, and an
  independently held migration lock produces 423. Table ownership is checked
  immediately after the first migration, before later role preparation can mask
  the executor identity. Neither login is a superuser or role creator; the
  migrator has the platform's existing BYPASSRLS grant, while the runtime does not.
- Real division-by-zero and ledger-insertion-trigger failures prove handled
  failures roll back DDL and leave both ledgers unchanged. The failed receipts
  have no success checksum, leases are cleaned up, and the running new application
  remains usable. This does not prove crash recovery at every lease/commit point.
- Independent review found resource acquisition outside protected cleanup,
  missing signal cancellation, and reserved-lock release after a fallible unlock.
  Acquisition now sits inside cleanup, SIGINT/SIGTERM abort the owned PG/HTTP
  resources, and lock release runs in `finally`. A native test stops PostgreSQL
  before unlocking and verifies the error path completes cleanup. All reported
  review findings are closed.
- Final exact-source command:
  `SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin bun
  --no-env-file test
  packages/management-api/tests/unit/database-migration-native.routes.test.ts`
  passed 2 tests / 62 assertions. Without the explicit binary path, both tests
  skip and acquire no test cluster. The native test requires the compiler and
  runtime package artifacts built by the existing starter verification workflow.
- A bounded external observer waited for the test-only readiness checkpoint,
  confirmed two live HTTP child PIDs and the owned postmaster, then sent SIGINT
  at HTTP readiness and SIGTERM while the migration lock was held. Both runs
  proved all three processes stopped and the owned temporary directory was empty
  before observer cleanup. Earlier attempts that did not deliver a signal are
  not counted. The checkpoint is disabled by default and has a 20-second timeout.
  Current tracked and new-file whitespace checks passed.

These are local migration-route and additive-schema fixture results, not a
replacement for the complete authenticated approval/upload/worker reference
workflow across versions. That full workflow still needs dedicated full-platform
identity, Storage, native queue, operator provisioning and environment-bound
feedback acceptance. Platform activation/health/failure receipts, actual
application rollback through the platform, separate data recovery and the
previously recorded Management API typecheck gap remain open.
No commit, push, publication, remote platform request or production write occurred.
The original goal remains active and deploymentReady=false.

## Phase 15 Follow-Up Contract

Parent: Phase 14. Source: continuation of the original implementation goal.
Reason: the additive-schema fixture does not prove the actual authenticated
upload/approval/worker workflow across immutable application versions. Preserve
all four original requirements and the existing local-only authorization.
First enable the existing workflow verifiers to consume prebuilt archives,
verify the copied executable inventory before launch, and retain artifact
identities in their evidence. Then exercise old/new business workflow compatibility
and application rollback against an additive schema revision. Archive reuse alone
is not cross-version acceptance. Local fixture SQL is not a platform migration
receipt, and no local result substitutes for the remaining full-platform gates.
Native medium risk retains one writer and the existing read-only verifier.

## Phase 15 Archive Execution Checkpoint

- Added a fixture-only common HTTP/Worker archive builder and optional prebuilt
  artifact inputs to the existing business-workflow verifiers. Supplying an
  artifact bypasses compilation. Each verifier copies the manifest and selected
  object into its owned temporary directory, verifies the entire copied inventory
  through the existing compiler reader, checks the expected object identity and
  executable entry kind, then runs that verified copy.
- Native-Lite upload/registration/approval and the detached restricted-login
  Worker now consume the shared archive. Existing authorization, revoked-access
  replay, process restart, rollback preflight, durable result uniqueness and
  unknown-workflow fatal-exit checks remain. Evidence includes the selected HTTP
  and Worker object IDs, not a claim of remote runtime attestation.
- The native scenario corrupts a copied executable and tries a Worker object as
  the HTTP target. Both copies are rejected before execution. The separate native
  HTTP scenario also continues to exercise the default build path.
- Exact-source verification passed with exit 0:
  `npm exec --yes --package=bun@1.4.2 -- bun run verify:starter
  --postgres-bin /opt/homebrew/opt/postgresql@18/bin`.
  This covered packed-package typechecking/tests/builds, Lite PGlite, independent
  native PostgreSQL, native-Lite business workflow, diagnostic repair, watch/restart
  and detached HTTP/Worker template checks. The reused independent reviewer
  reported no blocking findings. Tracked diff and untracked fixture whitespace/
  conflict-marker checks passed.

This checkpoint does not complete Phase 15. The Worker preflight still imports
the current project's adapter; no old/new schema workflow or source-independent
cross-version compatibility is claimed. Full-platform identity/storage/native
queue, environment feedback, migration execution, activation, application rollback,
separate data recovery and the previously recorded Management API typecheck gap
remain open. No commit, push, publication or remote/production mutation occurred.
The original goal remains active.

## Phase 15 Local Cross-Version Workflow Results

- Built original and upgraded HTTP/Worker archives for the actual reference
  application. The upgraded test source delegates to the shipped host factories,
  adds a schema-revision guard and changes the real attachment adapter's result
  INSERT to write `writer_revision='v2'`. The temporary upgrade-only source files
  are deleted and the adapter source restored before either archive is executed.
  The current-project preflight remains separate from the detached execution.
- Both upgraded executables refuse startup before migration. The fixture checks
  the specific PostgreSQL undefined-column marker plus exit 1, not just a generic
  startup failure caused by missing configuration. Their verified migration
  inventories match. Only archived version 5 is applied to the owned native-Lite
  database; it adds a required application revision and a result column whose
  default is `v1`. This is local fixture DDL, not a platform migration receipt.
- The original, upgraded and rolled-back original artifacts each complete signed
  authentication, upload, registration, approval and detached Worker execution.
  Every HTTP stage retains authorization/revocation, idempotency, process restart
  and receipt/audit uniqueness checks. Every Worker stage retains restricted-role
  rollback preflight and durable-result uniqueness. The unsupported-workflow
  fatal-exit check runs last, avoiding contamination of earlier queue stages.
- Results from the actual workers have `v1`, `v2`, `v1` markers, respectively.
  Original data survives migration; original and upgraded results survive the
  database restart and application rollback, which adds its own distinct result.
  Rollback uses the exact original HTTP and Worker object IDs, not a
  newly compiled approximation. The database restart changes the private socket;
  the fixture re-reads it and preserves each restricted runtime username.
- The independent reviewer identified stale post-restart socket reuse. The fix
  was reviewed and the finding closed. Earlier verification attempts stopped at
  a subprocess stream type error and then the compiler's `source-any` /
  `source-type-assertion` governance checks; neither counts as workflow acceptance
  or runtime reproduction of the socket issue. Stream narrowing and explicit
  `unknown` guards fixed these without weakening the compiler policy.
- Final exact-source verification:
  `npm exec --yes --package=bun@1.4.2 -- bun run verify:starter
  --postgres-bin /opt/homebrew/opt/postgresql@18/bin`
  exited 0. Its native-Lite report includes all three artifact pairs, both
  pre-migration refusals and the retained-result checks. Packed checks/tests/builds,
  PGlite/native profiles, diagnostic repair, watch/restart and detached template
  acceptance also passed. Changed fixture whitespace/conflict checks passed.

This closes the local cross-version reference-workflow scenario, not the original
goal. It does not prove full-platform SupAuth, Storage, native queue ownership,
operator provisioning, environment feedback, reference-workflow platform migration
execution, activation/health/failure receipts, platform application rollback or
separate data recovery. The existing Management API typecheck gap remains separate.
No commit, push, publication, remote request or production write occurred.

## Remaining Platform Integration Audit

The remaining work is not only an environment/credentials acceptance gap.
The current repository does not connect compiler executable archives to the
self-hosted platform's release authority and managed application lifecycle:

- CLI deployment targets in `packages/cli/src/shared/tools/deploy-tools.ts` accept
  `frontend` and `edge_function`, not compiler HTTP/Worker archive targets.
- The immutable frontend release contract is `prebuilt_static`.
  `frontend-release-storage.ts` explicitly rejects SSR with
  `FRONTEND_RELEASE_SSR_UNSUPPORTED`. It cannot be reused by calling an executable
  archive a static release.
- Existing frontend SSR hosting provides tenant users, systemd, readiness and
  gateway publication/recovery, but its deployment record does not bind a compiler
  `objectId`. The legacy `deploy.service.ts` SSR path copies directories and
  restarts a configured service; that is not verified compiler-artifact activation.
- `systemd-unit-broker.ts` restricts units to PostgREST, GoTrue and frontend names.
  It is not an already-authorized arbitrary HTTP/Worker application launcher.
- Outside compiler code and tests/fixtures, the current verified migration-archive
  consumer is the CLI database planning branch. It reads the ledger; it does not
  upload or activate the executable.

The smallest reusable hosting foundation is the existing tenant runtime and
controlled systemd broker, with HTTP readiness/gateway support where applicable.
Still missing are project/runtime-bound executable archive intake, distinct
HTTP/Worker lifecycle handling, and objectId/configuration-bound activation,
failure/unknown-outcome and rollback authority. The original four requirements
remain unchanged; none of these missing capabilities is relabeled as implemented.

This crosses the frozen medium-risk local scope into executable-release contracts
and privileged broker policy. A separately confirmed high-risk follow-up is
required before implementing that platform capability expansion. It must not
weaken existing static/Edge contracts, add a second workflow engine, or infer
remote deployment permission. Further substitute fixtures do not close this gap.
An independent read-only audit confirmed the missing integration and the need to
confirm the expanded capability boundary.

No dedicated full-platform environment has been selected in this task. A
presence-only check found the current process's Management API URL/token/project,
Supabase URL/service role and SupAuth issuer/client context absent. No credential
values or unrelated credential files were inspected; this does not assert that
credentials do not exist elsewhere. Real identity/Storage/native queue, operator
provisioning, platform migration/activation and separate data recovery acceptance
remain required after the integration exists. The Management API typecheck gap
recorded earlier also remains separate.

## CLI Policy Regression Follow-Up

Parent: Phase 13. Source: the platform-integration audit's existing CLI tests.
Reason: registering `database.delivery_migration_plan` without its execution-policy
classification caused the global action-catalog validation to block unrelated CLI
commands at startup. This is a local wiring repair under the existing scope, not
approval of the platform expansion described above.

- Added only the missing action to the database `read` policy. The command still
  verifies the archive and reads the dedicated inventory GET endpoint; migration
  execution and production write confirmation are unchanged.
- Added tests for same-project read-only production use, cross-project rejection,
  unchanged migration-write guards and coverage of the actual registered database
  schema. The latter would catch this omission before CLI startup.
- Bun 1.4.2 targeted execution-policy, deploy, migration-plan and broker-policy
  tests passed: 35 tests / 219 assertions, with one native test initially skipped.
  Explicit native PostgreSQL execution of the migration-plan file then passed
  both tests / 100 assertions. The initial audit run's CLI failures are not counted
  as acceptance; the final run used the repaired source.
- CLI `tsc --noEmit`, CLI build and current diff whitespace checks passed.
  The reused independent reviewer found no blocking issue in the repair.
  No platform/broker permission was expanded and no remote mutation occurred.

Overall delivery remains PARTIAL. The immediate human decision is whether to
authorize the bounded self-hosted HTTP/Worker executable-release implementation;
providing credentials alone would not finish the original goal.

## Phase 16 Follow-Up: Application Releases

Parent: Remaining Platform Integration Audit and Phase 15.
Source: the user's instruction to avoid excessive security-driven design,
followed by the explicit continuation of "implement and complete".
Reason: implement the missing delivery bridge locally, preserving the existing
hosting stack instead of blocking again on an optional backend selection.

- Goal: application-level immutable releases containing HTTP and Worker targets,
  then environment-bound activation and runtime feedback on the existing
  self-hosted systemd foundation. The original four acceptance requirements stay
  in force; no remote execution or production acceptance is authorized.
- Non-goals: introducing Podman, Kubernetes, another workflow engine, migrating
  infrastructure, weakening static/Edge release contracts, committing or pushing.
- Stack: existing TypeScript/Bun compiler and Elysia Management API; detection
  evidence is their package manifests and existing tenant/systemd services.
  Deployment profile: existing SupaCloud backend/private infrastructure with
  existing Caddy ownership; database/auth/Storage/queue remain unchanged.
  Actual full-platform target and credentials remain unselected.
- Current writer scope: shared `@supacloud/delivery` contracts/readers extracted
  from the compiler with compatible compiler re-exports, package/lock/build and
  packed-starter dependency wiring, local publication-preparation configuration,
  Management API application release storage, focused storage tests and their CI
  wiring, and this evidence document. Runtime activation/broker changes remain
  subsequent work within this follow-up, not implicit acceptance of intake.
- Risk: high for the complete executable hosting bridge. Orchestration: bounded
  panel, current owner is the only writer; the reviewer is read-only.
  Local intake itself never executes archive code or migrations.
- Required profiles loaded from the local agent-team-config checkout because the
  installed agent-team skill directory is absent: stack-profile-selector,
  deployment-target-selector, typescript and supacloud-platform.
- Coordination runtime gap: `agmesh` is not on PATH. No automatic install/deploy
  is performed. Coordination DB was inspected read-only for competing writers;
  this follow-up contract records current scope and review evidence locally.
  Standard CLI restoration is `npm install -g agmesh && agmesh install`.
- Interruption recovery: the workspace mount moved from `/Volumes/Data` to
  `/Volumes/WorkData`; prior shell handles and the Gauss agent handle were checked,
  and the missing agent was replaced by the same-host read-only reviewer
  Confucius (`01a0db3e-482e-7333-a9fd-ef7f2595d9ec`). No earlier review result is
  treated as current approval.
- Intake acceptance: preserve all executable targets as one release; copy verified
  bytes, validate stored snapshot and migration inventory, atomically publish,
  bind project/application and expected object IDs, reuse repeat imports, reject
  tampering and partially executable manifests. This is a production storage
  component, not a replacement business-workflow fixture or platform activation.
- Verification: compiler build/typecheck, focused real-compiler storage tests,
  Management API typecheck compared with its baseline, current diff and reviewer
  findings. The initial baseline reported the previously recorded `SQL.listen`
  error in `realtime-bun.service.ts:158`; after dependency installation the current
  Management API typecheck passed without editing that service.
- Dependency decision: the initial direct compiler dependency was rejected by
  the existing API/compiler boundary rule before acceptance. Shared verification
  belongs to the delivery library; no boundary rule is loosened. Bun resolves
  shipped library sources so clean local installs need no generated compiler
  output for Management API operation. Node consumers use the library build.
- Publication preparation reuses `prepare-command-package.mjs` to replace local
  delivery references with the library version. Release configuration orders the
  delivery library before the compiler; registry visibility remains checked by
  the existing helper. These are local code/config changes only, not publication.
- CLI migration planning now consumes the same shared reader directly. Local
  CLI/Elysia/umbrella overrides resolve Bun's nested `file:` dependency paths;
  consumer acceptance below deliberately does not use those overrides.
- Rollback: remove only this follow-up's local code changes if requested; no
  existing release or database is rewritten by development/test execution.

### Phase 16 Intake Verification

- Shared library build and typecheck passed; compiler build passed with the
  `supacloud-source` condition. Management API full typecheck and the focused
  application-release test typecheck passed. CLI typecheck and build passed.
- Workspace boundaries passed for 22 packages; public API checks passed for
  app (301 symbols) and compiler (169 symbols), without changing their snapshots
  for this extraction.
- Actual compiler archive intake plus isolated storage units, CLI execution
  policy, deploy and migration-plan checks: 38 passed, one native PostgreSQL
  test initially skipped, 244 assertions. Explicit native PostgreSQL execution
  then passed both migration-plan tests with 100 assertions.
- HTTP/Worker, migration, build and diagnostic regression checks passed all
  26 tests with 448 assertions after refreshing stale dependency symlinks left
  by the workspace mount change. The initial six HTTP/Worker bundle failures
  and initial app public-API resolution failure are not acceptance evidence.
- Prepared delivery/compiler tarballs installed in an isolated npm consumer with
  no source checkout, sibling package directories, or overrides. Both Node
  exports and public TypeScript types passed. Both tarballs were supplied locally;
  this does not claim that either new release exists in the public registry.
- Publication-preparation tests passed all 15 tests. The first read-only review
  identified local `file:` publication references and missing root-directory
  parent synchronization. Both were fixed and closed by the second independent
  read-only review. Failure-injection coverage for directory synchronization is
  an additional test opportunity, not an observed unresolved defect.
- Full packed starter/native-Lite acceptance passed with Bun 1.4.2 and native
  PostgreSQL binaries from `/opt/homebrew/opt/postgresql@18/bin` (session 73502,
  exit 0). It covered packed consumers, PGlite, independent PostgreSQL,
  native-Lite HTTP/Worker old/new/rollback business flows, bounded diagnostic
  repair, watch/restart, and detached HTTP/Worker templates.
- The platform upload routes, activation controller,
  managed HTTP/Worker lifecycle, environment-bound runtime feedback, application
  rollback and separate platform data recovery are still outstanding.

Execution state: intake implementation verified; continue with the platform
upload and managed activation bridge. Full delivery remains PARTIAL. No remote
deployment, registry publication, commit or push was performed.

## Phase 17 Follow-Up: Platform Release Entry Points

Parent: Phase 16. Source: explicit continuation of "implement and complete".
Reason: expose the verified application-release storage through the platform and
CLI rather than leaving it as an unconnected internal component.

Scope: shared release record contract, paginated metadata inventory, bounded
multipart upload into an owned temporary directory, project-authenticated
Management API routes and registration, `applications` CLI actions and execution
policy classification, focused tests and documentation. Existing stack/deployment
profiles remain unchanged; the Elysia profile and current route/auth patterns were
consulted. No remote writes, commits, publication, or infrastructure migration.

Orchestration: one writer with the reused read-only Confucius reviewer. This is
part of the high-risk application-hosting bridge, but neither upload nor listing
starts application processes or executes migrations. Required acceptance:
real multipart content through registered route handlers into immutable storage;
duplicate imports, project/application isolation, missing/invalid/tampered
uploads, pagination, CLI response binding, read-only/production policy coverage,
and no confusion between release receipt and activation.

Runtime activation, environment-bound feedback, rollback and full-platform/data
recovery acceptance remain outstanding original requirements. This follow-up
does not reduce them to an upload test.

Phase 17 local verification:

- Compiler-built detached HTTP/Worker archives travel through the actual CLI
  tool, HTTP multipart endpoint and immutable storage. Duplicate upload, read,
  list, malformed/tampered input, missing resources, unknown receipt outcome
  and two-page storage inventory passed: 12 tests, 52 assertions.
- Management API storage and delegated capability mapping passed: 11 tests,
  56 assertions. HTTP integration injects authorization/project-existence
  dependencies; it is not live platform identity or deployment evidence.
- CLI execution policy and HTTP transport passed: 127 tests, 496 assertions.
  The first default-timeout run timed out an existing CLI subprocess test;
  rerunning with a 30-second test budget passed without changing that test.
- CLI application response identity, invalid pagination and registered action
  schema coverage passed: 3 tests, 6 assertions.
- Management API and CLI typechecks passed. Tools typecheck initially found
  a test authorization substitute returning null instead of undefined; the
  substitute was fixed and the full tools typecheck passed.
- Read-only review found two CLI issues: invalid upload receipts now report
  OUTCOME_UNKNOWN with the expected release ID; multipart callers can opt into
  the existing bounded response reader with a body deadline. Both have tests.
- The independent compiler CI job now installs CLI and delivery dependencies
  before the integrated test. This ordering was inspected locally; remote
  clean-checkout CI has not run.
- Upload never activates a release, executes its code or applies migrations.
  No commit, push, registry publication or remote deployment was performed.

Execution state: application upload/read/list implemented with local evidence.
Overall delivery remains PARTIAL; managed activation, runtime feedback,
application rollback and separate full-platform data recovery remain required.

## Phase 18 Follow-Up: Managed Application Runtime

Parent: Phase 17. Source: explicit continuation of "implement and complete".
Reason: immutable uploads need an executable runtime bridge on the existing
tenant/systemd foundation before a controller can activate and roll back them.

Scope: activation-bound HTTP/Worker plans, verified tenant-readable runtime
copies with private environment files, systemd broker support, install/start/
stop/process observation, and focused local tests. One writer and the existing
read-only reviewer. Existing Bun/TypeScript and SupaCloud deployment profiles
remain selected; no replacement orchestration engine or hosting migration.

Process liveness is not application readiness. This phase does not switch
gateway traffic, run migrations, or write an authoritative active-release
pointer. Controller recovery, readiness, platform acceptance and data recovery
remain required; no production writes are authorized by these local changes.

Phase 18 local verification:

- Activation plans bind project/application, release, environment, Bun version
  and all HTTP/Worker targets. Units use immutable object paths and a pinned
  `/opt/supacloud/bun/<version>/bun`, not the installer's home or PATH.
- Runtime preparation re-verifies stored archive bytes, publishes an owned
  runtime copy, keeps environment files at 0600, and rejects configuration
  changes under an existing activation ID. Explicit modes survive umask 0077;
  original intake permissions remain unchanged.
- Detached actual compiler objects were started from the prepared directory
  after removing the upload directory. HTTP returned its response, the Worker
  emitted its startup event, and both exited successfully on SIGTERM. The
  combined intake/HTTP/CLI/runtime suite passed 15 tests, 74 assertions.
- Runtime/broker/storage/embedded-helper tests passed 27 tests, 96 assertions.
  Systemctl operations in those unit tests are injected; a successful process
  observation is explicitly not a business-readiness result.
- The canonical shell broker accepted the generated application unit and
  rejected mismatched tenant/target environment files. Bootstrap tests verified
  the executable survives removal of its source home, preserves its pinned
  version, and propagates runtime-copy failure through both installer branches.
- Management API typecheck, focused runtime/storage test typecheck and full
  tools typecheck passed. The focused check first found an inferred optional
  test-map property; explicitly typing the invalid-port fixtures fixed it.
- Read-only review identified home-based Bun execution, umask-dependent modes
  and installer failure propagation. These were fixed with focused regression
  coverage. The shell CI job now installs its new renderer dependencies.
- Actual Linux systemd/tenant-user execution, managed readiness, gateway
  activation, restart reconciliation and rollback remain unverified. The local
  direct-process smoke uses the current test user and executable; it is not a
  substitute for those checks. Remote clean CI has not run.

Execution state: runtime preparation and the systemd driver implemented with
local evidence. Continue with the durable activation controller and its
readiness/traffic/recovery integration. Overall delivery remains PARTIAL; no
commit, push, publication or remote deployment was performed.

## Phase 19 Follow-Up: Durable Activation Controller

Parent: Phase 18. Source: explicit continuation of "implement and complete".
Reason: connect the runtime lifecycle to the existing project mutation journal
and an application/environment active-release authority.

Scope: a stop/start activation controller, persistent checkpoints using the
existing project mutation implementation, atomic filesystem authority, explicit
readiness and gateway ports, replay/readback, application upgrade/rollback and
fault tests. Native PostgreSQL acceptance uses an owned ephemeral cluster and
the production platform-v2 mutation schema. One writer and the reused read-only
reviewer; no production or remote writes.

This is controlled downtime, not a zero-downtime rollout. Unknown transitions
remain unresolved and block the resource; they are not auto-retried or silently
compensated. Application rollback is activation of an older immutable release
with a new activation ID, never a database rollback. Concrete readiness/gateway
adapters, explicit unknown-outcome reconciliation, API integration and complete
Linux/full-platform acceptance remain required after this controller work.

Phase 19 local verification:

- Controller tests passed seven cases and 32 assertions: staged checkpoint
  ordering, persisted authority/readback, duplicate replay, upgrade and explicit
  older-release activation, revision/compatibility failures, readiness failure,
  post-route unknown outcome and interrupted-transition refusal.
- The project release and mutation regression run passed 70 tests and 230
  assertions before adding the seventh application-only regression. Existing
  callers keep the default control-plane SQL connection; injectable factories
  allow the same implementation to use an explicitly owned test database.
- Native PostgreSQL acceptance passed one end-to-end test with 19 assertions,
  using `/opt/homebrew/opt/postgresql@18/bin`. It creates a private cluster,
  applies the production platform-v2 journal schema/migrations over minimal
  prerequisite tables, activates, restarts PostgreSQL, replays without another
  start, rejects changed request fingerprints, and proves an outcome-unknown
  activation blocks a conflicting activation on that resource. It also injects
  interruption at a prepared checkpoint with a non-empty previous release,
  expires only the owned fixture lease, restarts PostgreSQL, and verifies
  checkpoint decoding plus successful takeover at fencing epoch 2.
- Native runtime/readiness/gateway effects remain injected in this journal
  test; it proves persistence and mutation semantics, not systemd or live Caddy.
- A reviewer found legal target names such as `token` collided with the existing
  public-journal field checks. Checkpoints now encode ports as fixed-field
  `{target, port}` arrays; both unit fixtures and the native test exercise the
  real payload validator with that target name. Global validation was unchanged.
- Management API, focused activation/runtime tests and tools typechecks passed.
  Workflow YAML parses, and the native test has a dedicated CI job creating
  its own cluster. Remote CI has not run.

Execution state: durable controller/journal/authority implemented and locally
verified. Concrete readiness/traffic/compatibility adapters, API binding and
explicit unresolved-outcome reconciliation remain before managed activation can
be offered. Full-platform runtime feedback and independent data recovery also
remain required. Overall status stays PARTIAL; no remote writes or publication.

## Phase 20 Follow-Up: Managed Readiness And Runtime Feedback

Parent: Phase 19. Source: explicit continuation of "implement and complete".
Reason: replace the controller's unconnected readiness requirement with an
actual host protocol and process-bound probes, and expose read-only feedback.

Scope: shared runtime identity/report contracts, managed-only HTTP probe and
Worker startup metadata in compiler output, loopback HTTP plus current systemd
invocation/PID journal probes, before/after process observation, and project-
authenticated API/CLI runtime reads. Unmanaged host startup stays compatible.
One writer and the reused read-only reviewer; no production changes.

Readiness means host initialization/start has completed; an HTTP host may
implement ready() for dependency checks. It is not a replacement for the
representative authenticated business workflow acceptance. Actual Linux journal
provenance, Caddy activation, unresolved-outcome reconciliation and the remaining
full-platform/data-recovery acceptance are still required.

Phase 20 local verification:

- Managed compiler output exposes a metadata-only HTTP probe and includes
  release/environment/activation/object/PID identity in the Worker startup
  event. Without managed activation variables the old host behavior is retained.
  Optional HTTP ready() failures return non-ready; abort is checked again after
  awaiting the hook.
- Readiness checks use real loopback HTTP and current-invocation journal
  queries, with systemd identity observed before and after. Cancellation reaches
  the systemctl, HTTP and journal operations; subprocesses are drained on abort.
  Default observations have a five-second budget, and repeated readiness
  attempts use the remaining wait budget.
- Readiness/runtime/route tests passed 16 cases, 63 assertions. They cover
  stale identities, PID/invocation changes, incomplete inventories, redacted
  failures, cancellation, absent active state, authorization and authority
  changes during a read.
- The rebuilt compiler's detached archive suite passed 16 cases, 80 assertions.
  Actual HTTP and Worker processes emitted managed identities; the default HTTP
  probe accepted the active host and rejected its subsequent ready() failure.
  Process observation and journal envelopes are test adapters in this portable
  suite; actual Linux journal provenance is not claimed.
- HTTP/Worker compiler regression passed seven tests, 240 assertions, including
  unmanaged behavior and lifecycle cancellation/drain scenarios.
- CLI tool/policy checks passed 22 tests, 112 assertions. `applications
  get_runtime --environment_id ...` is read-only, validates report consistency
  and environment identity, and preserves null/non-ready results.
- Compiler and delivery builds, delivery/CLI typechecks, focused Management API
  test typecheck and tools typecheck passed. The project authorization checks
  also include the new operations.read path.

Execution state: real probe adapters and authenticated read-only runtime
feedback are implemented with local evidence. Managed activation still needs
the concrete gateway/compatibility adapters, write API and reconciliation;
Linux/full-platform and separate data recovery evidence remain outstanding.
Overall status stays PARTIAL. No commit, push, publication or remote deployment.

## Phase 21 Follow-Up: Application-Owned Caddy Routes

Parent: Phase 20. Source: continued implementation of the existing delivery goal.
Reason: provide the concrete traffic adapter without routing applications through
frontend deployment identities or introducing another proxy/control plane.
Scope: application route construction, existing Caddy provider integration,
live/durable verification, reconciliation isolation and focused regressions.
Native execution with one writer and the reused read-only verifier.

- One project/application/environment owns one stable route group. All HTTP
  targets switch in one existing Caddy configuration load; each child binds
  its activation and target and proxies to its explicit loopback port. Worker
  targets never receive routes. Worker-only releases remove the previous group.
- Exact hostname bindings are explicit inputs, not inferred configuration.
  Application hosts are exclusive. Conflicting host routes and preceding
  host-unrestricted routes are rejected after actual route sorting, and again
  during readback. Trailing fallback routes remain supported.
- The provider checks both the live admin API and the durable JSON. It reuses
  existing serialized loads, lost-response observation, durable persistence and
  quarantine repair. Deferred reconciliation cannot return an application
  activation receipt before the actual load. Unknown results are not reported
  as successful activation.
- Canonical clean rebuild preserves activation-owned routes. Frontend CORS and
  project-domain removal do not rewrite application routes; project deletion
  uses exact application-family ownership, including hyphenated project refs.
  A rejected reconciler candidate is discarded before it can poison a later
  publish. Persisted application hosts use the existing TLS domain allowlist.
- The verifier identified project-name/family substring deletion and
  host-unrestricted route shadowing. Both were fixed and reviewed closed.
  Regression tests also cover multi-HTTP groups, restart hydration, rollback
  under a new activation ID, live/durable disagreement, rejected loads, lost
  responses, quarantine and failed domain reconciliation.

Local verification: Bun 1.4.2 passed the application gateway and existing gateway
service/builder suites: 109 tests, 805 assertions. Management API typecheck and
the focused application-release test typecheck passed. The final review closed
both findings; the writer also added the suggested hyphenated-project and
empty/mixed matcher assertions. Diff whitespace validation passed.

Acceptance boundary: Caddy admin requests are mocked in the portable tests;
filesystem persistence is real. No Caddy executable is available on this host,
so these checks do not prove live traffic, TLS issuance or Linux behavior.
The application activation write API remains unmounted. Environment/port/host
configuration, migration compatibility, explicit unresolved-outcome
reconciliation, actual runtime/controller composition, full-platform acceptance
and separate data recovery remain required. Overall status stays PARTIAL.
No commit, push, publication or deployment was performed.

## Phase 22 Follow-Up: Stored Release Migration Inspection

Parent: Phase 21. Source: continued implementation of the original delivery goal.
Reason: the application controller still needs database evidence associated with
the uploaded immutable release, not only a CLI plan for a local target.
Scope: reuse the single-target planner, inspect all uploaded targets against the
actual project ledger, expose a read-only API, and verify legacy ledger behavior.
Native execution, one writer and the reused read-only verifier.

- The existing CLI planner is now exported by `@supacloud/delivery`. Its output
  and checksum normalization remain unchanged; CLI and server share the same
  pending, match, name conflict, checksum mismatch and out-of-order decisions.
- Storage reads verify the full immutable release and every target's archived
  migrations. Application inspection also detects conflicts between targets,
  including same-version content/executor/name changes and names reused under
  different versions.
- `GET /v1/projects/:ref/applications/:id/releases/:releaseId/migrations` uses the
  existing project authorization. It returns release identity, a project-ledger
  digest and metadata-only per-target plans, never SQL or connection credentials.
  It does not migrate, provision, activate, or repair a database.
- The real project inventory reader uses a repeatable-read, read-only
  transaction. Per-query savepoints allow genuinely missing tables or older
  metadata columns without aborting the consistent snapshot.
- Review found that the previous legacy-column fallback discarded existing
  checksums when only timestamps were missing, and that a selected canonical
  ledger could hide a bad legacy stored checksum. The fallback now preserves
  available metadata; inventory verifies both ledgers before selecting rows.
  General promotion reads retain their existing selection semantics.

Local verification with Bun 1.4.2:

- Application migration, runtime-route, ledger and promotion regressions:
  32 tests, 108 assertions. Existing database baseline routes: 14 tests,
  80 assertions.
- Detached compiler archive/storage and shared CLI migration-plan suites:
  19 tests, 186 assertions, with native PostgreSQL enabled. Includes verified
  uploaded HTTP/Worker migration inventories, corruption refusal and native
  ledger restart/drift checks.
- Owned PostgreSQL inventory acceptance: one test, 18 assertions. Missing and
  old ledgers are not initialized or repaired; both checksum regressions are
  rejected. A real exclusive table lock pauses the inventory between ledger
  reads while another transaction updates both ledgers; the in-flight snapshot
  remains on the old version and the next inspection sees the new version.
- Shared delivery build/typecheck, CLI typecheck, Management API typecheck,
  focused application test typecheck and tools typecheck passed. The first tools
  check raced the CLI's implicit compiler rebuild; it was rerun after that build
  completed, as were the detached consumer suites. The native CI job includes
  the new owned-cluster test; remote CI has not run.
- Independent read-only review closed its checksum finding. No commit, push,
  publication or deployment was performed.

`project_migrations_applied` refers only to project-migration declarations.
Operator provisioning stays separately unverified, and runtime/schema
compatibility remains explicitly `not-proven`. These reports are database
evidence, not a successful implementation of the controller's complete
compatibility gate. Environment/port/host configuration, compatibility execution,
activation write APIs, unresolved-outcome reconciliation, full-platform
acceptance and independent data recovery remain outstanding. Status: PARTIAL.

## Phase 23 Follow-Up: Confirm Committed Activation Recovery

Parent: Phase 22. Source: continuation of the same implementation goal.
Reason: a process may commit active authority and then lose its success receipt;
the application replay path previously rejected generic journal recovery receipts.
Scope: observation-based success reconciliation using the existing journal and
fencing protocol, plus read-only previous-runtime stopped checks. One writer,
with the same independent read-only verifier.

- Recovery accepts project/application/environment/activation identity and the
  original principal; it reconstructs immutable desired/previous identities from
  the checkpoint and validates the original request fingerprint. Environment
  values do not need to be resubmitted.
- Only routed/committed checkpoints can be confirmed by this operation. The
  desired active authority, readiness and route must agree, and a previous
  activation must be observed stopped. Authority is read again after probing.
  The operation never starts/stops a process, changes traffic, writes active
  authority or runs migrations.
- Matching authority durability is explicitly confirmed by syncing the existing
  active file and ancestor directories and rereading it, without rewriting or
  renaming its contents. Readable state after rename is not sufficient if the
  original directory sync failed; recovery remains unknown until sync succeeds.
- A live execution lease is not taken over. A running mutation whose lease has
  expired is claimed through the existing journal, fenced at a new epoch and
  marked unknown before observation. Existing reconciliation then persists the
  result with its normal principal, epoch and observation-time checks.
- Recovery evidence fingerprints bind the complete desired immutable
  configuration. Normal activation replay accepts either its original success
  receipt or that exact recovery receipt shape. Unbound receipts, changed
  principals, mismatched environments and changed authority remain failures.
- `ApplicationSystemdRuntime.requireStopped` observes all targets without issuing
  a stop command. Normal `stop` reuses that termination verification.

Local evidence: activation/runtime/readiness tests passed 28 cases and
129 assertions. The native PostgreSQL journal suite passed two tests and
42 assertions, including live-owner refusal, fixture-owned lease expiration,
restart/takeover at epoch 2, generic recovery receipt replay and authority-write
response loss at the routed checkpoint. Both suites also inject a directory-sync
failure after rename and verify that recovery stays unknown until durability can
be confirmed. Runtime and gateway effects in this
native suite are explicit test adapters, not Linux/systemd/Caddy acceptance.
Management API, focused application tests and tools typechecks passed. The
independent verifier closed the authority-durability finding after checking
the confirmation path and both fault regressions.

This is success confirmation, not a universal repair action. An uncommitted
authority, earlier process-transition failure, unhealthy candidate or still
running previous worker is left unresolved; it is not silently restarted or
marked failed. Explicit operational recovery for those states, environment/
port/host configuration, compatibility execution, activation API composition,
full-platform acceptance and independent data recovery remain required.
Overall status stays PARTIAL. No commit, push, publication or deployment.

## Phase 24 Follow-Up: Concrete Deployment Composition

Parent: Phase 23. Source: continued implementation of the original delivery goal.
Reason: the activation controller's low-level ports now have implementations but
must be connected coherently, including hostname identity across restart.
Scope: immutable traffic bindings and a programmatic deployment service using
the existing components. Native execution with one writer and the reused
read-only verifier.

- `ApplicationDeploymentService` connects verified intake, private runtime files,
  managed systemd installation/start/stop, readiness, migration inventory,
  durable active authority and the existing gateway singleton. It does not
  create another Caddy owner with independent mutable configuration.
- Hostname bindings are persisted in active authority and included in request
  and recovery fingerprints. Journal checkpoints use fixed-field arrays, so
  target names such as `token` remain legal. Recovery reconstructs traffic from
  that stored configuration rather than from new caller-provided hostnames.
- Managed deployment requires explicit hostname bindings. Existing low-level
  records without bindings remain readable, but cannot silently acquire a
  managed route during deployment or recovery.
- Project migrations must already match the ledger. The application-specific
  compatibility verifier is mandatory, receives isolated copies of runtime,
  previous state and environment values, and must cover schema/runtime and any
  operator provisioning. There is no default success verifier.
- Upgrades reject ports still referenced by the previous application's route,
  before preparation or process transitions. This avoids an old proxy endpoint
  reaching the new process before readiness. Global port allocation/reservation
  and deployment configuration API policy are still required before exposing
  the general activation write API.
- The composed readiness adapter validates report identity, ready state and
  the complete target set before publishing traffic.

Portable integration uses actual archived HTTP/Worker executables, runtime file
preparation, running child PIDs, loopback HTTP readiness, persisted Caddy JSON
and active authority. After an injected success-receipt loss, a new deployment
service/provider instance recovers using the persisted hosts, with one process
start command and one Caddy load in total. Systemd operations and journal
provenance are explicit test adapters; Caddy admin transport, migration inventory
and mutation journal in this one fixture are also test adapters. It is not
Linux, actual Caddy traffic, or full business-workflow acceptance.

The shared gateway and controller regression suites, native PostgreSQL journal
suite and detached compiler consumer suite remain part of verification. The
root tools typecheck now includes the existing Management API SQL-module type
declaration because the integration test imports the concrete gateway service.

Local verification with Bun 1.4.2:

- Deployment/activation/application-gateway and existing gateway regressions:
  121 tests, 843 assertions.
- Detached archive/storage/host suite: 18 tests, 96 assertions, including the
  composed real-child activation and receipt recovery scenario.
- Native PostgreSQL journal suite: two tests, 44 assertions, now also checking
  persisted hostname arrays and recovery after restart.
- Management API, focused application and Caddy test typechecks passed.
  Root tools typecheck passed after adding the existing SQL declaration.
  Independent read-only review reported no new explicit correctness issue;
  suggested wrong-readiness-identity and changed-checkpoint-host regressions
  were added and passed.

Local test-host discovery: the explicit `orbstack` Docker context points to the
local Unix socket and responds as Linux/aarch64; `orb list` reported no existing
machines. No machine/container was created or modified by this discovery.
This is an available avenue for dedicated local Linux acceptance, not proof
that the platform or its systemd/Caddy services have been exercised.

The activation write API is intentionally still unmounted. Remaining work
includes target configuration/port ownership, the concrete application
compatibility implementation, explicit recovery for other unknown states,
Linux/full-platform business acceptance and independent data recovery.
Overall status stays PARTIAL; no commit, push, publication or deployment.

## Phase 25 Follow-Up: Real Linux Runtime And Gateway Acceptance

Parent: Phase 24. Source: continued implementation of the original delivery goal.
Reason: portable process adapters cannot prove the real broker, systemd,
journald or Caddy path. Native execution with one writer and the reused
read-only verifier; changes are confined to acceptance tooling/documentation.

Created the owned isolated OrbStack machine
`supacloud-delivery-acceptance-0926` (Ubuntu 24.04, arm64). The initial global
systemd status was degraded only by `sys-kernel-debug.mount`; application
acceptance checks individual service observations rather than claiming whole
machine health. No existing machines, containers or production services were
modified. Two temporary binary-extraction containers were removed.

`scripts/build-linux-delivery-acceptance.ts` builds a detached HTTP/Worker
fixture with the current compiler dist and bundles the actual runtime services.
It records compiler, runner, broker, template and manifest digests.
`scripts/linux-delivery-acceptance.ts` uses unmodified default runtime files,
systemd broker/operations, readiness probes and Caddy provider operations.
The reproduction steps and exact coverage are in
`docs/linux-delivery-acceptance.md`.

September 26, 2026 local Linux evidence:

- Bun 1.4.2; stock Caddy 2.11.4 from cached arm64 images.
- Successful final normal receipt:
  `/var/lib/supacloud-delivery-acceptance/run-yLhmvK/receipt.json`.
- Real tenant HTTP and Worker start, exact UID/GID checks, loopback readiness,
  Worker journal PID/invocation binding, real Caddy proxied HTTP 200, persisted
  route readback after provider reconstruction.
- Target stop/start generated new journal invocation identities; an HTTP
  readiness failure was detected while the Worker remained ready.
- Occupied 2019 regression rejected the runner before any request to the old
  server (old server request count remained zero).
- SIGTERM receipt `run-YoWIpw` and SIGINT receipt `run-nJsbc3` both reported
  failure, confirmed two targets stopped and removed all owned application units.
- Stalled-gateway regression `run-zPtJ5h`: SIGSTOP the owned Caddy after targets
  start, then SIGTERM the runner. Cancellation terminates only that Caddy child,
  closes its requests and reaches serial cleanup: failure receipt, two stopped
  targets, no owned application units and no remaining Caddy PID.
- Detached archive/storage/host regression: 18 tests, 96 assertions passed.
- Compiler build and root tools typecheck passed. Compiler builds and their
  dist consumers must remain sequential; an overlapping check was rerun after
  build completion.

The verifier's initial port-ownership and signal-cleanup findings were repaired
and exercised on the real machine. Runtime artifact directories and receipts
are retained for inspection; application units and Caddy children are stopped
and removed after each run. Stock Caddy and an isolated host do not prove the
custom platform deployment. No real business database or activation journal is
used by this fixture, and no activation write API was enabled.

Remaining scope is unchanged: target configuration/port ownership, concrete
application compatibility, operational recovery, complete Lite/full-platform
business acceptance, application rollback and independent data recovery.
Final tools typecheck and diff check passed. The read-only verifier closed both
findings. The owned acceptance machine is stopped, with receipts retained.
Overall status stays PARTIAL. No commit, push, publication or production deployment.

## Phase 26 Follow-Up: Versioned Environment Configuration

Parent: Phase 25. Source: continued implementation of the original delivery goal.
Reason: deployment currently accepts in-memory configuration without an
operator-facing durable revision. Native execution with one writer and the
reused read-only verifier. Scope: shared contracts, control-plane persistence,
authorized configuration API/CLI and explicit-revision deployment composition.

Environment configuration holds Bun version, named HTTP/Worker targets, hosts
and environment values. Revisions are immutable and the current head advances
with an expected-revision check. An identical retry returns the original
revision without moving a newer head backward. Stored values use the existing
secret encryption utility; public reads return variable names, never values.
No runtime ports are allocated and no processes are activated by saving a
configuration. Port ownership remains a separate activation prerequisite.

The configured deployment method resolves a selected revision and verifies the
release target inventory. Its revision ID is retained in activation authority,
checkpoint/request identity and optional runtime feedback. Existing direct
programmatic activation remains compatible. The public activation write API
is still unmounted until allocation and compatibility execution are complete.

Verification with Bun 1.4.2 on September 26, 2026:

- Configuration, configured deployment/runtime, CLI policy and HTTP transport:
  150 tests, 636 assertions passed.
- Detached compiler archive/storage/host and canonical control-plane schema
  regressions: 31 tests, 250 assertions passed.
- Native PostgreSQL configuration: six tests, 48 assertions passed, including
  real CLI -> HTTP -> PostgreSQL writes/reads, encrypted persistence, restart,
  concurrent CAS, identical retries, cross-scope rejection and bounded responses.
- Native PostgreSQL activation journal: two tests, 47 assertions passed,
  including persisted configuration identity after lease expiry/restart,
  confirmed recovery without repeated effects and changed-revision replay refusal.
- Management API, CLI, shared delivery and root tools typechecks passed; delivery
  package build passed. The independent read-only verifier closed both findings;
  its suggested native recovery identity regression was added and passed.

Initial native testing caught and corrected double-encoded JSON parameters.
Review also caught missing required revision validation and an unbounded PUT
response reader. Both have regression coverage, including an actual stalled
HTTP body that ends as an unreadable receipt without replaying the mutation.
The existing CLI subprocess policy test exceeded its default five-second budget
under concurrent verification, then passed with the explicit 30-second test
budget; no policy behavior was relaxed.

The database tests use owned temporary native clusters, not a deployed platform.
Runtime effects in the configured-deployment unit test are adapters; the prior
Linux acceptance remains separate evidence. This phase does not prove configured
full-platform business execution. Remaining work includes global runtime port
ownership, concrete compatibility execution, the public activation write API,
operational recovery, full-platform business acceptance and separate data recovery.
Overall scope stays PARTIAL. No commit, push, publication or production deployment.

## Phase 27 Follow-Up: Durable Runtime Port Ownership

Parent: Phase 26. Source: continued implementation of the original delivery goal.
Reason: configured activation still accepts caller-selected ports and cannot
coordinate independent applications. Native execution, one writer and the
reused read-only verifier. Scope: additive allocation schema, one-host allocator,
configured-deployment composition and deterministic/native PostgreSQL verification.

The metadata database owns immutable per-activation runtime allocations and
globally unique application port claims. The request includes release identity,
environment, Bun version and configuration revision. Replays retain the original
ports, including after a process/database restart or a pool configuration change.
The default pool is 20000-29999, configurable with
`SUPACLOUD_APPLICATION_PORT_RANGE`; new allocation rejects overlap with existing
configured tenant, frontend SSR, database, JIT gateway and management/admin ports.
Persisted tenant overrides and actual loopback listeners are also excluded.

Configured activation verifies the stored release, resolves the selected
configuration and obtains its durable server-selected ports before starting
the activation mutation. Low-level `activate` remains a programmatic explicit
runtime entry; the eventual public write API must use configured allocation.
No allocation starts processes or moves traffic. Reservations outlive deleted
project metadata and failed/unknown activations; there is deliberately no
automatic expiry or reuse before explicit stopped/unrouted retirement is proven.

Verification with Bun 1.4.2 on September 26, 2026:

- Native PostgreSQL allocation, configuration and activation journal suites:
  16 tests, 159 assertions passed. The allocation suite contributes eight tests
  and 64 assertions, including concurrency, database restart, pool changes,
  occupied sockets, tenant overrides, exhaustion and transactional claim failure.
- Allocation/deployment/activation, configuration loading, canonical schema
  bootstrap and release archive regressions: 84 tests, 519 assertions passed.
- Management API, focused application API/tests and root tools typechecks passed.
  The working diff whitespace check passed.
- A composed native test connects real configuration revisions, port allocation,
  mutation journal and active files. It covers old-revision replay after a head
  change, upgrade and explicit configuration rollback with distinct ports, and
  reconciliation without repeated starts. Release storage, runtime, readiness,
  gateway and compatibility execution remain test adapters.
- The independent read-only verifier confirmed the composed coverage gap was
  closed and reported no new findings. It did not execute the test suites.

This is application ownership within the current single-systemd-host metadata
scope, not an OS socket held for the entire allocation lifetime or a multi-host
scheduler. Temporary PostgreSQL clusters and composed adapters do not establish
real full-platform deployment acceptance. Full-platform acceptance, compatibility
execution and retirement/recovery remain required. Overall status stays PARTIAL.
No commit, push, publication or production deployment.

## Phase 28 Follow-Up: Explicit Activation API and CLI Composition

Parent: Phase 27. Source: continued implementation of the original delivery goal.
Reason: durable allocation and configured deployment existed, but operators had
no explicit HTTP/CLI mutation contract that could select a release and pinned
configuration revision. Native execution, one writer and one read-only verifier.
Scope: activation/reconcile schemas, conditional Management API composition,
CLI write actions and end-to-end request/receipt verification.

The delivery package now defines immutable activation request/result schemas.
The composed Management API can expose activation and reconciliation endpoints
only when supplied a complete `ApplicationDeploymentService`; the default
application routes remain upload/configuration/runtime read-only until concrete
compatibility execution is wired. Activation requests include release ID,
configuration revision ID, activation ID and expected active activation ID.
They never accept caller-selected ports. Reconciliation confirms committed
authority and does not replay runtime or gateway effects.

The CLI exposes `activate_release` and `reconcile_activation` as protected writes.
`absent` is the explicit first-activation marker; upgrades and rollbacks require
the currently observed activation ID. The CLI validates response identity and
reports transport, unreadable-response and server-side uncertain outcomes with
the requested activation ID, without automatic replay.

HTTP failures preserve the activation identity and distinguish authorization
(401), revision/principal/port conflicts (409), and reconciliation-required or
unknown outcomes (503). Backend exception text is not returned. Unit coverage
includes conditional route mounting, authentication ordering, immutable request
validation, receipt binding, conflict/unknown mapping and CLI single-request
behavior. The composed native PostgreSQL test now reaches the activation route
through a real local HTTP server and the CLI transport, while runtime, gateway,
readiness and compatibility remain explicit test adapters.

Verification with Bun 1.4.2 on September 26, 2026:

- Native PostgreSQL configuration, activation journal and allocation composition:
  16 tests, 164 assertions passed.
- Management API activation/runtime/deployment and CLI application/policy tests:
  46 tests, 361 assertions passed; the follow-up activation route suite adds six
  tests and 60 assertions, and the CLI application suite covers activation,
  reconciliation, invalid aliases and unknown outcomes.
- Focused Management API typecheck, CLI typecheck and diff whitespace checks
  passed. A separate invocation using the latest standalone `tsc` is not
  evidence: it rejected this repository's TypeScript 7 `baseUrl` configuration
  before checking project sources.
- The independent read-only verifier found and the owner repaired two HTTP
  contract issues: real authorization envelopes were being schema-rejected as
  422, and activation conflicts/unknown states were being flattened into 500.

This phase does not claim the default Management API is deployable: it still
requires a concrete compatibility verifier and real runtime/gateway/readiness
composition before mounting activation writes. Full-platform acceptance,
compatibility execution, verified allocation retirement/recovery, application
rollback with independent data recovery remain required. Overall status stays
PARTIAL. No commit, push, publication or production deployment.

## Phase 29 Follow-Up: Explicit Runtime Allocation Retirement

Parent: Phase 28. Source: continued implementation of the original delivery
goal. Reason: durable reservations correctly survived failed and unknown
activation outcomes, but there was no auditable way to release a reservation
after an operator had separately proved that no process or route remained.
Native execution, one writer and no automatic expiry/recycling. Scope: additive
retirement state, claim release and regression evidence.

`ApplicationRuntimeAllocations.retire` now requires a caller-owned verifier that
confirms both stopped processes and an absent route. The allocator itself never
stops a process, changes gateway traffic, probes a replacement port or retries
an unknown activation. It rechecks the immutable allocation fingerprint under
the global allocation lock before deleting port claims, records a retirement
timestamp/fingerprint, and keeps the retired allocation row as an audit
tombstone. A retired activation ID cannot be allocated again; a different
activation may reuse the released port normally. Existing installations get
the retirement columns through additive `ALTER TABLE ... IF NOT EXISTS`.

The verifier is intentionally outside the allocator because process stop,
gateway removal and activation-mutation ownership belong to the deployment
composition. A failed stopped/unrouted proof leaves all claims unchanged;
repeated retirement is idempotent and does not rerun the external verifier.
Unknown activation states therefore remain blocked until their owner performs
the required observation/recovery decision; no automatic compensation was
introduced.

Verification with Bun 1.4.2 on September 26, 2026:

- Native PostgreSQL allocation suite: nine tests passed, including failed proof
  preserving claims, explicit retirement, audit tombstones, idempotent retry,
  retired-ID rejection and reuse by a different activation.
- Focused Management API allocation/deployment tests passed; focused
  Management API typecheck passed.
- The broader native configuration, activation journal, allocation and composed
  HTTP/CLI suites remain green from Phase 28. Diff whitespace checks remain
  clean.

The composed deployment service now exposes a retirement method and the
Management API conditionally mounts
`POST .../activations/:activationId/retire` only when that service is supplied
with an explicit stopped/unrouted verifier. The default Management API remains
unmounted. The method checks the project/environment allocation identity and
rejects retirement while the allocation is still the active authority.
The CLI now exposes `retire_activation` as a protected write, posts only once,
validates the returned activation/tombstone identity and retains the activation
ID on unknown outcomes. Full mutation-journal recovery orchestration remains
open. Full compatibility execution, full-platform acceptance, mounted default
activation, application rollback and independent data recovery remain required.
Overall status stays PARTIAL.

## Phase 30 Follow-Up: Independent Restore Drill Evidence

Parent: Phase 29. Source: continued implementation of the original delivery
goal. Reason: independent data recovery was previously represented only by
older evidence and had not been rerun against the current local toolchain.
Scope: execute the existing isolated restore drill without changing application
delivery behavior or production state.

The repository's restore drill was rebuilt as
`supacloud-restore-drill:local-20260926` from the current workspace and run on
the explicit local OrbStack Docker context. Fresh PostgreSQL 18 containers
exercised both logical-full and pgBackRest recovery. The drill verified tenant
RLS visibility, queue state, business rows, authenticated runtime checks,
recovery markers and the pgBackRest post-target transaction absence check. It
also rejected duplicate drill IDs without changing signed receipts and
rejected a corrupted object before database restoration.

September 26, 2026 receipt summary:

- logical-full: eight checks, RPO 455 ms, RTO 3339 ms;
- pgBackRest: nine checks, RPO 2714 ms, RTO 3078 ms.

The detailed receipt artifacts were retained in the temporary drill directory
reported by the command and all containers/volumes created by the harness were
removed. This strengthens local independent-recovery evidence but is still
synthetic data. It does not prove approved production snapshots, production
RPO/RTO, full-platform application rollback or production recovery
authorization. Overall status remains PARTIAL.

## Composition Follow-Up: Activation-Specific Retirement

September 27, 2026 local follow-up: a shared route/deployment composition factory
now wires storage, configuration, migrations, allocations, runtime files,
systemd, readiness and gateway instances together. It still requires an explicit
application compatibility verifier. Tenant service health and a database
connection are availability checks, not schema, role, identity or queue
compatibility proof. Operator-provisioning declarations are left to that
verifier rather than rejected by the platform preflight. Default Management API
activation writes remain unmounted.

Retirement observes stopped processes and checks both live and durable Caddy
routes for the retired activation's child route IDs and allocated ports. It does
not delete the environment's route ID, which may already belong to the next
activation. Tests cover preserving the new route, stale durable routes, aliased
old-port upstreams and malformed readback. This is local adapter evidence, not
full-platform retirement or recovery acceptance.

## Platform Follow-Up: Standalone Tenant Bootstrap

September 27, 2026. Parent: composition follow-up. Source: continued delivery
implementation. Scope: unblock actual tenant provisioning in the existing local
Linux acceptance VM; no production deployment or SupaCloud publication.

The Linux run exposed three concrete prerequisites/failures:

- The compiled Management API could not locate `supabase.sql` outside a source
  checkout. It now embeds the canonical SQL while retaining file overrides.
- An existing database previously counted as successfully provisioned even
  after its first schema application failed. New initialization now commits
  schema, ownership, grants and a final bootstrap receipt in one transaction.
  Retry initializes an empty database; legacy databases are checked for core
  objects and ownership/grants rather than destructively replayed.
- The provisioning payload contained `domain: undefined`, rejected by strict
  task JSON validation before insertion. Absent optional domains are now omitted.

Verification:

- 21 database/bootstrap tests passed, including executing a native compiled
  binary from an empty working directory and comparing the embedded SQL digest.
- 42 project service tests passed in isolation; Management API typecheck and
  diff whitespace checks passed. These host checks used Bun 1.4.0.
- A detached Linux binary compiled with Bun 1.4.2 passed against the explicit
  local PostgreSQL 18 test cluster: schema-call failure rollback, failure in a
  later ownership call rollback, successful retry, repeated provisioning
  preserving business rows, and legacy ownership validation. Its fixture is
  `packages/management-api/tests/fixtures/database-bootstrap-process.ts`; it
  requires `SUPACLOUD_BOOTSTRAP_TEST=1` and cleans up only its random test
  database/roles. Canonical schema SHA-256:
  `fd4f769f676c0fffeb257bfc5bdea76fa6fe0e76825fff9a2f488d0f90fed55d`.

The VM had a stock Caddy executable without `http.handlers.rate_limit`.
Replacing that test-only executable with the existing self-host test
container's module-enabled binary unblocked tenant gateway configuration.
Project `ugckmpkijwfbibxtaemr` subsequently completed provision_db, provision_s3,
provision_runtime, provision_router, provision_gateway and provision_secrets.
PostgREST on 3182 and GoTrue on 3282 returned HTTP 200. Direct GoTrue signup,
password-token exchange, user lookup and a request to PostgREST carrying the
GoTrue access token also returned HTTP 200; no tokens were included in output.

This is not full-platform acceptance. Realtime provisioning still failed, and
Realtime/Storage service readback remains unhealthy. The direct Auth probes
do not prove gateway SDK flows, object-level RLS, Storage, queue, SupAuth live
integration, application activation/rollback or production data recovery.
Default application activation writes remain unmounted. Overall status PARTIAL.

### Platform Follow-Up: Gateway Auth and Storage

On 2026-09-27, further test-VM verification corrected the preceding Storage
readback limitation. Both project and tenant runtime status now delegate to
`StorageService.getStatus()`, which uses the configured filesystem root or
object backend. Neither a running storage systemd unit nor an HTTP error from
the object backend overrides a failed backend probe.

Evidence:

- 47 project service tests and 6 storage status tests passed in separate host
  Bun 1.4.0 processes, including active systemd with unhealthy backend.
- Management API typecheck and `git diff --check` passed.
- The dedicated VM Management API was rebuilt and installed from the current
  source bundle using Linux Bun 1.4.2. Installed executable SHA-256:
  `808c47ec7d268503764b7232cf6fb94edfd446294d3e70d0329910f51356aeec`.
  This includes the final database bootstrap ownership checks and storage
  health fixes. Host bundling used Bun 1.4.0.
- The actual `/health` service list and `/status` endpoint now report Storage
  healthy; Realtime remains unhealthy.
- `packages/management-api/tests/fixtures/platform-gateway-smoke.ts` ran
  through the VM Caddy gateway with the official `supabase-js` client:
  signup, password login, user readback, session refresh, signout, private
  bucket creation, upload/download content equality, and denial of private
  object download by an unprivileged authenticated user passed. The same
  fixture then used two authenticated users to verify owner-only object
  read/write/delete, cross-user denial, PostgREST `storage.objects` RLS
  filtering, and permission preservation after token refresh. Test users,
  objects and buckets were cleaned up; a direct database readback confirmed
  zero remaining `gateway-*` users, buckets and objects. Final fixture output:
  `{"gatewayAuth":true,"gatewayStorageRoundtrip":true,"privateObjectDenied":true,"storageOwnerIsolation":true,"postgrestOwnerRls":true,"refreshedSessionRls":true,"ownerMutation":true,"cleanup":true}`.

The fixture requires `SUPACLOUD_GATEWAY_TEST=1`, an explicit
`SUPACLOUD_TEST_PROJECT_REF`, and a project name prefixed
`platform-app-acceptance-`. Credentials stay in the test environment and are
not printed. Its transport targets only the VM loopback Caddy, supplies the
tenant Host header and accepts the test certificate. This does not prove
public DNS or production TLS. Bucket provisioning and cleanup use the service
role; the owner-isolation checks use real GoTrue user sessions and the shipped
Storage policies without test-specific grants. Application object-level
authorization and SupAuth RBAC remain separate acceptance requirements.

These results do not prove live SupAuth integration, Realtime, queue,
service-origin, the full role/RLS matrix, application activation/rollback,
migration compatibility or independent platform data restoration. Activation
writes remain unmounted and overall delivery remains PARTIAL.

### Platform Follow-Up: Live Queue Transport

On 2026-09-27, `tests/fixtures/platform-queue-smoke.ts` passed against the
same dedicated VM and tenant using real PGMQ, PostgREST and Management API.
The fixture creates a random queue through the Management API, sends through
official `supabase-js` `pgmq_public` RPC over Caddy, adds a batch through
Management API, then reads all three messages and proves they are hidden
during the visibility lease. SDK archive calls and Management API archive
readback agree on the exact message IDs. Subsequent receive is empty.

The queue is removed and `pgmq.list_queues()` confirms it is absent. This
database check uses explicit connection options and asserts
`current_database()` equals the selected tenant's `db_name`; an earlier
ad-hoc URL-string probe unexpectedly connected to the metadata database.
The previous gateway user/bucket/object cleanup was also rechecked against
the explicitly identified tenant database, with all three counts zero.

Final queue fixture output:
`{"queueCreated":true,"queueListed":true,"sdkGatewaySend":true,"messagesSent":true,"statsRead":true,"messagesReceived":true,"visibilityLease":true,"messagesAcknowledged":true,"archiveReadback":true,"emptyReadConfirmed":true,"cleanup":true}`.

Fixture build, Management API typecheck and whitespace checks passed.
The fixture requires `SUPACLOUD_QUEUE_TEST=1`, an explicit project ref, and
the dedicated acceptance project name prefix. Credentials are read only from
the local test environment. Queue administration uses the Management token;
SDK RPC uses the tenant service role. This proves queue transport and lease/
archive behavior, not application Worker execution, business-side effects,
cross-role queue ownership, live SupAuth, or the still-pending full delivery
lifecycle. No production deployment was performed. Overall status PARTIAL.

### Platform Follow-Up: Systemd HTTP and Worker Runtime

On 2026-09-27 the existing detached Linux acceptance archive passed the real
systemd/journald/Caddy runner on the dedicated test VM:

- Release: `b4834cd4be03734937ef9a0725b10130b9bd0b9c534cd12610090f0f86c649c8`.
- Activation: `314e5300-1386-464e-a9c7-2e111be737b9`.
- Receipt: `/var/lib/supacloud-delivery-acceptance/run-Ybues5/receipt.json`.
- Both targets ran as the exact non-root tenant identity. HTTP passed through
  Caddy; reconstructing the provider preserved route readback.
- Target restart changed both invocation identities. Injected HTTP not-ready
  state was detected while Worker readiness remained healthy.
- Targets stopped with PID zero; generated units were removed. Existing
  Management/Caddy services were restored, with GoTrue, PostgREST and Storage
  healthy afterward. Realtime remained unhealthy.

The first relocated-build attempt failed because its TypeScript standard
libraries and Bun types were absent. The final run rebuilt the compiler and
acceptance archive in the complete workspace with `npm exec --package=bun@1.4.2`
and transferred only the metadata-clean bundle (`COPYFILE_DISABLE=1`,
`tar --no-xattrs`). The passing result therefore binds to the current source
and current compiler output. The earlier archive transfer also introduced
AppleDouble metadata; removing those transport-generated `._*` files restored
the original inventory without weakening archive verification.

This is runtime integration evidence, not full activation API acceptance.
The fixture Worker has lifecycle behavior but no business job execution.
Application journal composition, live business Worker, old/new compatibility,
application rollback and independent restoration remain incomplete.

### Platform Follow-Up: OIDC Sessions and Partial Apply Recovery

On 2026-09-27 the dedicated acceptance tenant was configured with the existing
OIDC migration API. The first request persisted signing configuration but
returned 503 because the Realtime verifier refresh failed. A second identical
request incorrectly returned 200: the persisted configuration no longer
differed, so downstream verifier refresh was skipped.

OAuth ES256 migration and KMS signing configuration now explicitly request
verifier reconciliation even for unchanged configuration. Local PostgREST,
Realtime and SupAuth owner dependents must finish before success. Ordinary
session-only updates retain the existing no-verifier-refresh behavior.
Regression tests cover repeated local Realtime failure and owner-dependent
failure, followed by recovery with unchanged signing configuration.

The gateway fixture now has separate opt-ins:
`SUPACLOUD_OIDC_TEST=1` verifies configured discovery/JWKS and real signed
sessions; `SUPACLOUD_OIDC_MIGRATE=1` additionally requests migration exactly
once. It never automatically retries a failed migration. Management credentials
are required only for the latter operation.

The fixture passed on the test VM through Caddy with public-only JWKS,
ES256/RS256 signature verification, exact issuer/audience/subject checks,
official SDK `getClaims`, signed refresh sessions, and the existing
two-user Storage/PostgREST RLS checks and cleanup. This proves the configured
GoTrue Auth/REST/Storage path, not full migration success: Realtime is still
unavailable. The earlier 200 retry is not accepted as full-platform evidence.
The runtime recovery fix is locally tested, not installed in the VM binary.
The focused OAuth/config boundary suite passed 76 tests and 628 assertions;
Management API typecheck and diff checks passed. The final gateway fixture
also passed with `MASTER_TOKEN` removed and migration disabled.

No SupAuth RBAC, OAuth authorization-code/PKCE, ID-token, shared-tenant live
acceptance, or full application activation/rollback proof is claimed.
Default application activation remains unmounted. Overall status PARTIAL.

### Platform Follow-Up: Live Partial OIDC Recovery

On 2026-09-27 the current Management API source was cross-compiled with Bun
1.4.2 for Linux ARM64 and installed only on
`supacloud-delivery-acceptance-0926`. The previous binary was retained on the
test VM. Installed executable SHA-256:
`e6d87502816c1e84457ee9ba041508ca63bb396e11c4b61e95890585c49e6553`.
This supersedes the preceding note that the verifier recovery fix was not
installed in the VM.

The explicit `SUPACLOUD_OIDC_RECOVERY_TEST=1` fixture
`tests/fixtures/platform-oidc-recovery-smoke.ts` uses the actual Management API
and already configured acceptance tenant. With Realtime still unavailable,
two requests with unchanged signing configuration both return 503,
`AUTH_RUNTIME_APPLY_FAILED`, `persisted=true`, and `runtime_applied=false`.
Readback proves the key ID, public signing material and issuer are unchanged.
It does not inject an outage, rotate signing keys or claim recovery succeeded.

Afterward the existing OIDC gateway fixture again passed signed login/refresh,
SDK claims verification, private Storage operations, cross-user denial and
PostgREST RLS, with temporary users/buckets/objects cleaned up. Management,
Caddy, GoTrue and PostgREST systemd units remained active. Fixture compilation,
focused fixture typechecking and diff checks passed.

This is actual partial-failure/retry evidence, not Realtime restoration,
SupAuth RBAC acceptance, default application activation or production
deployment. The full delivery goal remains PARTIAL.

### Platform Follow-Up: Live OAuth PKCE and Application Identity

On 2026-09-27 the current gateway fixture was rebuilt and passed on the
dedicated acceptance VM with `SUPACLOUD_GATEWAY_TEST=1`,
`SUPACLOUD_OIDC_TEST=1` and `SUPACLOUD_OAUTH_PKCE_TEST=1`.
The fixture creates a temporary public OAuth client through Management API,
requests S256 authorization through Caddy, and uses the official Supabase SDK
for authorization details and consent. The callback URL is inspected locally,
not contacted.

The actual GoTrue token exchange passed. Independent authorization codes
with a wrong verifier and with no verifier both returned 400 `invalid_grant`.
The fixture supports both first-time consent and the SDK's already-approved
`redirect_url` response. Public JWKS verified the ID token's
signature, issuer, client audience, subject and nonce. The current-source
`createSupAuthRequestContext` accepted the access token for the expected client
and rejected a different client. Reusing the authorization code returned 400.
Cleanup deleted the OAuth client and required a subsequent Management API GET
to return 404. The same run also passed signed session refresh, private Storage
roundtrip, cross-user denial, PostgREST RLS and temporary-resource cleanup.

Both OAuth/gateway fixtures passed focused TypeScript checking and the gateway
fixture bundled successfully. Missing local declaration artifacts were built
for contracts/app and synchronized into the existing Bun file-dependency
copies; no framework source was changed to suppress type errors.

This supersedes the earlier absence of PKCE/ID-token evidence, but does not
prove browser consent UI, deployed SupAuth management
Functions/RBAC, real membership resolution or shared-owner tenant behavior.
The application identity probe uses a test access resolver.

An initial negative-case run failed because the fixture assumed repeated
authorization always needed consent. Cleanup then attempted operations for a
bucket and second user whose creation had never started, masking that error.
The created OAuth client and first user had successful deletion and 404
readbacks. Cleanup now tracks attempted creation (set before dispatch, so lost
responses still trigger cleanup). The subsequent complete live run passed all
17 boolean evidence fields, including wrong/missing verifier and cleanup.
Management API typecheck and focused fixture typecheck passed.

The failed early cleanup also observed gateway Auth admin user-list rejection
of the legacy HS256 service token. That unknown-signup-response recovery path
still requires compatibility work; a successful normal cleanup must not be
treated as proof of that branch. OAuth client recovery uses Management API's
current unpaginated normalized list, not SDK pagination metadata.

Realtime remains incomplete. Dedicated-VM Podman installation succeeded and
an isolated VFS store was verified, but pinned Realtime and Elixir builder
image pulls stalled and were explicitly terminated. No Realtime runtime or
slot-isolation artifact was installed. Default activation, full-platform
business Worker execution, migration compatibility, business rollback and
application data recovery remain open. Overall status remains PARTIAL.

### SupAuth Compatibility Boundary

SupAuth PR #124 (`codex/gotrue-supabase-compat`, commit
`0b321cb09846246e51246927d85dffb78547fdb2`) was submitted and its available
checks passed. The proposed contract keeps GoTrue authoritative for
`auth.users`, sessions, token signing, discovery and JWKS. SupAuth remains the
management/RBAC overlay and is not introduced as a second issuer. This is the
required compatibility direction for Supabase Auth clients and downstream
PostgREST, Storage, Realtime and Functions consumers.

The PR is open and not merged. Its checks do not constitute SupaCloud
full-platform acceptance: live SupAuth membership/RBAC, service-origin and
shared-tenant authorization still require a real platform test.

### Platform Follow-Up: Legacy Auth Admin Credentials After OIDC

The failed early-cleanup user-list request exposed a gateway compatibility gap:
legacy service-role JWTs reached GoTrue directly, while opaque keys and user
deletion already used the Management API SDK proxy. After ES256 migration,
GoTrue correctly rejected the directly forwarded HS256 credential.

Local/shared Auth admin paths now use that existing proxy, which resolves
same-project API credentials and signs an upstream OIDC service-role token.
Normal Auth traffic stays on its previous route. External IdP admin routes
are not redirected by the new route, and local-to-external reconfiguration
removes it. Existing user-deletion orchestration remains in place. Incremental
API-domain addition includes the new route; a read-only review identified that
missing domain case and it was fixed with a regression assertion.

The gateway/proxy suites passed 125 tests and 839 assertions. Management API
typecheck, focused fixture typecheck and compilation passed. The final current
source binary was installed only on `supacloud-delivery-acceptance-0926`, with
the previous executable retained. SHA-256:
`804e8dea8583f52cb5fca98004b7f9863ede1e356fc35e84e8e284da0840885e`.

The rebuilt official-SDK gateway fixture passed all 18 evidence flags through
real Caddy and GoTrue, now including `gatewayAuthAdminList`, using the stored
legacy service-role key after OIDC migration. PKCE positive/negative checks,
signed sessions, Storage/RLS and cleanup also passed. This resolves the
observed user-list rejection; it does not prove injected lost-signup-response
recovery, every Auth admin operation, KMS-backed service-role translation or
live custom-domain/shared-tenant acceptance.

### Realtime CDC acceptance

On September 27, 2026, the dedicated acceptance PostgreSQL 18.6 cluster was
updated to allow `pgoutput`, `test_decoding`, and `wal2json` as logical decoding
output plugins. Existing tenant initialization and migration paths now grant
`supabase_admin` database `CREATE`, `public` schema `USAGE`, and explicit
`SET` membership for the JWT roles `anon`, `authenticated`, and `service_role`.
The runtime role remains non-superuser, non-createdb, and non-createrole.

The rebuilt gateway fixture then passed the real CDC path for tenant
`ugckmpkijwfbibxtaemr`: it created a temporary RLS-protected table, subscribed
through the OIDC-authenticated Realtime WebSocket, inserted a marker after the
`postgres_changes` subscription acknowledgment, received the matching
`INSERT`, and observed an active tenant `wal2json` logical slot. The same run
also passed OIDC discovery/session/refresh, invalid-signature rejection, Auth
admin listing, OAuth PKCE, SupAuth application identity, Storage/RLS, and
cleanup; every emitted evidence flag was `true`.

The final fixture rerun also passed all 23 flags after adding heartbeat,
waiting for the tenant-named wal2json slot before insertion, cancellation and
insertion drain, and table-cleanup readback before printing success. A separate
catalog query confirmed zero remaining `realtime_acceptance_*` relations.
The CDC poller removes its slot after the temporary publication table is
dropped; a later catalog query must not be interpreted as failed delivery.

Local verification passed 71 PostgreSQL image/schema/database-service tests
(537 assertions), seven WebSocket fixture tests (16 assertions), and one
native PostgreSQL privilege/RLS test (three assertions). The latter creates a
publication under `SET SESSION AUTHORIZATION supabase_admin` and evaluates
the owner's rows after switching to `authenticated`. Management API typecheck,
focused fixture/test typecheck, bundle compilation, SQL synchronization and
diff checks passed. Independent read-only review found no remaining confirmed
issue in this scope.

The CDC table and its publication membership are explicit fixture setup, not
proof of automatic application publication provisioning. This closes the
previously unproven Realtime CDC transport path for the
owned acceptance environment, but does not prove multi-tenant slot isolation,
production image rollout, default Management API activation, application
rollback, or independent application-data recovery. Overall delivery remains
PARTIAL.

Default application activation, Realtime and the remaining full-platform
business delivery/recovery requirements remain incomplete. No production
deployment or SupaCloud commit/push was performed. Overall status PARTIAL.

Realtime preparation was rechecked afterward: the pinned runtime image had
become available in the host Docker store. It was exported and loaded into
the dedicated VM's isolated Podman VFS store, reporting the expected ARM64
config digest
`sha256:1ee6d7247f3f3809289524539cd06f6f86d4c50e5639d1ef28f388a9e4fefaa4`.
This is image-transfer evidence only; the pinned Elixir builder remains absent,
and slot-isolation build, runtime installation and service acceptance are
still pending.

### Platform Follow-Up: Realtime Slot-Isolation Artifact Built

On 2026-09-27 the pinned Elixir builder image pull completed. Both runtime and
builder images were imported and then pulled by their original registry
digests into the dedicated VM's isolated Podman VFS store. The repository's
unchanged builder verified source commit
`139f4f2c5d1ae28a7892c03d462d16dc9efe89a9`, original/patched source hashes,
runtime and builder identities, and the tenant slot-name isolation checks.

The resulting ARM64 artifact at `/opt/supacloud/realtime-slot-isolation`
passed a separate verifier invocation with expected UID 0. BEAM SHA-256:
`b80543d36094faf2a8593ac1b9b890b9b870530c30bf7816c24beb480f9a0ce5`.

The host Docker attempt had failed because its image inspect ID represented
the OCI index rather than the expected image config. No trust check was
removed. Building under VM Podman retained the expected image identity.
This nested test VM additionally needed a test-only runtime wrapper with VFS,
privileged container execution and the VM's existing `/dev` bind-mounted to
avoid denied device creation. These settings are not production defaults.

Realtime has not yet been installed or started. The next installation must
account for this acceptance environment's database endpoint
`host.lima.internal:55432`, rather than the installer's default port 5432,
and its differently named Management API unit. No credentials were logged.
Artifact construction does not prove service readiness, tenant registration,
OIDC consumer reconciliation, WebSocket delivery or full-platform acceptance.
Overall delivery remains PARTIAL.

### Platform Follow-Up: Realtime Metadata Bootstrap And Live Readiness

Parent: Realtime Slot-Isolation Artifact Built. Source: continued implementation
on 2026-09-27. Scope: fix the installer bootstrap prerequisite and exercise the
existing transactional installer on the same owned OrbStack acceptance VM.
Native orchestration: one writer and one independent read-only verifier.
Existing Bash/systemd/PostgreSQL deployment choices are unchanged.

The previous container failed its Ecto migration because the selected `postgres`
database had no `_realtime` schema. The installer contained a legacy schema
creation function, but did not invoke it in the Realtime transaction. A first
live bootstrap attempt also confirmed that the runtime `supabase_admin` login
cannot create schemas in this database.

The transaction now bootstraps the exact candidate container database after
artifact validation and before replacing live service files. It uses the
installer's existing `postgres` credentials to create `_realtime` owned by the
candidate runtime login, then connects as that runtime login to verify USAGE
and CREATE. Existing schema ownership and permissions are not changed.
The schema is additive and is deliberately retained on later service rollback;
this does not add a database migration rollback claim.

The verifier identified two connection-boundary defects in the initial patch:
inherited `PGHOSTADDR` could override the selected host, and systemd env parsing
could alter a literal container password. The final patch clears the inherited
connection selectors and uses a separate raw-container-env parser that preserves
spaces, quotes, equals signs and backslashes.

Local evidence:

- Realtime installer transaction: 12 tests, 182 assertions passed.
- Installer configuration and Realtime systemd: 68 tests, 544 assertions passed.
- Additional raw-container-env cases: four tests, eight assertions passed.
- A disposable native PostgreSQL 18 cluster: one test, four assertions plus SQL
  invariants passed. It exercised actual password authentication, a runtime
  without database CREATE permission, schema ownership, search-path migration
  table creation, distinct administrator/runtime credentials, repeat bootstrap,
  existing data preservation, and rejection of a runtime login without schema
  access.
- Bash syntax and scoped diff checks passed. The whole-worktree diff check
  still reports pre-existing whitespace in project-config/storage routes;
  those unrelated edits were left untouched.
- A fresh Management API `bun run typecheck` failed in `src/routes/monitor.ts`
  and `src/routes/ws.ts` (handler return types and missing WebSocket `data`).
  Those files were not edited by this follow-up. Earlier recorded typecheck
  success is not evidence that the current complete worktree passes.

Live evidence from `supacloud-delivery-acceptance-0926`:

- The current installer completed artifact build/verification, schema bootstrap,
  systemd activation and its authenticated `/healthcheck` gate.
- An independent health recheck passed. PostgreSQL reports `_realtime` owned
  by `supabase_admin` and 33 applied metadata migrations.
- Systemd is `active/running`; the isolated Podman container remained up across
  subsequent observations. Its restart counter remained 17, including earlier
  failed attempts; no claim of a fresh zero-restart history is made.
- Installer SHA-256:
  `67b8ff7ce715522398ee215727b46699840f52d0d9871449ecc5d3e95ef253f3`.
  Install-config helper SHA-256:
  `7916d62e62d2dc105cf0c8defe22a9ae35ec79486e7077cbed04d986421aed6f`.
- The VM-specific database port, service name and Podman wrapper remain
  acceptance-only adaptations, not production defaults.

The metadata tenant count is still zero. Tenant registration/readback, live
WebSocket delivery, OIDC token consumption and runtime slot isolation remain
unproven. Default application activation, HTTP/Worker business acceptance,
migration compatibility, application rollback, the remaining SupAuth access
matrix and independent application-data recovery also remain open. No SupaCloud
commit/push, release or production deployment occurred. Overall status PARTIAL.

### Realtime Tenant Migration Follow-Up

Continuation on 2026-09-27 resolved the remaining live tenant bootstrap
permission gap on the owned acceptance VM. The runtime login remains
`supabase_admin` without superuser, createdb, or createrole privileges. Its
membership in `supabase_realtime_admin` now explicitly preserves `ADMIN`,
`INHERIT`, and `SET` options. The shared Supabase bootstrap and installer
paths use the same membership contract, and create the restricted
`dashboard_user` compatibility role required by the official Realtime
migrations.

After deleting and freshly registering the acceptance tenant
`ugckmpkijwfbibxtaemr`, the official v2.133.0 migrator completed all 82
migrations, ending at `20260714120000`. The tenant apply/readback fixture
passed, including encrypted database configuration readback and persisted
OIDC JWKS verification material. The complete gateway fixture then passed:
OIDC discovery, signed session and refresh, Auth admin, OAuth PKCE and
single-use authorization code, SupAuth application identity, Storage
roundtrip and owner isolation, PostgREST RLS and refreshed-session mutation,
Realtime OIDC WebSocket join/self-broadcast, and tampered-signature rejection.
The first gateway rerun returned discovery HTTP 404 with inherited proxy
environment variables; the successful rerun explicitly removed proxy variables
and set `NO_PROXY=*` for this loopback-only fixture.

Local verification: 13 installer/native PostgreSQL tests passed with 190
assertions; 55 schema/Realtime service tests passed with 483 assertions.
SQL module synchronization, installer syntax, and scoped diff checks passed.

This proves the existing acceptance tenant's sequential migration completion
and the listed gateway/OIDC/Storage/RLS cases. A separate fresh database
migration path is not yet proven. No replication slot existed at the catalog
observation before the gateway rerun; the WebSocket fixture does not request
Postgres Changes, so CDC delivery and runtime slot isolation remain unproven.
It also does not prove production deployment,
application activation, queue/service-origin ownership outside this fixture,
application rollback, or independent application-data recovery. Overall
delivery remains PARTIAL.

### Application Recovery HTTP Follow-Up (2026-09-27)

Continuation of the application delivery goal, Native single-writer scope:
correct unavailable activation endpoint feedback and exercise composed HTTP
recovery after a lost mutation receipt. No default activation mounting change.

The application router now preserves framework route-not-found errors as HTTP
404. Previously, absent activation/reconcile/retirement routes became HTTP 500,
which the CLI classified as an unknown mutation outcome. API regression tests
now require 404 without deployment effects; CLI tests require one request and
`HTTP_ERROR`, not `OUTCOME_UNKNOWN`, for these unavailable controls.

A composed Elysia request test now injects failure when recording the activation
success receipt after startup, traffic switching and authority persistence.
After service reconstruction, reconciliation confirms the existing activation
and repeated reconciliation remains successful without runtime or route replay.
This uses file-backed authority, an in-memory journal and runtime adapters;
it is not PostgreSQL restart, real process restart or full-platform acceptance.

Verification: 25 API/deployment tests (194 assertions), 32 CLI/schema/policy
tests (253 assertions), Management API and CLI typechecks, application-release
test typecheck and worktree diff checks passed. Read-only inspection also found
the dedicated acceptance VM's Management API, Caddy, tenant GoTrue, tenant
PostgREST and Realtime units active/running; no business acceptance is inferred.
Default compatibility composition, full-platform application execution,
rollback and independent application-data recovery remain open. Status PARTIAL.

### Platform Follow-Up: Workflow RPC Ownership Repair (2026-09-27)

The narrow acceptance repair executed the actual
`renderPlatformRpcOwnershipSql` inside a transaction, with metadata guards
restricting the target to the dedicated acceptance tenant. This resolved that
tenant's previously observed Workflow SDK `start` failure with `42501`.
Native PostgreSQL ownership regression passed with 81 assertions. It covers
all 14 exact public wrappers, failed service-role calls before repair,
schema-owner restoration, repeated repair and project-role preparation,
private routine denial, and transfer of an ordinary text overload to the
project owner. Related ownership/schema/migration suites passed 80 tests
(583 assertions); Management API typecheck and fixture strict typecheck/build
also passed. The native fixture uses probe bodies, not the business workflow.

An executor capacity failure interrupted the native-test handoff; the main
owner completed the existing file and verification without changing runtime.
The attempted full starter regression with PostgreSQL 18.4 stopped at
`bun install` dependency resolution after the child-process 120-second timeout
(exit 143, total 154.99 seconds). It did not reach business/native fixtures.
The test executor confirmed no owned child processes or temporary starter
directory remained. This attempt is not a passing starter regression.

The live Workflow fixture passed all nine boolean evidence fields:

- `startAndIdempotentReplay`
- `nativeQueueClaimAndLease`
- `expiredLeaseRedelivery`
- `staleAttemptRejected`
- `retryAndRedelivery`
- `idempotentSettlement`
- `completedAndDurableReadback`
- `queueDrained`
- `cleanup`

The stale-attempt raw response was HTTP 500 with code `40001` and message
`SUPACLOUD_WORKFLOW_STALE_ATTEMPT`. The SDK conservatively reported an unknown
outcome; subsequent unchanged readback confirmed that the stale completion had
not changed workflow state. This is not a claim that the SDK classified the
response as a definitive mutation rejection.

This evidence proves the narrow Workflow RPC/queue lifecycle on the dedicated
acceptance tenant, not the complete upload/approval/async-worker business
workflow. It does not establish general repair rollout, restricted business
Worker permissions, live SupAuth membership/RBAC, service-origin authorization,
default application activation, full-platform old/new compatibility,
application rollback, or independent application-data recovery.
The other acceptance criteria and overall delivery status remain PARTIAL.

### Platform Follow-Up: Shipped Business Upgrade And Rollback (2026-09-27)

The shipped review starter was compiled into detached HTTP/Worker archives
using rebuilt workspace packages, not substituted business handlers. Initial
Linux attempts exposed three distinct integration defects:

- An eager `libpg-query` import in the bundled database command entry attempted
  to load WASM from the macOS build path. SQL parsing is now loaded only when
  requested; a two-stage detached-bundle regression verifies that command
  transactions do not initialize an unavailable parser.
- Bun's URL-based database initialization used ambient management database
  settings in this environment. Starter HTTP, Worker and upgrade checks now
  supply explicit connection fields while retaining the URL for TLS options.
  Native regression confirms tenant database selection and preservation of
  `sslmode=require`.
- Bucket creation passed MIME arrays as scalar SQL parameters. Both logical
  bucket create paths now use Bun's typed PostgreSQL array parameter. Native
  regression covers null, empty, single/multiple MIME values, updates and
  duplicate creation.

The launcher also provisions physical Storage through its real API rather than
assuming an SQL bucket row creates the namespace. Its temporary runtime logins
receive tenant database CONNECT and lose it during cleanup; SET ROLE alone had
not tested the actual connection boundary.

Dedicated VM `supacloud-delivery-acceptance-0926` runs the rebuilt Management
API binary with SHA-256
`0258ab2f0c423d7ededec45d6856aa82494e741a2de172ae0a4cdf714b2475fc`.
The installed file and running executable matched; the health endpoint returned
200. This is a test VM update, not a production deployment or release.

The complete live receipt is retained on that VM at
`/var/lib/supacloud-delivery-acceptance/business-run-gqhldU/receipt.json`.
It reports PASS with no cleanup errors for:

- Original v1: actual systemd API/Worker identity readiness, GoTrue OAuth PKCE
  users, anonymous/foreign-owner denial, private upload/readback, ownership
  fences, immutable artifact registration, approval replay, stale-version
  rejection, real Worker completion, single durable receipts/audit, queue drain.
- v2 before migration: both target processes emitted the specific missing-schema
  rejection, correlated to their exact systemd invocation IDs. Generic startup
  failure was not accepted as compatibility evidence.
- v2 after the explicit additive migration: the same business checks passed.
- Application rollback to v1 on the expanded schema: the same checks passed.
  All three exact review/artifact/result records remained intact and their
  writer revisions were `v1`, `v2`, `v1`. No schema downgrade or data deletion
  was represented as application rollback.

Original release:
`13a927748638525bd90815fde37f492edbb57133f82b449f578c9dae71ffe352`.
Upgraded release:
`59401a8bab21c1cafd930cb942d7500fe0ebeea518ab370f4ba9b11789a3df97`.
The launcher removed its systemd units and OAuth client, disabled its temporary
SQL logins and revoked CONNECT. Business data, physical objects and immutable
release evidence remain for an independent restore exercise.

This run uses direct production systemd/runtime components, not the default
Management API activation endpoint or application gateway. Its explicit
migration execution is not proof of the Management API migration ledger.
SupAuth facade/RBAC, default activation/gateway and independent application-data
restoration remain separate acceptance items. The clean full starter regression
was still pending at this live run and subsequently passed as recorded below.
Overall status remains PARTIAL; no SupaCloud commit, push or publication.

The next default-activation attempt created a separate project through the real
Management API so that its migration ledger can be populated by actual migration
execution rather than inventing history for the preceding manually provisioned
schema. Project `ttzatqixbiaxhyratbvh`
(`platform-app-acceptance-default-20260927`) stopped at `provision_db`: the
dedicated VM had approximately 3.2 GB available, below the configured 10 GB
minimum. Its three bounded attempts failed and compensation left it paused.
No application database/migration/activation success is inferred for that
project; the resource threshold was not reduced. Existing successful business
evidence and data were preserved. Readback confirmed zero enabled temporary
`business_*` SQL logins.

Current Management API and database-package typechecks pass. The previously
reported `SQL.listen` TS2339 does not reproduce with the installed Bun 1.4.2
types; this is not a claim about older dependency installations.

The complete local starter regression subsequently passed (188.74 seconds,
exit 0) after updating the wrong-tenant fixture to require the exact new
structured diagnostic and fixed startup-failure line. It covered all eight
package frozen installs/builds/packs, offline consumer install, generated
checks/typechecks/tests/builds, PGlite and native PostgreSQL/Lite persistence,
both startup diagnostic variants, identity/tenant rejection, attachment upload,
external Worker, upgrade/rollback, and command/HTTP/edge templates. Owned child
processes and temporary PostgreSQL/smoke directories were cleaned. This closes
the earlier installation/diagnostic regression gap, not default-platform
activation, deployed SupAuth, or complete platform recovery acceptance.

### Platform Follow-Up: Independent Business Record Recovery (2026-09-27)

The three successful real-platform business chains were exported from a
read-only repeatable-read snapshot, including selected rows from 15 tables:
reviews, attachments/results, immutable registry, Storage metadata, command
receipts/audit, Workflow lifecycle and queue archive. The actual private objects
were downloaded and matched against their recorded lengths and SHA-256.
Restoration then used backup files, not a second read from the live source.

Receipt:
`/var/lib/supacloud-delivery-acceptance/business-recovery-jdteV9/receipt.json`.
Scoped backup size was 71,089 bytes, including a 25,969-byte logical dump and
three objects totaling 168 bytes. A separate target database, reopened before
readback, reproduced all selected records and hashes. Restored object bytes
matched the recovered registry. Both newly created databases were removed;
source selected-record hashes remained unchanged. Six focused tests passed
with 42 assertions, and the fixture typecheck passed.

This is independent recovery of actual business records and object bytes,
not a complete application/platform recovery. The pre-data-only schema export
does not reconstruct source RLS, roles, functions, triggers, foreign keys or
indexes; objects are restored to a private directory, not a serving Storage
route. The receipt explicitly excludes these surfaces and service
reconstruction. Full recovery acceptance remains PARTIAL.

### Platform Follow-Up: SupAuth/Supabase Auth Compatibility (2026-09-27)

The live acceptance kept GoTrue as the issuer and SupAuth as the management/RBAC
overlay. Its 16 official SupAuth overlay migrations were executed through the
real Management API, with SQL, checksum and ledger readback verified. Legacy
webhook tables were confirmed empty or absent before the destructive no-op
migration step. A real SupAuth Function emulator started and authenticated its
development session.

RBAC stopped at a real compatibility mismatch: the emulator development
session uses the fixed virtual subject `admin`, while Management requires an
active project collaborator backed by a real GoTrue user. Delegated
organization read therefore returned `actor_not_project_collaborator` before
any organization, role, permission or membership mutation. The emulator,
session, lock and temporary resources were cleaned. This proves the boundary
and failure classification, not live SupAuth RBAC acceptance.

The remaining path is a real GoTrue-backed collaborator/SSO identity for the
emulator, or a focused SupAuth PR correcting development subject mapping. No
second issuer or parallel Auth implementation should be introduced.

### Platform Follow-Up: Datas Storage Migration

The operator authorized migration of the acceptance environment to Datas.
OrbStack storage is now configured at `/Volumes/Datas/OrbStackData`.
Changing that setting did not move the existing machines automatically:
the acceptance machine was exported and imported using OrbStack's commands.
The original storage was retained rather than deleted.

The database dependency was a Docker PostgreSQL volume exposed on port 55432,
not a native macOS PostgreSQL process. Its stopped data volume and original
image were exported and restored into the new Docker storage. The existing
active business project and paused default-activation project were read back.
Management API returned HTTP 200 from `/health`; Caddy, GoTrue, PostgREST and
Realtime were running after the database was restored.

The migrated machine reported about 535 GiB available. Its business receipt,
record-recovery receipt and Management API executable retained their original
SHA-256 values. The 10 GB provisioning threshold was not changed. Private
machine/database exports remain outside the repository on Datas.

This removes the disk-capacity blocker but does not prove default activation,
SupAuth SSO, or full application recovery. Those acceptance items remain
PARTIAL until their actual workflows pass. Other old Docker projects and
images were not migrated or deleted. Code integration is not production
deployment or production acceptance.

### Application Workflow Follow-Up (2026-09-28)

Parent: the delivery contract above. Source: user instruction to implement the
six-item application-delivery follow-up. Reason: expose the existing delivery
primitives as a usable workflow while closing compatibility and live evidence
gaps. This does not authorize production changes.

The CLI adds local `app plan` and `app build`, and delegates `app upload`,
`configure`, `deploy`, `status`, `rollback`, `reconcile` and `retire` to the
existing application API contracts. The executable is `supacloud-cli`; the bare
`supacloud` name remains reserved for the server. See the CLI README for exact
arguments.

Plan has no release digest: it describes topology before a build exists.
Upload establishes the server-scoped release identity, configure establishes
an immutable configuration revision, and activation establishes runtime
identity. These distinct receipts are preserved rather than manufacturing one
successful deployment receipt for every phase. Rollback requires a selected
old release and new activation identity; it never downgrades the schema.

Acceptance still to close:

1. A real collaborator/RBAC run on SupAuth's updated GoTrue version matrix.
2. Datas default Management API upload/migration-plan/activate/gateway/readiness/
   HTTP/Worker/reconcile/rollback chain.
3. The new CLI workflow against that same live target, beyond local contract
   and loopback transport tests.
4. Extend the read-only Application Dashboard beyond the implemented
   runtime/readiness and cursor-paginated stored-release view. ApplicationGraph,
   gateway observation, queue statistics and activation history still need
   their own data sources; stored releases are not proven rollback candidates.
5. PR environment provisioning, activation, smoke and cleanup. Existing Git
   auto-branching provisions database branches; it is not yet the full
   application preview lifecycle.
6. Independent full-platform restoration, including schema, roles/grants,
   functions/triggers, RLS, serving Storage objects, Realtime metadata,
   activation manifests and gateway configuration.

No full dashboard, preview lifecycle or full-platform recovery completion is
inferred from the workflow or compatibility changes.

The separate SupAuth worktree adds v2.197.0 as the current compatibility target,
retains v2.192.0 as the floor and v2.196.0 as a regression target, and shares
the exact version policy between session preparation and the OAuth fixture.
Both v2.196.0 and v2.197.0 retain `offline_access` assertions. Local tests
validate this policy; no live three-version compatibility run is claimed.

The Datas inspection located the original and upgraded immutable archives in
`/var/lib/supacloud-delivery-acceptance/business-C0DrqF/` and the protected
Management API environment at `/etc/supabase/management-api.env`. The running
services need no restart. Remaining test setup is project provisioning,
real migration-ledger population, distinct runtime role connections,
GoTrue-backed test identities, the compiled Linux verifier and a launcher
that calls `runPlatformBusinessManagement` with those private inputs.
No ready-to-run bundle or installed application verifier was found in the
inspected locations. These are unfinished setup/implementation tasks, not
evidence of a failed activation and not a reason to substitute the older
direct-systemd fixture.

The first read-only console page is available at
`/project/:ref/applications?application=:id&environment=:environment`.
It uses the existing runtime and release endpoints, keeps their failures
independent, clears stale observations on scope changes, handles cursor
pagination, and makes no writes. Empty active state is distinct from failed
observation. Browser checks with fixture responses cover desktop and 390px
mobile layouts, not live platform acceptance.

SupAuth PR #129 contains the version matrix update. Its first live CI run
observed v2.196.0 on the configured tenant and rejected the v2.197.0 default
before creating a compatibility session. CI/nightly now expose the same
explicit version selection for session preparation and verification; the
default remains v2.197.0. Do not weaken this check or count an older-version
regression run as v2.197.0 live acceptance.

### Default Management Activation Acceptance (2026-09-29)

Parent: the six-item application workflow follow-up above. Source: the user's
instruction to continue through completion. This remains a dedicated test-VM
exercise, not production deployment.

The default activation attempts installed runtime files and systemd units but
ended as terminal `prepared` failures. A read-only Bun 1.4.2/PostgreSQL probe
reproduced `ERR_POSTGRES_IDLE_TIMEOUT` after a 35-second wait inside a transaction
with `idleTimeout: 30`. The management SQL pool now disables client-side idle
eviction, preserving the row-lock/lease protocol during external host work.
Project pools retain their existing idle policy.

Verification: 28 focused activation/deployment tests (188 assertions), three
native PostgreSQL tests (50 assertions, including the 35-second protected
operation), Management API typecheck, ARM64 compilation and diff checks passed.
An independent read-only review found no blocking issue.

The compiled binary's local and installed SHA-256 matched:
`2cd48cbd2c1793cd33b8a2c493721b83eb16892931208074e478b924d95a9ce2`.
On the dedicated Datas VM, default API activation
`2bf9ee98-df12-4439-89e9-ee9da09c8e01` reused the already uploaded immutable
release and stored configuration. Previous attempts were confirmed terminal
and stopped before creating a new, privately journaled request identity.
Original GoTrue subjects obtained fresh OAuth tokens; runtime credentials and
immutable configuration were unchanged.

The default API passed compatibility verification, HTTP/Worker startup,
readiness, gateway runtime-identity readback and reconcile. The subsequent
gateway business workflow passed real GoTrue identity, authorization,
foreign-owner denial, private Storage upload/readback, immutable registration,
approval replay, external Worker completion, durable results and queue drain.
Receipts are retained under
`/var/lib/supacloud-delivery-acceptance/default-management-Kn0bQv/`:
`activation-after-idle-fix-result.json` and
`gateway-business-after-idle-fix.json`.

This proves default first activation and its business workflow, not default
API upgrade/rollback, external SupAuth collaborator/RBAC, live CLI acceptance,
dashboard expansion, PR preview lifecycle or full-platform restoration. The
business fixture explicitly reports that its identity scope is GoTrue plus the
starter SupAuth contract, not the external SupAuth provider. Overall acceptance
remains PARTIAL until the remaining independent proofs exist.

### Default Rollback And Live SupAuth Follow-Up (2026-09-29)

The CLI uploaded the v2 archive and the Management API executed its additive
version-5 migration, with migration-ledger readback verified. The v2 release is
`3fc16f3e4cbc90a48382ff675cbe752f5f13060277a93dc9bdec17c4050043eb`.
Its activation `7bb7f37e-6a19-4c83-aa6c-ec97f25a8fb2` and explicit v1 rollback
`88dcb3a9-88cb-4c84-8b8c-1dc3c54e5ff5` both reached `succeeded / committed` in
the real mutation journal. Initial CLI responses timed out and correctly
reported unknown outcome; they were not replayed. Later CLI reconcile of the
rollback returned a successful replay receipt. The rollback's gateway business
workflow passed on the expanded schema, with its receipt retained as
`gateway-business-after-rollback.json` beside the first-activation receipts.
This is application rollback, not data restoration. A complete live CLI
plan/build/configure workflow and v2 business run remain distinct checks.

The GoTrue health endpoint on the SupAuth acceptance tenant reported
`v2.197.0`. Live SupAuth testing found two real JSONB wire-shape defects:
organization branding and RBAC project config were encoded as JSON strings.
Writes now bind objects directly; the runtime-port config writer uses the
same fix. The dedicated acceptance project's double-encoded configuration was
privately backed up and normalized under a row lock without changing its
contents. No general production data rewrite was performed.

The installed Management API binary SHA-256 is
`9029e2cf5af548a10a2ed89d8c996e77f014e1b02d59ca7433f0ed000e241aa6`.
The live SupAuth Function emulator, built from source
`0b321cb09846246e51246927d85dffb78547fdb2`, then returned PASS for:

- Active collaborator provisioning, GoTrue SSO PKCE and signature verification.
- SupAuth admin identity and delegated management reads.
- Application identity, membership/RBAC grant and permission readback.
- Role revocation and membership revocation with denied application access.
- Wrong/missing PKCE verifier rejection, ID token validation and single-use code.
- Unchanged GoTrue issuer/JWKS authority and complete test-resource cleanup.

The acceptance mutation deadline is now 60 seconds; the previous 15-second
read-sized budget expired while revocation synchronized GoTrue projections.
Read requests retain their 15-second deadline. Focused tests passed:
18 organization tests, 2 native PostgreSQL JSONB/array tests, 33 RBAC/runtime
tests and 10 SupAuth fixture tests, plus Management API typecheck and ARM64
compilation.

This closes the v2.197.0 Function-emulator collaborator/RBAC proof. It does not
claim a deployed Functions/Pages release or a fresh three-version matrix run.
Dashboard expansion, PR preview lifecycle and independent full-platform
restoration remain unfinished; overall status remains PARTIAL.
