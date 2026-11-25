# ADR: Realtime CDC consumes the tenant's replication slot

## Status

Accepted. Phase 1 is implemented in `crates/realtime-gateway` and covered by
fixtures. Merging this record does not deploy anything.

## Context

The native Rust Realtime gateway served `postgres_changes` by `LISTEN`ing on a
`realtime_changes` NOTIFY channel per tenant. Three facts made that a dead end:

- Nothing publishes that channel. The only code that created the triggers
  (`CREATE TRIGGER … PERFORM realtime.notify_change_payload(payload)`) lived in
  `packages/management-api/src/internal/realtime-listen`. That directory and
  `realtime.notify_change_payload` are removed. The tenant-schema reconciler
  still drops the legacy function where an older database has it.
- The platform's real change stream is the upstream one: a `supabase_realtime`
  publication and a `wal2json` replication slot per tenant, read by the official
  Elixir Realtime through `realtime.list_changes` / `realtime.apply_rls`. The
  acceptance fixture asserts that slot exists
  (`packages/management-api/tests/fixtures/platform-gateway-smoke.ts`).
- The installer default is this gateway on port 4000.
  `SUPACLOUD_REALTIME_ENGINE=container` is the explicit Elixir rollback and is
  the only path that starts that container. The gateway is the Realtime server
  behind `REALTIME_ADMIN_URL`, so it has to honour that contract rather than
  keep a second, unpopulated stream.

A NOTIFY channel also caps a payload at 8000 bytes and never sees replica
identity, so the two mechanisms were never equivalent.

## Decision

The gateway is the consumer of the tenant's **single** `wal2json` slot for the
`supabase_realtime` publication. `crates/realtime-gateway/src/wal.rs` decodes the
slot with the decoding options of the official `realtime.list_changes.sql`
(upstream `realtime` 2.150.0, sha256 `24bcf1db…`): `include-pk`,
`include-transaction=false`, `include-timestamp`, `include-type-oids`,
`format-version=2`, plus `actions` and `add-tables` derived from the publication.
Same slot, same options, one change stream.

The gateway owns consumption only:

- It never creates publications, tables, triggers or any tenant-schema object.
  Publication membership stays with the Management API and the upstream
  realtime schema stays with its reconciler.
- It creates the slot only when the database has none, and it **adopts** an
  existing one (upstream names slots `supabase_realtime_<ref>_<suffix>`) instead
  of creating a second, which would retain the same WAL twice.
- It connects with the registration payload's `db_user` (`supabase_admin`, which
  already carries `REPLICATION` and is the identity upstream Realtime uses). No
  data-plane role connects for CDC.
- The published NOTIFY channel is retired. A `pg_notify('realtime_changes', …)`
  is not a source of deliveries, and the fixtures assert that.

`realtime.list_changes` routes every change through `realtime.apply_rls`, which
drops changes whose `subscription_ids` are empty. On `phx_join` the gateway
inserts the caller's JWT claims into the tenant `realtime.subscription` table
and deletes those rows on leave or disconnect. `anon` and `authenticated`
receive a row only when `apply_rls` returns their subscription id. A join that
cannot store the row is refused. Decoded WAL is not delivered in its place.

`apply_rls` reports an oversized record as `Error 413` instead of this gateway
truncating the row itself.

## Consequences

- One slot per tenant, one publication, one realtime schema ledger. A second
  consumer of the same slot would split the stream between processes, so nothing
  else may poll a tenant's slot while this gateway runs.
- A tenant whose database lacks the `wal2json` output plugin gets no CDC and a
  loud failure at slot creation, not a silent empty stream. PostgreSQL 17 and
  later also need the plugin in `output_plugin_libraries`.
- A stalled poller retains WAL. The poller is paced by `poll_interval_ms` from
  the registration payload and never holds a transaction open while idle.
- `packages/management-api/src/internal/realtime-listen` and
  `realtime.notify_change_payload` are removed. `realtime.ensure_tasks_publication`
  stays: it puts `public.tasks` on `supabase_realtime`, which this slot reads.
- `PUBLIC_REALTIME_SOCKET_OWNER` is `rust-realtime-gateway`. Elixir is not the
  hosted default.
- `anon` and `authenticated` `postgres_changes` are delivered only through
  `realtime.subscription` and `realtime.apply_rls`. The fixture
  `row_level_security_hides_a_row_from_another_role` covers a negative case.
- Those objects are official Realtime schema, not SupaCloud SQL. The pinned
  2.150.0 tree lives at
  `packages/management-api/src/db/realtime-tenant-schema/2.150.0/` and is the
  artifact both project bootstrap and the CDC fixture install. Every file and
  the tree are sha256-pinned. With the Rust gateway as the default, bootstrap
  installs that tree when the `realtime` schema is empty or
  `realtime.list_changes(name, name, integer, integer)` is absent. An exact pin
  is a no-op. A database that already has `realtime.list_changes` is left
  alone, including an Elixir-migrated tenant whose catalog differs from the
  pin. `SUPACLOUD_REALTIME_ENGINE=container` still leaves the install to Elixir.

## Evidence

`crates/realtime-gateway/tests/cdc.rs` starts a cluster with `wal_level=logical`,
installs the pinned Realtime 2.150.0 tenant schema from the shared artifact,
creates the publication and
two tables (one deliberately outside it), registers a tenant with the Management
API's registration payload, and writes rows. It asserts insert/update/delete
payloads (`record`, `old_record` identity, `columns`, ISO 8601
`commit_timestamp`, matching `ids`), subscription scoping, a `task=eq.keep`
column filter, tenant-database isolation, and that the retired NOTIFY channel
delivers nothing. `row_level_security_hides_a_row_from_another_role` subscribes
as `authenticated` (two subjects), `anon`, and `service_role`, and asserts that
a private row is delivered only to its owner and to `service_role`. A missing
`wal2json` plugin fails the fixture; CI installs it rather than skipping.

`tests/integration/realtime-tenant-schema-bootstrap.test.ts` starts from an
empty `realtime` schema on PostgreSQL 18, applies the pinned artifact, and
checks `realtime.subscription` ownership, a subscription row, a second pass
that keeps the same `list_changes` OID, and that a substituted `list_changes`
body stays in place.
