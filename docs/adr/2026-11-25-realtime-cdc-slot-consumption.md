# ADR: Realtime CDC consumes the tenant's replication slot

## Status

Accepted. Phase 1 is implemented in `crates/realtime-gateway` and covered by
fixtures. Merging this record does not deploy anything.

## Context

The native Rust Realtime gateway served `postgres_changes` by `LISTEN`ing on a
`realtime_changes` NOTIFY channel per tenant. Three facts made that a dead end:

- Nothing publishes that channel. The only code that created the triggers
  (`CREATE TRIGGER … PERFORM realtime.notify_change_payload(payload)`) was
  `packages/management-api/src/internal/realtime-listen`, which is deliberately
  not wired into the Management API, and the tenant-schema reconciler drops the
  legacy function.
- The platform's real change stream is the upstream one: a `supabase_realtime`
  publication and a `wal2json` replication slot per tenant, read by the official
  Elixir Realtime through `realtime.list_changes` / `realtime.apply_rls`. The
  acceptance fixture asserts that slot exists
  (`packages/management-api/tests/fixtures/platform-gateway-smoke.ts`).
- `install.sh` (`SUPACLOUD_REALTIME_ENGINE=rust`) stops and decommissions the
  Elixir container and binds this gateway to port 4000. In that mode the gateway
  *is* the Realtime server behind `REALTIME_ADMIN_URL`, so it has to honour that
  contract rather than keep a second, unpopulated stream.

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

Deliberate divergence inside phase 1: `realtime.list_changes` routes every change
through `realtime.apply_rls`, which drops changes whose `subscription_ids` are
empty because upstream keeps subscriptions in the tenant's
`realtime.subscription` table. This gateway keeps subscriptions in memory, per
socket, so that indirection has nothing to match against. `postgres_changes`
therefore stays `service_role`-only (`server.rs` refuses it for other roles) and
RLS is not applied on this path. Logical decoding does not apply RLS; that
refusal, not a hidden filter, is what keeps other roles out.

A record larger than the poll budget (`poll_max_record_bytes`) is dropped with a
log line instead of being truncated per row as `apply_rls` does. Truncation
changes the row the client sees; a dropped change is visible in the log.

## Consequences

- One slot per tenant, one publication, one realtime schema ledger. A second
  consumer of the same slot would split the stream between processes, so nothing
  else may poll a tenant's slot while this gateway runs.
- A tenant whose database lacks the `wal2json` output plugin gets no CDC and a
  loud failure at slot creation, not a silent empty stream. PostgreSQL 17 and
  later also need the plugin in `output_plugin_libraries`.
- A stalled poller retains WAL. The poller is paced by `poll_interval_ms` from
  the registration payload and never holds a transaction open while idle.
- `packages/management-api/src/internal/realtime-listen`,
  `realtime.notify_change_payload` and its publication helpers are now dead
  weight. Removing them is the next change, not this one.
- `packages/management-api/src/services/realtime-public-contract.ts` still names
  Elixir as the socket owner. With `SUPACLOUD_REALTIME_ENGINE=rust` the owner is
  this gateway; the constant is stale, not load-bearing.
- Authenticated (`anon` / `authenticated`) `postgres_changes` delivery needs
  tenant-side subscription rows and `realtime.apply_rls`. Until then the refusal
  stands; it is not a compatibility gap to be papered over.

## Evidence

`crates/realtime-gateway/tests/cdc.rs` starts a cluster with `wal_level=logical`,
creates the publication and two tables (one deliberately outside it), registers a
tenant with the Management API's registration payload, subscribes as
`service_role`, and writes rows. It asserts insert/update/delete payloads
(`record`, `old_record` identity, `columns`, ISO 8601 `commit_timestamp`, matching
`ids`), subscription scoping, a `task=eq.keep` column filter, tenant-database
isolation, and that the retired NOTIFY channel delivers nothing. A missing
`wal2json` plugin fails the fixture; CI installs it rather than skipping.
