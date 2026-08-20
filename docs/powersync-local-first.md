# PowerSync Local-First Integration

PowerSync is the selected external Local-First integration for SupaCloud
applications that require a durable local SQLite database, offline writes, and
recovery after weak or unavailable networks. Full SupaCloud exposes read-only
replication readiness. Native Lite additionally provides an explicit
`powersync` source profile. Neither runtime starts or stops PowerSync, and
neither creates or deletes PowerSync replication slots.

Use the official PowerSync Supabase integration and self-hosting documentation
for the exact release-specific service configuration:

- <https://docs.powersync.com/integrations/supabase/guide>
- <https://docs.powersync.com/configuration/powersync-service/self-hosted-instances>

## Responsibility boundary

SupaCloud owns PostgreSQL, Auth, RLS, application RPCs, Logical Replication
prerequisites, and read-only operational evidence. PowerSync owns the local
SQLite client database, download synchronization, and the client upload queue.
The application owns synchronization rules, mutation APIs, conflict semantics,
and domain state transitions.

PowerSync synchronization rules determine which rows are downloaded. They do
not authorize uploads. Every uploaded mutation must return through a SupaCloud
Data API or application RPC, where RLS and business transition checks run again.
Never place a service-role key or replication credential in a client.

## Self-hosted deployment baseline

Run PowerSync as a separately versioned service, not inside the Management API
or an Edge Function. A production deployment needs four explicit inputs:

1. a direct PostgreSQL replication connection to the SupaCloud project;
2. a separate PowerSync bucket storage database;
3. a reviewed Sync Streams file scoped by authenticated tenant membership; and
4. JWKS-based client token verification with a pinned audience.

The pinned PowerSync release owns its image and configuration schema. Pin the
container image by immutable digest, mount `service.yaml` and
`sync-config.yaml` read-only, and inject only `PS_`-prefixed secrets from the
deployment secret store. The following is a shape reference, not a substitute
for validating the configuration against the pinned release:

```yaml
replication:
  connections:
    - type: postgresql
      uri: !env PS_SOURCE_DATABASE_URI
      sslmode: verify-full

storage:
  type: postgresql
  uri: !env PS_BUCKET_STORAGE_URI
  sslmode: verify-full

port: 80
sync_config:
  path: /config/sync-config.yaml

client_auth:
  jwks_uri: !env PS_JWKS_URI
  audience:
    - supacloud-powersync
```

Bucket storage is not the replication source. Use a separate database and
dedicated owner; a separate PostgreSQL server is preferred in production to
keep synchronization load and failure recovery isolated. Put the API behind
the platform TLS ingress, restrict operational endpoints to the internal
network, and monitor service restarts, source lag, bucket storage capacity,
upload failures, and retained WAL.

Roll out in this order: prepare the source role and publication, deploy bucket
storage, validate Sync Streams against a non-production tenant, start the
pinned PowerSync service, read back its exact slot from the SupaCloud
replication endpoint, then enable token issuance for a small client cohort.
SupaCloud never creates the slot on the service's behalf.

## SupaCloud Lite boundary

PGlite is not a PowerSync replication source and `supacloud-lite doctor --json`
reports both `logical_replication` and `powersync_source` as `unsupported`.
Do not emulate PostgreSQL replication catalogs or infer readiness from Lite
Realtime. For a single field workstation, PGlite can remain the local
single-project server. For multiple offline devices, use one of these explicit
topologies:

1. clients synchronize through central SupaCloud + PowerSync;
2. Native Lite runs the opt-in PowerSync profile on the site server; or
3. an application-owned idempotent outbox uploads PGlite data to central
   SupaCloud, which remains the PowerSync source.

Native Lite keeps replication disabled by default. Enable it only with an
explicit table allowlist and a secret-store password:

```bash
export SUPACLOUD_LITE_POWERSYNC_PASSWORD='<at-least-32-characters>'
supacloud-lite migrate \
  --engine native \
  --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations
```

The default profile listens on `127.0.0.1:54322`, uses SCRAM, creates the
dedicated `supacloud_powersync` role and explicit `powersync` publication, and
sets bounded capacity: four WAL senders, four replication slots, and 1024MB
maximum retained WAL per slot. It never creates a slot. A non-loopback listener
is rejected unless TLS certificate/key files and explicit client CIDRs are
provided. Keep the default loopback connection when PowerSync shares the host;
otherwise terminate and verify PostgreSQL TLS rather than exposing plaintext
database traffic.

After migration, inspect the live native catalog without slot DDL:

```bash
supacloud-lite doctor --json \
  --engine native \
  --replication-profile powersync \
  --powersync-tables public.eln_entries,public.eln_observations
```

