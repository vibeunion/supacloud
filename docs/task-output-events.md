# Optional durable task output (no gRPC)

This is a SupaCloud extension, not a replacement Supabase protocol. Ordinary
`functions.invoke()`, PostgREST/database RPC, Auth, Storage and native Realtime
channels are unchanged. Only explicitly configured background functions create
background tasks. No gRPC/gRPC-web, protobuf contract, extra queue, durable
observation session, or new container scheduler is required.

## Implemented boundary

The existing executor and task state machine remain authoritative. A trusted
executor can append public output to an active task attempt; callers observe it
through authenticated HTTP pagination. Existing Realtime task-state notifications
can wake the observer, but periodic HTTP reads continue even while connected.
This prevents a lost final notification from hiding a committed terminal state.
There is no automatic new Broadcast publisher and no mandatory task SSE endpoint.
Request-bound Edge Function SSE remains independent of this extension.

The journal is in the **control-plane database**, not a tenant's exposed schema.
Public output must not contain prompts or tool results the task owner may not see,
credentials, internal logs or provider headers. Internal workflow logs/Webhooks
are not automatically projected into public output.

## Enable explicitly

After the normal control-plane schema initialization and a verified backup:

```sh
cd packages/management-api
# DATABASE_URL must identify the CONTROL-PLANE database, never a tenant database.
bun run scripts/migrate-task-output-journal.ts --apply
```

The migration is additive and transactional, serializes concurrent migration
attempts, and honors the existing expected-database fingerprint/snapshot guard.
Without the migration, these new endpoints return `503 TASK_OUTPUT_UNAVAILABLE`;
no request performs DDL and ordinary tasks continue to use their existing APIs.
The first successful output append opts a task into the journal. Existing
history is not backfilled or invented. Reapplying the migration is supported.

Use the existing operator scheduler to run the following periodically in the
control-plane database; this release does **not** install a cron job:

```sql
SELECT public.supacloud_prune_task_output();
```

Each invocation prunes at most 100 terminal tasks completed more than seven days
ago. Repeat batches according to backlog/capacity. Configure and monitor this job
before production use. This is a cleanup policy, not a promise that every row is
automatically deleted at the seventh day. Results and quota counters survive
pruning. Active tasks are not pruned; existing task timeouts/abandonment handling
must remain enabled.

Rollback: stop the optional producers/observers and roll back application code.
Keep the journal tables and data. To stop lifecycle capture, an operator may drop
only the `supacloud_task_output_lifecycle` trigger in a controlled maintenance
transaction. Do not drop the task table or delete task results.

## API

`GET /v1/projects/:ref/tasks/:taskId/events?after=0&limit=50`

Read authorization accepts either an authenticated project-user JWT **owning the
task**, or existing project/admin permissions. The ordinary-user exception is
restricted to this exact GET resource; it grants no task listing, mutation,
queue, or other management access. Delegated requests still pass existing BFF
proof and capability checks. Ownership uses the persisted `invoker_user_id`,
checked together with the page snapshot. Another project/owner receives 404.
Anonymous and sub-less tokens do not qualify. Credentials belong in headers.
Database grants/RLS deny direct access through PUBLIC and tenant API roles.

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

`after`, `next_cursor`, `sequence`, `last_sequence`, and `retained_after` are
canonical decimal **strings**, never JS numbers. Pages contain at most 100 events.
A sequence is allocated under the task lock in the same transaction as insertion;
rollback cannot leave an allocated-but-uncommitted hole. Cursor order is per task,
not a global timestamp or PostgreSQL identity sequence.

A stale cursor returns **410 `TASK_OUTPUT_REPLAY_UNAVAILABLE`** with the watermark.
A cursor beyond committed history returns **400 `TASK_OUTPUT_CURSOR_AHEAD`**.
Do not silently reset either cursor. Offer a deliberate reset/final-result view.
Read final results through the application's existing authorized task/result
API, not from this output stream. This change does not broaden existing task
detail/cancel/retry permissions.

`POST /v1/projects/:ref/tasks/:taskId/events` is for trusted project/admin executors:

```json
{
  "attempt": 1,
  "event_id": "22222222-2222-2222-2222-222222222222",
  "type": "output.delta",
  "payload": { "text": "Hello" }
}
```

