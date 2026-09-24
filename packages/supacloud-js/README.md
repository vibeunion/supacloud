# `@supacloud/js`

`@supacloud/js` is the platform SDK for SupaCloud.

It does **not** replace [`@supabase/supabase-js`](https://www.npmjs.com/package/@supabase/supabase-js). Instead, it wraps a normal Supabase client and adds SupaCloud-specific capabilities such as:

- background task submission
- task detail and list APIs
- cancel / retry helpers
- Task subscription through polling, with optional application-owned Realtime
- Supabase Queues helpers backed by the official `pgmq_public` RPC API, plus SupaCloud management extensions for queue administration and diagnostics
- Service-role-only durable workflow helpers backed by PostgreSQL and PGMQ
- Service-role-only transactional command receipts backed by Durable Workflows
- Immutable Storage artifact registration and lineage helpers
- project OAuth/OIDC migration and OAuth client management
- SupAuth-compatible OAuth refresh adaptation

## Install

```bash
npm install @supacloud/js @supabase/supabase-js
```

## Browser Command Contracts

Applications that already use this SDK can import the existing framework-neutral
command client from `@supacloud/js/contracts`. This optional browser entrypoint
re-exports selected `@supacloud/contracts/client` APIs without loading the platform
SDK, Supabase, Angular, Svelte, a database driver or browser storage.

```ts
import {
  createAuthoritativeCommandClient,
  createAuthenticatedFetch,
  createCommandScope,
} from "@supacloud/js/contracts";
```

There is no second command engine or new transport protocol. Input, acknowledgement
and authoritative result decoders remain application-owned. The client sends at
most one write and performs at most one read-only confirmation per invocation;
an `unknown` outcome never authorizes a write retry.

This is **not** `supacloud.commands`: that namespace calls service-role-only
database RPCs and must not be wired into a browser admin action. Keep credentials,
authorization, transactions, receipts and idempotency on the trusted server.
The SDK root and existing task adapters are unchanged.

See [svadmin integration](../../docs/svadmin-sdk-integration.md) for ownership,
Svelte lifecycle integration, SDK compatibility gates and the next contract
generation steps. This entrypoint is additive; it does not make an older svadmin
peer range compatible with a newer SDK.

## Quick Start

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudTaskFetch } from "@supacloud/js";

const supabase = createClient("https://api.example.com", "anon-key", {
  global: {
    fetch: createSupaCloudTaskFetch({
      functionUrls: ["https://api.example.com/functions/v1/aorist-ai/generate/crop"],
    }),
  },
});

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.example.com",
  projectRef: "abcd1234",
});

const task = await supacloud.tasks.submit("aorist-ai/generate/crop", {
  body: { image_id: "img_123" },
  idempotencyKey: "crop-img_123-v1",
  correlationId: "workflow-run-123",
  businessTaskId: "aorist-task-123",
  metadata: {
    workflow_id: "workflow-123",
    billing_subject: "user-123",
  },
});

const finalState = await task.wait();
console.log(finalState.status);
```

## SupAuth OAuth refresh with `supabase-js`

SupAuth OAuth public clients can require `client_id` on refresh-token requests.
Keep using `@supabase/supabase-js` for session storage, locking, and automatic
refresh, and provide the SupaCloud transport adapter when creating the client:

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudOAuthFetch } from "@supacloud/js";

const supabase = createClient("https://auth.example.com", "anon-key", {
  global: {
    fetch: createSupaCloudOAuthFetch({
      clientId: "public-oauth-client-id",
      tokenEndpoint: "https://auth.example.com/auth/v1/oauth/token",
    }),
  },
});
```

For a standard single-project Supabase app without SupAuth, omit `clientId` (or
omit the adapter entirely). With no `clientId`, the returned transport is a
transparent pass-through, so the regular `/auth/v1/token` refresh flow remains
unchanged. This allows shared application setup to enable SupAuth by
environment configuration without maintaining a second session implementation.

The adapter only transforms `POST /auth/v1/token?grant_type=refresh_token`:
it sends the same refresh token as an OAuth form request, moves
`grant_type=refresh_token` into the form body, and adds `client_id` when the
request does not already contain one. Rewritten refresh requests reject HTTP
redirects instead of forwarding the refresh token to a second endpoint. All
other Supabase Auth, Database, Storage, Realtime, and Functions requests pass
through unchanged. Never pass a client secret to browser code.