The report includes the stable Lite capability fields plus
`powersync_readiness`: connection/TLS policy, WAL and slot capacity, role
attributes, exact publication tables, replica identity blockers, and existing
logical slot health. `ready=true` remains a source preflight, not proof that the
PowerSync service, tokens, Sync Streams, uploads, or clients are correct.

## Readiness inspection

Project administrators can inspect the existing read-only endpoint:

```text
GET /v1/projects/:ref/database/replication
```

The endpoint preserves `replication_slots` and `publications`, and adds:

- `replication_settings`: `wal_level`, `max_wal_senders`,
  `max_replication_slots`, `max_slot_wal_keep_size`, `wal_keep_size`,
  `max_wal_size`, `checkpoint_timeout`, and
  `idle_replication_slot_timeout` when supported by the server;
- `replication_setting_details`, including units, configuration source, and
  whether a restart is still pending;
- WAL sender `configured`, `active`, and `free` capacity from
  `pg_stat_replication`;
- slot `retained_wal_bytes`, `unconfirmed_wal_bytes`, `wal_status`,
  `safe_wal_size`, inactivity, failover, conflict, and invalidation evidence;
- publication table count, DML flags, and tables missing a usable replica
  identity;
- `powersync_readiness`, with provisioning blockers and operational warnings.

`powersync_readiness.ready` is a provisioning preflight. It means the database
currently has logical WAL, one free WAL sender, one free replication slot, and
an explicit `powersync` publication with tables, INSERT/UPDATE/DELETE enabled,
and usable replica identity. It does not prove that an already-running
PowerSync instance is healthy, or that authentication, Sync Streams, network
routing, and client upload handlers are correct.

Blocker codes are:

- `WAL_LEVEL_NOT_LOGICAL`
- `WAL_SENDERS_DISABLED`
- `NO_FREE_WAL_SENDER`
- `REPLICATION_SLOTS_DISABLED`
- `NO_FREE_REPLICATION_SLOT`
- `NO_PUBLISHED_TABLES`
- `POWERSYNC_PUBLICATION_MISSING`
- `POWERSYNC_PUBLICATION_EMPTY`
- `POWERSYNC_PUBLICATION_DML_INCOMPLETE`
- `POWERSYNC_REPLICA_IDENTITY_INCOMPLETE`

Warning codes are:

- `POWERSYNC_PUBLICATION_ALL_TABLES`
- `INVALID_LOGICAL_SLOTS`
- `LOGICAL_SLOT_WAL_UNRESERVED`
- `LOGICAL_SLOT_SAFE_WAL_EXHAUSTED`
- `SLOT_WAL_KEEP_SIZE_UNBOUNDED`
- `SLOT_WAL_KEEP_SIZE_ZERO`
- `REPLICATION_SETTINGS_PENDING_RESTART`

The Docker self-host baseline configures `wal_level=logical`,
`max_wal_senders=10`, and `max_replication_slots=10`. Realtime, pipelines, and
other CDC consumers share that cluster-level slot capacity, so do not allocate
the final free slot without a capacity and rollback plan.

Treat `wal_status=unreserved`, `wal_status=lost`, a non-null
`invalidation_reason`, or `safe_wal_size=0` as an incident. A lost slot cannot
resume from removed WAL; stop the affected deployment, determine the exact
recorded slot, and follow the pinned PowerSync resnapshot procedure. Do not
drop and recreate a slot merely to clear the warning.

Alert on a rising `unconfirmed_wal_bytes`, falling `safe_wal_size`, an inactive
slot that still retains WAL, and any requested replication setting with
`pending_restart=true`. Bytes are returned as decimal strings so JavaScript
does not lose PostgreSQL `bigint` precision.

## Database preparation

Run database mutations through a reviewed application migration or an explicit
operator procedure. Do not expose replication management through browser or
general-purpose application APIs.

Use a dedicated login role with `REPLICATION BYPASSRLS`, database `CONNECT`,
schema `USAGE`, and `SELECT` only on tables that PowerSync must snapshot. Do not
reuse `supabase_admin`, a service role, or an application owner. Keep its
password in the PowerSync secret store, not Git or migration files. Because
the replication role bypasses RLS, publication and Sync Streams allowlists are
mandatory data-exposure boundaries for downloads.

Create a dedicated publication containing an explicit allowlist of tables:

```sql
CREATE PUBLICATION powersync FOR TABLE
  public.eln_entries,
  public.eln_observations,
  public.eln_attachments;
```

For tables whose updates or deletes must include the previous row identity,
configure an appropriate primary key and replica identity. Avoid
`FOR ALL TABLES`; replication bypasses application RLS and the sync service can
observe every row in its publication before applying client-specific rules.

Before adding a table, verify that it has a primary key or an explicit replica
identity and that every published column needed by Sync Streams remains
available. The readiness endpoint treats default replica identity without a
primary key, `REPLICA IDENTITY NOTHING`, and an invalid identity index as
incomplete.