Supported producer types: `output.delta`, `output.snapshot`, `progress`, `warning`.
The task's current attempt, active status, lease and cancellation flag must match.
An old/cancelled/expired attempt cannot append new events. Repeating the same
`(task_id, attempt, event_id)` and content acknowledges the committed event;
different content returns 409. Never generate a fresh ID just to retry an
uncertain append. The SDK does not automatically retry POSTs.

For opted-in tasks, an AFTER UPDATE trigger records `task.<existing-status>`
lifecycle events atomically with status/attempt changes. These contain only the
status, not internal payloads/errors/results. The producer cannot forge terminal
lifecycle events. This does not introduce new task states or change the existing
pgflow cancel/retry restrictions.

Limits: 20 KiB request body, 16 KiB output payload (database JSONB text representation
is authoritative), 4096 producer events and 1 MiB output payload per task lifetime,
including retries. Batch/coalesce tokens; large artifacts belong in Storage.
Lifecycle events do not consume the output quota, so reaching the output quota
does not itself block the terminal lifecycle write. Existing API request limits
still apply. Distributed project-wide output-rate/storage quotas are not added
by this change.

## Browser/SDK observation

The new entrypoint is opt-in; the ordinary `@supacloud/js` and official
`@supabase/supabase-js` entrypoints are not wrapped or reconfigured.

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
  // Store/render by task + attempt. Do not concatenate different attempts.
  // Make processing idempotent: a crash between processing and checkpoint may replay.
  await applyOutput(event);
}
// controller.abort() stops observing; it does NOT request task cancellation.
```

`watch()` checkpoints only after the consumer resumes from processing each event.
Breaking/throwing in the consumer does not checkpoint that event. Snapshot/page
validation rejects cross-project data, unknown schema versions, holes, duplicate
sequences and forged cursor jumps. Transient GET errors retry with bounded
backoff; 401/403/410 do not silently retry/reset. Every request refreshes headers,
has a deadline, rejects redirects and bounds the response to 2 MiB.

An optional `subscribe(wake)` hook can attach an existing authorized Realtime
channel and return its cleanup function. A notification only calls `wake()`;
its payload never advances the replay cursor. Polling still runs when no message
arrives. Do not patch `supabase.channel()` or invent a new native wire protocol.

## Executing text tasks

[durable-text-output.ts](./examples/durable-text-output.ts) adapts an existing
background function to an injected model provider's async text iterator. Supply
the existing task ID/attempt and a **server-only** event client with trusted
credentials. The existing runtime owns task completion, cancellation and retry.
It is an integration example, not a newly deployed model provider or worker.

Event replay is not model continuation. Restarting a non-resumable model call
creates another attempt. External tools/billing still need their own idempotency.
This patch fences **output appends**; it does not retrofit every pre-existing
worker result/lease transition with attempt fencing. Do not advertise end-to-end
exactly-once execution or seamless provider resume.

## Verification and remaining rollout gates

Portable unit tests cover pagination, ownership boundary selection, bounded bodies,
SDK recovery, attempt separation, checkpoints, abort cleanup and uncertain writes.
Elysia route tests verify authorization-before-parse and raw request handling.
The dedicated Task Output Contract workflow also runs the PostgreSQL acceptance
script against a disposable loopback database: repeated migrations, concurrent
appends/deduplication, rollback-safe cursors, cross-owner/project denial, leases,
cancellation, lifecycle capture, quota exhaustion and retention.

```sh
bun test packages/management-api/tests/unit/task-output.test.ts \
  packages/management-api/tests/unit/task-output-route.test.ts \
  packages/supacloud-js/src/task-events.test.ts
# An EMPTY disposable database named task_output_test is required:
SUPACLOUD_TEST_TASK_OUTPUT_DATABASE_URL=postgres://...@127.0.0.1:5432/task_output_test \
  bun run packages/management-api/tests/integration/task-output.postgres.ts
```

Before production rollout: run the complete existing compatibility suite; verify
real authenticated browser/API gateway routing, model cancellation, worker crash
and stale final-result behavior; measure output/page latency and storage load;
configure retention/alerts and project-wide resource limits. Live model execution,
worker failover, Caddy reload and production capacity/SLO acceptance are not proven
by the portable unit tests.