## SupAuth Management Compatibility

**Breaking change:** the unsupported `supacloud.supauth` namespace and all
`SupaCloudSupAuth*` types have been removed. Its five methods (`provision`,
`reconcile`, `rollback`, `getClientConfig`, `verify`) targeted routes that are
not implemented by this repository's Management API. Earlier examples and
mocked success responses did not establish that these operations existed.
Consumers using that namespace must remove those calls before upgrading.
There is no equivalent SupAuth provisioning, rollback or health workflow in
this SDK; an actual backend contract is required before one can be added.

The existing `auth.oauthServer` and `auth.oauthClients` APIs remain available
for their documented OAuth/OIDC operations. OAuth Server status describes
configuration, not verified runtime health, and is not a replacement for the
removed SupAuth verification helper. `createSupaCloudOAuthFetch` continues to
adapt SupAuth refresh requests without adding a Management orchestration API.
Normal application sessions, database, storage, realtime and edge-function
calls remain on `@supabase/supabase-js`.

Do not expose SupaCloud Management API credentials in browser code.

## Design

This SDK is intentionally thin:

- `supabase-js` still owns auth, storage, database, Realtime transport, and plain function invokes
- `@supacloud/js` owns SupaCloud platform semantics layered on top of that transport

`tasks.submit()` expects the target function path to be configured in `background_routes`.
That keeps frontend calls compatible with strict CORS deployments while preserving the same task receipt API.
Successful submission requires the official invocation's HTTP `Response` with
status 202 and no redirect marker. Other success statuses or missing response
metadata are unconfirmed even when the body resembles a task receipt. This
post-response check does not prevent a transport from following redirects.
Receipts require `project_ref` exactly matching the configured project, a valid
task ID and a nonempty string status. Missing project identity is unconfirmed,
not accepted as a legacy receipt. Missing status
no longer defaults to `enqueued`. Legacy `taskId` is accepted, but both ID
aliases must agree after UUID normalization. Progressed and future statuses
are preserved for idempotent replay. Invalid receipts throw
`SupaCloudTaskSubmitError` with `TASK_SUBMIT_UNCONFIRMED` and
`mutationMayHaveApplied: true`. This does not prove enqueue failure; the SDK
does not automatically retry. Receipt validation is not a function transport
timeout or streamed response-size limit.
Submission waiting has a separate 15-second deadline around the official
Functions invocation, including waiting for its parsed response. On timeout,
the SDK aborts the invocation signal and throws `TASK_SUBMIT_UNCONFIRMED` with
`mutationMayHaveApplied: true`; it never automatically replays the call.
The legacy `retries` and `timeoutSec` submit fields are accepted for source
compatibility but ignored; configure retry budgets and worker timeouts in the
platform project/function settings. This SDK deadline is independent of worker
execution time. A custom transport that ignores cancellation may continue in
the background. The deadline does not impose a streamed response-size limit.
Network, relay, server and response-parsing failures also produce
`TASK_SUBMIT_UNCONFIRMED`, without exposing the underlying exception.
Verified official `FunctionsHttpError` responses with a non-redirected HTTP
4xx status retain their original error and response context. Neither category
is automatically retried.

Background task idempotency keys bind the invocation content, business headers,
caller identity, exact decrypted credentials and execution configuration.
Reusing a key with different values returns HTTP 409 `TASK_IDEMPOTENCY_CONFLICT`.
Tracing headers may change, and re-encrypting unchanged credentials is allowed.
A refreshed JWT or rotated API key is a credential change, even for the same user.
After an unconfirmed submission, do not automatically switch to a new key:
the original task may already exist. Read its receipt/task when available and
resolve the original outcome before submitting a distinct operation.
The SDK never automatically retries submission. The Management service may
retry database failures only when a nonempty idempotency key is present;
without one, a failed submission can still have committed a task.

To bound the response before the official Functions client parses it, install
the task transport when creating the Supabase client:

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudTaskFetch } from "@supacloud/js";