Let the selected, pinned PowerSync deployment own its configured slot. Record
the exact slot name, publication, PowerSync release, database, and deployment
identity before activation. Never guess a slot name during cleanup.

## Auth and upload path

The client authenticates with SupaCloud Auth and obtains a PowerSync token from
a trusted backend endpoint. That endpoint maps the authenticated user to a
tenant, project, and permitted sync scope. Sync rules should mirror the same
membership model used by RLS, but RLS remains authoritative for writes.

Uploaded changes should call narrow RPCs. For business state changes, use the
pattern in [Application Business State Machines](./business-state-machines.md):

```text
local outbox event
  -> authenticated application RPC
  -> RLS and membership check
  -> row lock, expected version, idempotency, transition matrix
  -> PostgreSQL commit
  -> Logical Replication back to every authorized client
```

An offline approval is only an `approval_requested` outbox item. The local
domain record must not become `approved` until the server accepts the RPC and
the confirmed state returns through synchronization.

## ELN conflict model

Do not apply one generic last-write-wins policy to laboratory data.

| Data | Recommended merge rule |
| --- | --- |
| Raw observations and instrument readings | Append-only, client UUID plus idempotency key |
| Corrections | New row with `supersedes_id`; never overwrite the original |
| Draft narrative fields | Field-level merge or explicitly accepted last-write-wins |
| Attachments | Durable outbox, content checksum, immutable object identity |
| Assignment | Expected row version and server-authoritative transition |
| Approval, signing, delivery | Online server confirmation only |

Every offline-created row should carry a client-generated UUID, `device_id`,
local sequence, capture timestamp, server receipt timestamp, and idempotency
key. Preserve both device and server time because field devices can have an
incorrect clock.

## Schema evolution

Use expand-contract migrations because old mobile clients and the PowerSync
service may continue reading the previous shape during rollout:

1. add nullable columns, new tables, indexes, and replica identity first;
2. add the table to the explicit `powersync` publication only after grants and
   Sync Streams are ready;
3. deploy backward-compatible upload RPCs and Sync Streams;
4. deploy clients that can read both shapes and write only the new contract;
5. backfill in bounded batches and observe replication lag;
6. stop old writes, enforce new constraints, then remove obsolete columns in a
   later release.

Never rename or drop a published column in the same release that introduces
its replacement. Remove a table from Sync Streams and the publication only
after supported clients no longer depend on it.

## Verification before adoption

Validate with production-shaped but non-production data:

1. Initial snapshot and incremental download are scoped to one authorized
   project.
2. A removed member loses token issuance and cannot upload; synchronized local
   data follows the application's revocation policy.
3. Twenty-four hours offline can enqueue, restart, and later upload without
   duplication.
4. Two devices editing the same draft produce the documented conflict result.
5. Duplicate mutation delivery is idempotent.
6. An offline Maker cannot approve their own record or bypass expected version.
7. Slot retained WAL remains bounded during a stopped or disconnected service.
8. Schema migrations are applied in an expand-contract order compatible with
   the pinned PowerSync release and existing clients.
9. A forced slot interruption produces a visible warning and follows the
   documented resnapshot path without deleting an unrelated slot.

Record evidence for each independent plane rather than treating source
readiness as end-to-end acceptance:

- **JWKS and custom auth:** issue a token with the pinned PowerSync audience,
  verify accepted and rejected issuer/audience/key-rotation cases, and confirm
  removed membership prevents new token issuance.
- **Sync Streams:** validate the pinned service configuration against two
  tenants and prove that each initial snapshot and incremental change remains
  inside its membership scope.
- **RLS writeback:** upload through authenticated narrow RPCs, then test tenant
  denial, Maker-Checker separation, stale row version, duplicate idempotency
  keys, and immutable artifact handling.
- **Resnapshot:** stop the test service until its bounded slot becomes invalid,
  capture `doctor`/Management API evidence, follow the pinned PowerSync
  resnapshot procedure, and prove no unrelated slot or publication was changed.

## Disable and cleanup

Cleanup is an explicit operator action:

1. Stop issuing new PowerSync tokens.
2. Drain or intentionally abandon client outboxes according to the incident or
   retirement plan.
3. Stop the exact PowerSync deployment and confirm it will not reconnect.
4. Read back the configured slot, `active` state, restart LSN, and retained WAL
   bytes from the replication endpoint.
5. Back up required audit and application data.
6. Drop only the recorded inactive slot and publication using an approved
   database procedure.
7. Read back slot/publication inventory and WAL retention after cleanup.

SupaCloud intentionally does not automate steps 3 through 6 because deleting a
live slot can break synchronization, while retaining an abandoned slot can
exhaust disk through unbounded WAL retention.
