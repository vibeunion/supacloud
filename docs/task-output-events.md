# Optional durable task output (no gRPC)

This is a SupaCloud extension, not a replacement Supabase protocol. Ordinary
`functions.invoke()`, PostgREST/database RPC, Auth, Storage and native Realtime
channels are unchanged. Only explicitly configured background functions create
background tasks. No gRPC/gRPC-web, protobuf contract, extra queue, durable
observation session, or new container scheduler is required.

## Implemented boundary

The existing executor and task state machine remain authoritative. A trusted
executor appends public output to an active task attempt; callers observe it
through authenticated HTTP pagination. Existing authorized Realtime task-state
notifications can wake the observer, but periodic reads continue while connected
so a lost final notification cannot hide committed terminal state. There is no
new automatic Broadcast publisher and no mandatory task SSE endpoint.
Request-bound Edge Function SSE remains independent.

The journal is in the **control-plane database**, not a tenant's exposed schema.
Public output must not contain credentials, internal logs, provider headers,
prompts or tool results the task owner may not see. Internal workflow logs and
Webhooks are not automatically projected into public output.

## Enable explicitly

After normal control-plane initialization, a verified backup and identity check:

```sh
cd packages/management-api
# DATABASE_URL must identify the CONTROL-PLANE database, never a tenant database.
bun run scripts/migrate-task-output-journal.ts --apply
```

The migration applies journal and shared quota governance together, transactionally,
with serialized migration attempts and bounded waits. It honors the existing
expected-database fingerprint/snapshot guard. Re-run this command when upgrading
from the initial journal-only revision. The updated append endpoint fails with
`503 TASK_OUTPUT_UNAVAILABLE` until the governed function is present; it does not
silently bypass limits. No request performs DDL. Existing read history and ordinary
task APIs remain available independently of optional output producers.

The first successful output append opts a task into the journal. Prior lifecycle
history is not backfilled or invented. Quota accounting DOES include existing
retained output when governance is enabled. Reapplication preserves configured
limits and rate usage. See [shared quotas and retention](./task-output-governance.md)
for migration lock implications, the fingerprint-pinned maintenance command, optional
systemd timer, tuning and operational checks. No production timer is auto-installed.

The underlying cleanup function remains available to trusted operators:

```sql
SELECT public.supacloud_prune_task_output();
```

It prunes at most 100 terminal tasks completed more than seven days ago per call,
excludes overlapping cleanup batches and preserves results/watermarks/lifetime
counters. Active tasks are not pruned. This is eligibility, not an automatic
seventh-day deletion guarantee. The scheduled command defaults to 25 tasks per run.

Rollback: stop optional producers/observers and the retention timer, then roll back
application code. Keep journal tables/data. Quota triggers still protect old append
callers, though old code may expose generic errors. To stop lifecycle capture, an
operator may drop only `supacloud_task_output_lifecycle` in a controlled maintenance
transaction. Do not drop task tables, truncate history or delete final results.

## API

`GET /v1/projects/:ref/tasks/:taskId/events?after=0&limit=50`

Read authorization accepts an authenticated project-user JWT **owning the task**, or
existing project/admin permissions. The ordinary-user exception is restricted to
this exact GET resource; it grants no listing, mutations, queues or other management
access. Delegation still passes BFF proof and capability checks. Ownership uses
persisted `invoker_user_id`, checked together with the page snapshot. Another
project/owner receives 404. Anonymous/sub-less tokens do not qualify. Credentials
belong in headers. PUBLIC and tenant API roles have no direct control-table access.

```json
{
  "schema_version": 1,
  "project_ref": "demo",
  "task_id": "11111111-1111-1111-1111-111111111111",
  "enabled": true,
  "task_status": "running",
  "attempt": 1,
  "events": [],
  "next_cursor": "42",
  "last_sequence": "42",
  "retained_after": "0",
  "has_more": false,
  "replay_available": true
}
```

All cursors/sequences are canonical decimal **strings**, never JS numbers. Pages
contain at most 100 events. Allocation is serialized per task in the insertion
transaction, not through `nextval()` or timestamps; rollback leaves no cursor hole.
Stale cursors return **410 `TASK_OUTPUT_REPLAY_UNAVAILABLE`** and the watermark;
cursors beyond committed history return **400 `TASK_OUTPUT_CURSOR_AHEAD`**. Neither
is silently reset. Final results come from the application's existing authorized
result API. Existing task-detail/cancel/retry permissions are not broadened here.