const supabase = createClient(supabaseUrl, publishableKey, {
  global: {
    fetch: createSupaCloudTaskFetch({
      functionUrls: [`${supabaseUrl}/functions/v1/aorist-ai/generate/crop`],
    }),
  },
});
```

Only the captured origin/path pairs are guarded; query arguments do not change
the match. Configured URLs must not include credentials, query or fragment.
Matched requests use a 1 MiB streamed-byte cap, strict UTF-8/JSON, a 15-second
fetch/body deadline, `redirect: "error"` and `cache: "no-store"`. Other addresses
pass through unchanged. An optional `fetch` supplies the underlying transport.
Existing Supabase clients are not automatically retrofitted, and custom
transports must honor redirect policy to prevent redirect dispatch.

Task Management reads, lists, cancellation and retry automatically limit
fetch/body waiting to 15 seconds and response bodies to 1 MiB before JSON
parsing. They require JSON/UTF-8, reject redirects and disable caching.
Access-token resolution has a separate 15-second deadline, followed by the
15-second fetch/body deadline. Invalid tokens or resolver failures throw
`SupaCloudTaskAuthenticationError` with `TASK_AUTH_INVALID`; timeouts use
`TASK_AUTH_TIMEOUT`. Both have `mutationMayHaveApplied: false`, and a late token
cannot dispatch the task request. A custom resolver's background work cannot
be forcibly stopped. Function invocation via `tasks.submit()` is separate.
Invalid reads throw `SupaCloudTaskResponseError` with `TASK_READ_INVALID`.
An unconfirmed cancel/retry response uses `TASK_CANCEL_UNCONFIRMED` or
`TASK_RETRY_UNCONFIRMED` and `mutationMayHaveApplied: true`: read the task state
before deciding whether to retry. The SDK does not automatically replay those
mutations. Explicit JSON 4xx errors retain their `SupaCloudApiError` status/body.
All Task Management records, submission receipts and Realtime snapshots require
`project_ref` exactly matching the configured project. A missing, conflicting
or malformed marker rejects the response, including an entire mixed-project
list. Legacy records without the marker are no longer accepted. This check
does not replace server authorization. Invalid submission receipts are
unconfirmed; invalid Realtime events call `onError` without updating or ending
the subscription.
`SupaCloudTaskDetail.project_ref` is a required string in the public type,
matching the decoder's project validation. Consumers constructing task
details themselves must now supply this field.
Task list filters are validated before authentication. Limits must be positive
safe integers; status/task-type filters use a nonempty string or nonempty array
of strings, not comma-separated strings. Empty, padded, control-bearing values,
accessors and unknown filter keys are rejected. `listDlq(limit)` uses the regular
task list with `dlq=true` so the requested limit is forwarded to the route that
supports it; its default remains 100.

Use `correlationId`, `businessTaskId`, and `metadata` when the application already has its own task, workflow, or billing records. SupaCloud stores these fields but does not interpret them; lifecycle webhooks echo them back so the application can update its own tables.

The current package focuses on:

- `tasks.submit`
- `tasks.get`
- `tasks.list`
- `tasks.listDlq`
- `tasks.cancel`
- `tasks.retry`
- `tasks.wait`
- `tasks.subscribe`
- `queues.list`
- `queues.create`
- `queues.drop`
- `queue(name).send`
- `queue(name).sendBatch`
- `queue(name).read`
- `queue(name).receive`
- `queue(name).pop`
- `queue(name).archive`
- `queue(name).ack`
- `queue(name).delete`
- `queue(name).release`
- `queue(name).list`
- `queue(name).listArchived`
- `queue(name).stats`
- `queue(name).purge`
- `queue(name).getSettings`
- `queue(name).updateSettings`
- `auth.oauthServer.getStatus`
- `auth.oauthServer.migrateToOidc`
- `auth.oauthServer.getDiscovery`
- `auth.oauthServer.getJwks`
- `auth.oauthServer.buildAuthorizeUrl`
- `auth.oauthClients.list/create/get/update/delete/regenerateSecret`
- `commands.submit`
- `commands.get`
- `artifacts.register`
- `artifacts.get`
- `artifacts.link`

## Command Status

`commands.submit` and `commands.get` share a runtime-validated status contract:
`kind: "submission"` means accepted work, with `execution: null`; `kind: "execution"`
includes the durable execution receipt. Workflow status remains a separate field.
A completed workflow by itself never proves that an external business effect
occurred. Use `workflows.get(commandId)` for the full workflow details.

`commands.get(commandId)` also accepts a `CommandLookup` object for direct
execution lookup. The lookup may identify a command by `commandId`, or provide
the `{ tenantId, actorId, command, operationId }` reference used by the command
store. The returned `commandId` is the global dispatch/workflow ID.
These RPCs remain service-role-only and are not browser authorization boundaries.

For submitted work, supply verified `tenantId` and `actorId` on submission, then
bind the claimed execute step with `createPostgresCommandStore(database, { submission })`.
The executor preserves the submitted ID and atomically completes or advances the
same Workflow; it does not create a second command. See
[migration and worker wiring](../../docs/command-workflow-convergence.md).

This is a breaking SDK return-shape change: old top-level `idempotent`, target and
full-workflow fields are no longer the public command status contract. Identical
submission replay still deduplicates in SQL. Legacy low-level SQL snapshot/submit
functions retain their stored submission data; older records are not reclassified
as confirmed executions.

## Typed Task Results

Task details and submission receipts default to `unknown` for the result payload.
Use an explicit runtime decoder when the application wants a trusted result type;
the decoder runs against a bounded JSON snapshot returned by the platform.

```ts
type Invoice = { id: string; total: number };

