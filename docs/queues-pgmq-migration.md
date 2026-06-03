# Queues PGMQ Migration Guide

This guide documents the migration of SupaCloud Queues to the official Supabase Queues foundation, which is backed by the PostgreSQL `pgmq` extension.

Use this together with the official Supabase Queues docs:

- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Queues API](https://supabase.com/docs/guides/queues/api)
- [Queues Quickstart](https://supabase.com/docs/guides/queues/quickstart)
- [Expose self-hosted Queues](https://supabase.com/docs/guides/queues/expose-self-hosted-queues)

## Scope

SupaCloud now treats Supabase's `pgmq_public` API as the compatibility baseline.

The official public API contains:

- `pgmq_public.send(queue_name, message, sleep_seconds)`
- `pgmq_public.send_batch(queue_name, messages, sleep_seconds)`
- `pgmq_public.read(queue_name, sleep_seconds, n)`
- `pgmq_public.pop(queue_name)`
- `pgmq_public.archive(queue_name, message_id)`
- `pgmq_public.delete(queue_name, message_id)`

SupaCloud only extends the API where the official client surface is intentionally missing operational capabilities:

- create, drop, and list queues
- queue metrics
- purge
- diagnostic message/archive listing
- queue settings
- visibility-timeout adjustment through `pgmq.set_vt`

## Platform Changes

Tenant databases now install and expose the `pgmq` foundation:

1. `CREATE EXTENSION IF NOT EXISTS pgmq`
2. `CREATE SCHEMA IF NOT EXISTS pgmq_public`
3. wrapper functions in `pgmq_public` for the official API
4. `GRANT EXECUTE` on `pgmq_public` functions to `anon`, `authenticated`, and `service_role`
5. PostgREST may expose `pgmq_public`, but only after the wrapper schema actually exists

For self-hosted deployments, keep the safe baseline first:

```env
PGRST_DB_SCHEMAS=public,storage,graphql_public
```

After the tenant database has the `pgmq_public` wrapper schema, you can add it back explicitly:

```env
PGRST_DB_SCHEMAS=public,storage,graphql_public,pgmq_public
```

The bundled self-hosted PostgreSQL image installs `postgresql-18-pgmq` and bootstraps `pgmq` during initdb.

## SDK Migration

`@supacloud/js` core queue message operations now call the wrapped Supabase client directly:

```ts
supabase.schema("pgmq_public").rpc("send", {
  queue_name: "emails",
  message: { to: "user@example.com" },
  sleep_seconds: 10,
});
```

Use the SDK helper for normal application code:

```ts
const queue = supacloud.queue("emails");

const sent = await queue.send(
  { to: "user@example.com", template: "welcome" },
  { sleepSeconds: 10 },
);

const messages = await queue.read({ sleepSeconds: 60, n: 5 });

for (const message of messages) {
  try {
    await sendEmail(message.payload);
    await queue.ack(message.msg_id);
  } catch {
    await queue.release(message.msg_id, { delayMs: 30_000 });
  }
}
```

Queue creation is not part of the official public Supabase Queues API. Use the SupaCloud management extension before sending messages:

```ts
await supacloud.queues.create("emails");
```

## API Mapping

| Previous SupaCloud API | New behavior |
| --- | --- |
| `queue.send(payload, options)` | Calls `pgmq_public.send`; returns numeric `msg_id` metadata. |
| `queue.sendBatch(messages, options)` | Calls `pgmq_public.send_batch`. |
| `queue.receive(options)` | Compatibility shortcut for `queue.read({ n: 1 })`. |
| `queue.read({ sleepSeconds, n })` | Calls `pgmq_public.read`. |
| `queue.pop()` | Calls `pgmq_public.pop`; the message is deleted immediately. |
| `queue.ack(messageId)` | Alias of `queue.archive(messageId)`. |
| `queue.archive(messageId)` | Calls `pgmq_public.archive`. |
| `queue.delete(messageId)` | Calls `pgmq_public.delete`. |
| `queue.release(messageId, options)` | SupaCloud extension backed by `pgmq.set_vt`. |
| `queue.fail(messageId)` | Compatibility alias that archives the message; PGMQ has no failed state. |
| `queue.get(messageId)` | Deprecated; PGMQ has no official random message lookup API. |
| `queue.retry(messageId)` | Deprecated; replay archived messages with SQL/application workflows. |
| `queue.listFailed()` | Diagnostic alias for archived-message inspection, not a PGMQ dead-letter state. |

## Behavior Differences

PGMQ changes the queue contract in several important ways:

- Message IDs are numeric `msg_id` values, not generated string IDs.
- `read` leases messages by changing their visibility timeout.
- `archive` is the official acknowledgement path.
- `pop` reads and deletes in one operation.
- PGMQ does not provide an official failed or retry state.
- Queue tables live under the `pgmq` schema and should not be treated as application tables.
- Delivery remains at-least-once. Consumers must stay idempotent.

## Migration Checklist

For existing SupaCloud deployments:

1. Upgrade management-api and tenant schema migration code.
2. Ensure the tenant PostgreSQL package set includes `pgmq`.
3. Apply the tenant schema migration so `pgmq_public` wrappers exist.
4. Restart or reload PostgREST with `pgmq_public` in `PGRST_DB_SCHEMAS`.
5. Upgrade `@supacloud/js`.
6. Replace direct queue retry/get assumptions with `read`, `archive`, `delete`, metrics, or application-level replay.
7. Make consumers use `message.msg_id` for `ack`, `archive`, `delete`, and `release`.

## Verification

Check tenant SQL:

```sql
select extname from pg_extension where extname = 'pgmq';
select nspname from pg_namespace where nspname = 'pgmq_public';
```

Check PostgREST RPC through `supabase-js`:

```ts
const { data, error } = await supabase
  .schema("pgmq_public")
  .rpc("send", {
    queue_name: "emails",
    message: { hello: "world" },
    sleep_seconds: 0,
  });

if (error) throw error;
console.log(data);
```

Check SupaCloud extensions:

```ts
await supacloud.queues.create("emails");
const stats = await supacloud.queue("emails").stats();
console.log(stats.queue_length);
```

## Rollback Notes

This migration is additive at the database level. Rolling back the application code does not require dropping `pgmq` or `pgmq_public`.

If a rollback is needed:

1. deploy the previous management-api and SDK versions
2. keep `pgmq` installed to avoid breaking tenants that already created queues
3. keep `pgmq_public` exposed until all clients have stopped using official Supabase Queues RPCs