`POST /v1/projects/:ref/tasks/:taskId/events` is for trusted project/admin executors:

```json
{
  "attempt": 1,
  "event_id": "22222222-2222-2222-2222-222222222222",
  "type": "output.delta",
  "payload": { "text": "Hello" }
}
```

Producer types are `output.delta`, `output.snapshot`, `progress`, `warning`.
Attempt, active status, lease and cancellation must match. Old/cancelled/expired
attempts cannot append. Repeating `(task_id, attempt, event_id)` with the same
content acknowledges the committed event without consuming more quota; different
content returns 409. Reuse event IDs to confirm uncertain writes. The SDK does not
automatically retry POSTs. Reads/writes have bounded database lock/statement waits.

For opted-in tasks, a trigger records `task.<existing-status>` lifecycle events
atomically with status/attempt changes. Their payload contains only status, not
internal errors/results. Producers cannot forge terminal events. This does not
introduce new task states or change pgflow's unsupported cancel/retry actions.

Per task: 20 KiB request, 16 KiB output payload (JSONB text size is authoritative),
4096 producer events and 1 MiB producer payload over the task lifetime including
retries. Shared per-project retained/rate budgets are now enforced in the database;
see [governance](./task-output-governance.md). Rate exhaustion is 429 with Retry-After;
retained-capacity exhaustion is 413. Lifecycle events remain exempt from output
budgets, so saturation does not itself prevent terminal settlement. Coalesce tokens;
large artifacts belong in Storage. These are not physical disk or connection quotas.

## Browser/SDK observation

The opt-in entrypoint does not wrap/reconfigure the ordinary `@supacloud/js` or
`@supabase/supabase-js` entrypoints:

```ts
import { createTaskEventClient } from '@supacloud/js/task-events';

const events = createTaskEventClient({
  baseUrl: managementApiUrl,
  projectRef,
  getHeaders: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('Sign in first');
    return { Authorization: `Bearer ${data.session.access_token}` };
  },
});
const controller = new AbortController();
for await (const event of events.watch(taskId, {
  after: savedCursor ?? '0',
  signal: controller.signal,
  onCursor: async (cursor) => { await saveCursor(taskId, cursor); },
})) {
  // Store/render by task + attempt; do not concatenate different attempts.
  // Processing must be idempotent across a crash before checkpointing.
  await applyOutput(event);
}
// controller.abort() stops observation, NOT task execution.
```

`watch()` checkpoints after the consumer resumes from processing an event. A
break/throw before resuming does not checkpoint that event. Validation rejects
cross-project data, unknown versions, holes, duplicates and forged cursor jumps.
Transient GET errors retry with bounded backoff; 401/403/410 do not silently
retry/reset. Every request refreshes headers, has a deadline, rejects redirects,
and limits response bodies to 2 MiB. Credential resolution failures are not
misclassified as retryable network errors.

Optional `subscribe(wake)` attaches an existing authorized Realtime channel and
returns its cleanup function. Messages only wake HTTP reading; they cannot advance
the replay cursor. Polling continues without messages. Do not patch native channels.

## Execution and verification

[durable-text-output.ts](./examples/durable-text-output.ts) adapts an injected model
provider iterator to an existing background task. It is an example, not a deployed
model. See [attempt fencing](./background-attempt-fencing.md) for atomic settlement,
lease checks, cancellation and mirror evidence protection. Event replay is not
model continuation; non-resumable calls need a new attempt. External side effects
still need idempotency. Drain old workers before claiming full fencing protection.

Task Output Contract CI runs portable protocol/SDK tests, real Elysia route tests,
worker/heartbeat regressions and disposable PostgreSQL 16/18 scripts. Run database
scripts in order: `task-output.postgres.ts`, `task-output-governance.postgres.ts`,
then `background-attempt.postgres.ts`, with an explicit loopback `task_output_test`
database. They test real HTTP/service/SDK/database composition with fixture identities,
not a live GoTrue issuer or model. Unit tests alone are not rollout acceptance.

Remaining gates include real authenticated browser/gateway/GoTrue/model execution,
provider cancellation, multi-process runtime crash and Caddy reload scenarios,
production timer deployment and measured throughput/capacity/SLOs. Shared output
quotas and a deployable retention command are implemented; production activation
and capacity evidence are still required.