function decodeInvoice(value: unknown): Invoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid invoice");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.total !== "number") {
    throw new Error("Invalid invoice");
  }
  return { id: record.id, total: record.total };
}

const receipt = await client.tasks.submitTyped(
  "generate-invoice",
  decodeInvoice,
  { body: { orderId } },
);
const completed = await receipt.wait();
if (!completed.result) throw new Error("Invoice result is not available");
const invoiceId: string = completed.result.id;
```

`getTyped`, `listTyped`, `listDlqTyped`, `waitTyped`, `cancelTyped`,
`retryTyped` and `subscribeTyped` use the same decoder contract. A decoder is
required before a typed read starts; decoder failure throws a redacted
`SupaCloudTaskDecoderError` (`TASK_RESULT_INVALID`). For `cancel` and `retry`,
that error remains outcome-uncertain because the server mutation may already
have committed. The SDK never retries or replays an unconfirmed mutation.

## OAuth Client Management

`auth.oauthClients` calls SupaCloud Management API, not GoTrue directly. It
validates client fields, response status and requested client identity before
returning data. Public clients cannot carry secrets; confidential creation and
secret rotation return a required `client_secret`. Save that one-time result
securely rather than expecting subsequent reads to return it.

Each operation accepts a final `{ signal, timeoutMs }` argument. The default
deadline is 15 seconds and covers credential resolution, the request and its
response body. Requests reject redirects and are not retried automatically.
`SupaCloudOAuthClientError` extends `SupaCloudApiError` and exposes
`mutationMayHaveApplied` for uncertain writes. Cancellation does not undo a
request that the server has already received.

Console integrations can use the standalone client with an existing
authenticated, same-origin request function:

```ts
import { SupaCloudOAuthClientsClient } from "@supacloud/js";

const clients = new SupaCloudOAuthClientsClient({
  projectRef,
  managementApiUrl: "",
  sessionRequest: authenticatedRequest,
});
const result = await clients.list({ signal });
```

This explicit session mode accepts only a relative Management URL and never
adds a bearer token. The supplied transport remains responsible for session
handling. Recreate the client when the project changes and cancel old requests.

Deploy the updated Management OAuth adapter before this client: list responses
must contain a `clients` array, creation returns HTTP 201, and deletion returns
an empty HTTP 204. GoTrue's raw `{}` empty list is normalized by Management.
Canonical UUID client IDs and supported authentication/grant enums are now
enforced; malformed legacy responses no longer pass through.

## Status Subscription

`tasks.subscribe()` polls the Management API by default. The platform does not
provision a `public.tasks` Realtime table. Internal background task mirrors
are execution evidence, not a complete lifecycle feed.

Applications with their own published task-state table can explicitly opt in:

```ts
const subscription = task.subscribe({
  realtime: { schema: "public", table: "task_updates" },
  onUpdate(snapshot) {
    console.log(snapshot.status);
  },
});
```

That table must expose the platform task `id`, `project_ref` and `status`,
and have appropriate publication, SELECT privileges and row-level policies.
The SDK does not create the table or grant access. Schema/table names must be
simple identifiers of at most 63 characters. Explicit Realtime subscriptions
retain Management polling on connection failure and periodic reconciliation.
An omitted source no longer guesses `public.tasks`; malformed source options
are rejected before opening a channel.
Polling intervals must be integer milliseconds from 1 through 2,147,483,647.
Realtime connection timeout and reconciliation intervals accept the same
range plus 0 to disable that timer. Invalid explicit values, including null,
are rejected before authentication or subscription work. The computed default
reconciliation interval is capped at the same maximum.
Subscription options are captured at creation. Callbacks must be functions,
`stopOnTerminal` must be boolean, and unknown keys or accessor properties are
rejected. Changing the original options or callbacks afterward does not
reconfigure an active subscription.
Thrown or rejected callback failures close the subscription. Failures from
update/state callbacks are reported through `onError` when available;
failure of `onError` itself is not reported recursively. Channel-removal
errors are handled without an unhandled rejection. Already-running application
callback work cannot be forcibly stopped.
`tasks.get(taskId, signal)` accepts an optional abort signal, and `wait()` now
forwards its signal through credential resolution and each HTTP read.
Cancellation preserves the caller's abort reason. Closing a subscription
aborts its reads and suppresses their late errors; a late credential cannot
dispatch a cancelled read. Noncooperative provider/transport work may continue
internally despite cancellation.

## Task Lifecycle Webhook

Applications that already own a business task table should keep it. SupaCloud emits lifecycle events so the app can sync `public.tasks`, billing, Realtime, and workflow rows without adopting platform-internal mirror tables.

Register a webhook from a trusted backend:

```http
POST /v1/projects/:ref/task-events/webhook
Authorization: Bearer <management-token>
Content-Type: application/json

