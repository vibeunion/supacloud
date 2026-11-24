# Application Platform Closure

## Product Boundary

The application workflow is one product surface:

`init -> dev -> check -> release -> preview -> deploy -> logs`

`app release` is the CLI's one-command composition of local build and the
existing platform release primitives. It reduces operator steps without moving
platform-owned safety decisions into application scripts.

Existing Supabase interfaces remain authoritative:

- PostgREST remains the REST execution path.
- GoTrue remains the Auth execution path.
- Storage keeps the Supabase object and policy model.
- Realtime remains the subscription transport.
- Public `/graphql/v1` is Postrust Hasura. Lite reads use that shape. `/rest/v1/rpc/graphql` is 404.

SupaCloud adds governance, receipts, isolation, and operator tooling around
those interfaces. It does not introduce a second GraphQL runtime.

## Acceptance Criteria

### P0: application workflow

```gherkin
Given a project with an application source tree
When the operator runs app init, app dev, app check, app deploy, and app logs
Then each step returns a structured receipt and the next step can consume it
And app check remains read-only unless an explicit write action is requested
```

### P0: unified events

```gherkin
Given a database, cron, webhook, queue, or workflow event
When the event is retried or permanently fails
Then the same envelope exposes retry count, idempotency, signature, audit, and DLQ state
And event history can be filtered and paged without leaking task-attempt internals
```

### P0: GraphQL

```gherkin
Given a document posted to /graphql/v1
When the project gateway accepts it
Then the request is rewritten to loopback Postrust /v1/graphql
And subscription requests stay off the project host
```

### P0: preview

```gherkin
Given a verified immutable application release
When a preview is created
Then the release is materialized into a branch-scoped namespace
And the preview receives an isolated database branch, queue namespace, Storage namespace,
test Secret, configuration revision, activation receipt, and application smoke result
When cleanup is requested
Then all preview resources are removed or the receipt records a retryable cleanup failure
```

### P1: operations

```gherkin
Given an operator reviewing an application
When the console loads
Then it can show permission denial reasons, resource relationships, execution timeline,
Storage objects, capacity pressure, and noisy-neighbor ownership
And capacity policies and history are auditable without changing Supabase tenant semantics
```

## Compatibility Rules

1. Public `/graphql/v1` is Postrust Hasura. `SUPACLOUD_POSTRUST_GRAPHQL` stays a default-off management listener.
2. Hosted documents go to that process. Lite reads are SQL under PostgreSQL GRANT and RLS. There is no second hosted GraphQL executor.
3. GraphQL subscriptions are not emulated over HTTP; clients use Supabase Realtime.
4. Migration import writes files only after an explicit output directory and write request.
5. Hasura permissions become reviewable RLS SQL; they are never silently applied.
6. Preview activation is branch-scoped and cannot mutate the source project.
