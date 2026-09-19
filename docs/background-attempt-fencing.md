# Background invocation ownership and durable output

This extends the existing background-function worker. It is not a second queue,
a new RPC protocol, a replacement for Supabase Realtime, or a new worker platform.
Ordinary functions and pgflow retain their existing invocation/action contracts.
See [task output events](./task-output-events.md) for the opt-in journal and SDK.

## Ownership and commit boundary

An execution is identified by `(project_ref, task_id, attempt)`. Attempts increase
on claim and do not reset on an explicit retry. `background-attempt-store.ts`
accepts only the corresponding `edge_function` task. Start is accepted only from
`leased`; renewal/settlement require an active, unexpired lease for that attempt.
No pid, client session, timestamp cursor, or in-memory task-ID set is an authority.

The store locks `project_tasks` first, then checks `clock_timestamp()` in a new
statement **after** acquiring the row lock. A pre-lock check or transaction-start
`now()` must not resurrect a lease that expired while waiting. Lock/statement
waits are bounded. Heartbeats never overlap and stop their request if ownership
cannot be verified, including database failure.

Settlement writes the task outcome, attempt history, and (when enabled) journal
lifecycle in one transaction. An attempt-history failure rolls back all three.
Concurrent settlements have at most one winner; rejected stale results do not
produce a success/failure notification. Notifications use the committed receipt,
not the desired outcome that was sent to the database.

The invocation catch does not wrap settlement. A lost database COMMIT response
must not be interpreted as a failed provider request and overwrite a possible
success with `retry_scheduled`. There are no automatic settlement write retries.
Inspect persisted task/attempt history through the existing operator surfaces.

This is **not exactly-once model execution**. A provider/tool may perform a side
effect even if its HTTP response is lost. Existing running-lease-expiry behavior
is retained: a running Edge invocation with unknown outcome goes to DLQ rather
than being automatically invoked again. Explicit retries start a new attempt;
external operations still require their own idempotency controls.

## Cancellation

Cancellation of an Edge task first persists the flag under the same task lock.
Queued tasks become cancelled atomically. Active tasks remain `running`/`leased`
with `cancel_requested_at` until settlement or expired-cancellation recovery.
A committed cancellation request wins over a later provider success/failure.

`cancel()` confirms **durable acceptance**, not physical provider termination.
The API continues to return the actual task record; it does not fake a cancelled
terminal state simply because an HTTP request was accepted. pgflow's unsupported
cancel/retry actions are unchanged.

A local execution is interrupted using its own request `AbortSignal`, keyed by
its attempt. A worker on another node sees the durable flag through its heartbeat
(default ten seconds; this is a polling interval, not a cancellation SLO). The
updated Edge worker does not send a task-ID-only runtime cancellation call that
could arrive late and interrupt a newer attempt. The existing background forwarder
and runtime worker pool already carry request signals to the execution.

If the worker dies after accepting cancellation, a bounded sweep (at most 100
expired cancelled tasks per poll) converges the task and its running attempt to
cancelled. It does not rerun the invocation. Physical termination of an external
provider is not guaranteed by changing database state; provider deadlines and
idempotency remain required.

## Mirror evidence

Tenant mirror upserts may only advance an attempt, never move it backwards.
Cleanup matches project, task and attempt. A late old cleanup cannot delete newer
execution evidence. A duplicate start or uncertain settlement does not clean a
live owner's evidence. The mirror remains evidence only; the authoritative GoTrue
user check still happens sequentially before the mirror and again immediately
before dispatch. No positive user cache or fail-open authorization is introduced.

## Rollout and verification

No new schema migration is needed for attempt fencing: it uses existing task and
attempt columns. The output journal still requires its separately opt-in migration.
Do not infer that mixed-version workers are safe: old binaries still contain
unfenced writes. Drain/stop old workers and deploy the updated worker everywhere
before claiming stale-worker protection. No production deployment is performed
by the test scripts.

The Task Output Contract CI runs PostgreSQL 16 and 18 fixtures. It verifies
concurrent start/settlement, stale success/failure/cancel/renew, expiry during a
row-lock wait, cancellation winning over success, transactional rollback including
journal cursors, crashed-cancellation convergence, and the actual mirror service.
It also runs production Elysia output routes, task-output service and SDK over real
loopback HTTP and PostgreSQL with cryptographically verified **fixture** JWTs:
disconnect/replay, proxy failure, missing Realtime notifications, ownership denial,
and final-result persistence. It does not use a live GoTrue issuer or model.

Worker unit tests exercise the actual orchestration against mocked I/O. Heartbeat
unit tests exercise the production helper rather than reproducing its arithmetic.
The database/HTTP scripts fail when their explicit disposable database is absent;
they must not silently skip the meaningful assertions.

Remaining production gates: real authenticated browser/gateway/GoTrue end-to-end
execution, live model integration and cancellation, multi-process runtime crash
and Caddy reload scenarios, retention scheduling, shared project-level output
quotas, and measured SLO/capacity acceptance. Fixture HTTP tests are not a claim
that all of these rollout gates have passed.