{
  "url": "https://app.example.com/supacloud/task-events",
  "secret": "shared-hmac-secret"
}
```

Events are delivered as `{ events: [...] }`. Each event includes `event_type`, `task_id`, `status`, `attempt`, `correlation_id`, `business_task_id`, and `metadata`.

Supported lifecycle events:

- `task.created`
- `task.running`
- `task.succeeded`
- `task.failed`
- `task.retry_scheduled`
- `task.dead_lettered`
- `task.cancelled`

If `secret` is set, verify `X-SupaCloud-Signature: sha256=<hmac>` against the raw JSON body.

## Queue Helpers

**Breaking change:** queue message `id` and `msg_id` are canonical positive
int64 decimal strings. Mutation inputs accept those strings or positive safe
JavaScript integers. Invalid, rounded or noncanonical IDs are rejected, never
coerced to `0`. A large ID that has already been parsed as an unsafe JavaScript
number cannot be recovered: the SDK rejects it. End-to-end large-ID delivery
therefore requires a transport that preserves such IDs as decimal strings.
Deploy the matching Management backend for full-int64 visibility, archive and
delete paths. Its PGMQ message queries return IDs as SQL text and its mutation
parameters bind decimal strings as `bigint`. Older backends still reject large
IDs. Management send/batch/message responses now also expose string IDs.

Queue messages use `SupaCloudQueueJson`, including arrays, scalars and null.
Sending captures an independent JSON snapshot before asynchronous transport;
cycles, undefined, accessors, nonfinite numbers and non-JSON objects are rejected.
Snapshots are bounded to 64 nesting levels, 10,000 values and 1,048,576 total
key/string characters. These are decoded-value budgets, not raw HTTP body limits.
Callers must narrow a received payload before using it as an object.

Single-send and batch receipts must have exactly the expected distinct IDs.
Only actual empty row arrays mean no messages; malformed reads are errors.
Archive/delete require literal boolean receipts, preserving `false`.
Seconds/counts must be bounded integers and conflicting option aliases fail.
`receive()` accepts only a count of one.

Queue RPCs explicitly disable underlying retries. Their transport and receipt
failures use `SupaCloudQueueError.mutationMayHaveApplied`; reads alter visibility
and `pop()` deletes, so those operations can also have uncertain outcomes.
Do not automatically repeat an uncertain operation. This does not add deadlines
or cancellation to the supplied Supabase transport, or certify a live PGMQ
transaction. Management extensions retain their separate transport limitations.

The core message operations use the official Supabase Queues API exposed through `pgmq_public`:

- `pgmq_public.send(queue_name, message, sleep_seconds)`
- `pgmq_public.send_batch(queue_name, messages, sleep_seconds)`
- `pgmq_public.read(queue_name, sleep_seconds, n)`
- `pgmq_public.pop(queue_name)`
- `pgmq_public.archive(queue_name, message_id)`
- `pgmq_public.delete(queue_name, message_id)`

These calls go through your wrapped `supabase` client as `supabase.schema('pgmq_public').rpc(...)`. Queue creation/drop, queue listing, metrics, purge, settings, diagnostics, and visibility-timeout adjustment are SupaCloud management extensions because Supabase's public Queue API intentionally does not expose those as client-side RPCs.

```ts
const queue = supacloud.queue("emails");

const message = await queue.send(
  { to: "user@example.com", template: "welcome" },
  {
    sleepSeconds: 10,
  },
);

const leased = await queue.receive({ visibilityTimeoutSec: 60 });
if (leased) {
  try {
    await sendEmail(leased.payload);
    await queue.ack(leased.msg_id);
  } catch (error) {
    await queue.release(leased.msg_id, { delayMs: 30_000, error: String(error) });
  }
}

const stats = await queue.stats();
console.log(stats.queue_length, stats.oldest_msg_age_sec);
```

Queue API surface:

- `queue.send(payload, { sleepSeconds })`: enqueue one message through `pgmq_public.send`
- `queue.sendBatch(messages, { sleepSeconds })`: enqueue messages through `pgmq_public.send_batch`
- `queue.read({ sleepSeconds, n })`: read up to `n` messages through `pgmq_public.read`
- `queue.receive({ visibilityTimeoutSec })`: compatibility shortcut for `read({ n: 1 })`
- `queue.pop()`: read and delete the next message through `pgmq_public.pop`
- `queue.archive(messageId)` / `queue.ack(messageId)`: archive a message through `pgmq_public.archive`
- `queue.delete(messageId)`: delete a message through `pgmq_public.delete`
- `queue.release(messageId, { sleepSeconds | delayMs })`: SupaCloud extension for `pgmq.set_vt`
- `queue.list(filters)`: SupaCloud diagnostic extension for queue/archive table inspection
- `queue.listArchived(limit)`: SupaCloud diagnostic shortcut for archived messages
- `queue.stats()`: SupaCloud extension for `pgmq.metrics`
- `queue.purge()`: SupaCloud extension for `pgmq.purge_queue`
- `queue.getSettings()`: read concurrency, lease, retry, and rate-limit settings
- `queue.updateSettings(settings)`: patch queue settings
- `supacloud.queues.list()`: list queues with `pgmq.list_queues`
- `supacloud.queues.create(name, { unlogged })`: create a basic or unlogged queue
- `supacloud.queues.drop(name)`: drop a queue

Queue settings:

- `max_in_flight`: max concurrently leased/running messages for this queue
- `default_visibility_timeout_sec`: lease timeout used by `receive()`
- `max_attempts`: application-level retry budget for SupaCloud consumers; PGMQ itself stores plain JSON messages
- `rate_limit_per_minute`: producer enqueue limit

Management extension conflicts are surfaced as `SupaCloudApiError` with `status`, `code`, and `responseBody`, so callers do not need to parse raw `fetch` responses.

## Durable Workflows

`supacloud.workflows` coordinates code-defined, linear steps on the project's PostgreSQL and PGMQ runtime. Every workflow RPC is restricted to `service_role`; create this client only in a trusted worker or server process.

Install the response guard when creating the Supabase client:

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudWorkflowFetch } from "@supacloud/js";

const supabase = createClient("https://api.example.com", "service-role-key", {
  global: { fetch: createSupaCloudWorkflowFetch() },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://management.example.com",
  projectRef: "project-ref",
});
```

The guard bounds workflow responses to 1 MiB before JSON parsing, validates
UTF-8, rejects redirects, and limits fetch/body waiting to 15 seconds. Other
Supabase requests pass through unchanged. Supply `{ fetch: yourFetch }` to
compose with an existing transport. An already-created Supabase client is not
retrofitted automatically: without this guard, workflow decoders and wait
limits still apply, but preparse byte limits do not. Large existing workflow
snapshots may exceed this new byte budget.

Command RPCs need their own guard. Compose both guards when using commands and
workflows with the same Supabase client:

```ts
import { createSupaCloudCommandFetch, createSupaCloudWorkflowFetch } from "@supacloud/js";

const guardedFetch = createSupaCloudCommandFetch({
  fetch: createSupaCloudWorkflowFetch(),
});
// Pass guardedFetch as global.fetch when constructing the Supabase client.
```

The command guard covers `supacloud_command_submit` and `supacloud_command_get`
with the same 1 MiB and 15-second limits. A rejected submission response may
already have committed. Explicit replay must retain the original command
identity and payload; a receipt that remains over the byte cap will still be
rejected even when its replay is idempotent.

For artifact receipts, wrap the combined transport with
`createSupaCloudArtifactFetch({ fetch: guardedFetch })` and install that result
as `global.fetch` when creating the Supabase client. Import this helper from
`@supacloud/js`. It applies the same byte, UTF-8, redirect and wait limits to
artifact register/get/link RPCs only; Storage file transfers remain unchanged.
Registration and link errors caused by rejected responses may follow a
successful database commit. Existing Supabase clients are not modified.

```ts
const runId = crypto.randomUUID();

await supacloud.workflows.start({
  runId,
  workflowName: "invoice.issue",
  workflowVersion: "1",
  firstStepKey: "validate",
  input: { invoiceId: "inv-123" },
});

const claim = await supacloud.workflows.claim({
  workerId: "invoice-worker-1",
  visibilityTimeoutSeconds: 300,
});

if (claim?.status === "claimed") {
  await supacloud.workflows.complete({
    stepId: claim.stepId,
    messageId: claim.messageId,
    attempt: claim.attempt,
    workerId: claim.workerId,
    stepOutput: { validated: true },
    runOutput: { invoiceId: "inv-123" },
  });
}
```

Available operations are `start`, `claim`, `advance`, `complete`, `retry`, `fail`, `cancel`, `get`, and `events`. No workflow RPC is automatically retried. Identity-bound mutations support explicit replay of the same request after a lost response; changed replay payloads can fail with a conflict. `claim` is not idempotent: repeating it after a lost response can acquire another message or attempt. An unconfirmed mutation, including a response rejected by the guard, may already have committed. Install the current workflow SQL before using the retry SDK, which requires the persisted `retryReceipt` response field. See the repository's `docs/durable-workflows.md` for execution, security, and DBOS design boundaries.

Message IDs, queue message IDs, event cursors, and run row versions are decimal strings, preserving the full PostgreSQL `bigint` range. Retry a `claim` that returns SQLSTATE `40001`; the contended queue lease is rolled back before that error is returned.

## OAuth/OIDC Helpers

`client.auth.oauthServer` is the SupaCloud SDK surface for project-scoped OAuth 2.1 / OIDC migration and discovery.

It does **not** take a global account scope. Management requests carry the
Management API Bearer token; public Discovery/JWKS requests carry no management
headers or cookies. All requests reject redirects.

Status is a validated configuration contract, with `state_source:
"configuration"` and `runtime_verified: false`. Organization is required but
nullable. Signing algorithm, key ID, readiness and migration status must agree.
Deploy the matching Management backend before this SDK; legacy incomplete
status responses are rejected.

Each operation has a 15-second total deadline and each JSON body is limited to
64 KiB with strict UTF-8 decoding. Public endpoints must match the configured
issuer. Discovery returns declared issuer/endpoints and supported response,
subject and signing lists. JWKS returns validated ES256/RS256 public keys only,
requiring the configured key ID and algorithm. Unknown fields are stripped.
The SDK rereads configuration after public reads and rejects observed changes.
This is not full OIDC conformance, transactional configuration locking, key
material attestation or a network destination allowlist. The Management
configuration remains the trust anchor; HTTP is accepted for local runtimes.

Migration validates submitted values against the receipt, preserves the
configured signing identity, and never retries a write automatically.
`SupaCloudOAuthServerError.mutationMayHaveApplied` signals uncertain writes;
the recognized dependent-refresh failure code remains an error, not success.
Authorization URL inputs are validated and captured before asynchronous work.
The URL builder does not generate state, nonce or PKCE values, or validate the
subsequent authorization callback.

## Consumer Type Verification

`bun run typecheck:consumer` generates JavaScript and declarations from the
current SDK source into a temporary package and compiles the NodeNext consumer
against that package's real export map. It uses the installed Supabase peer
dependency and Node declarations, with `skipLibCheck: false`,
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Existing `dist`
files in the SDK checkout are neither read nor overwritten.

Dependency declaration failures remain failures. This check does not replace
Supabase declarations with stubs, patch ambient browser types or certify live
authentication behavior.
