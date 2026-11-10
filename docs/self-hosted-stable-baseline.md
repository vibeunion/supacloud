# Self-Hosted Stable Baseline

[English](self-hosted-stable-baseline.md) | [简体中文](self-hosted-stable-baseline.zh-CN.md)

> Status: product boundary and acceptance contract
>
> Updated: 2026-10-04

This document makes the primary SupaCloud product explicit:

> **SupaCloud is a self-hosted multi-project application platform.**

It lets a team operate multiple isolated Supabase-style projects on its own
infrastructure through one control plane, console, operator CLI, project CLI,
delivery path, observability surface, upgrade procedure, and recovery process.

The application framework, compiler, SDK, and AI tooling are optional
application-development layers. They improve how a project is built; they are
not prerequisites for operating the platform or deploying an application that
uses the documented Supabase-compatible protocols.

This is a release boundary, not a claim that every item below has passed a
production installation, upgrade, or recovery drill.

## Product hierarchy

| Layer | Product role | Requirement for full-platform use |
| --- | --- | --- |
| Full Platform | Primary product: self-hosted project control, runtime, delivery, operations, upgrade, and recovery | Required for the multi-project platform workflow |
| Admin, Console, and project CLI | Standard operator and developer entrypoints | Required to make the platform operable without repository access |
| Application framework, compiler, SDK, and AI tools | Optional development acceleration and stronger application contracts | Not required |
| Lite | Local-first and small single-project runtime | Separate bounded product; not proof of full-platform production readiness |

Do not describe these as interchangeable editions of one framework. The
platform is the product; application engineering is an optional layer on top.

## Supported baseline

The first stable release should publish one primary deployment profile:

| Dimension | Baseline |
| --- | --- |
| Host | Linux with systemd |
| Primary OS acceptance target | Ubuntu 24.04 LTS |
| Primary architecture acceptance target | `amd64` |
| Database substrate | Pigsty `v4.5.0`, PostgreSQL 18 |
| Gateway | SupaCloud-managed Caddy systemd service |
| Platform runtime | Management API, Web Console, project runtimes, and VictoriaLogs |
| Storage | JuiceFS with PostgreSQL metadata, unless a project explicitly binds a supported S3-compatible backend |
| Artifact mode | Published, checksum-verified, provenance-verified release artifacts |
| HA claim | None for the single-host baseline |

The installer also contains compatibility paths for other operating systems
and `arm64`. Those paths must be documented and tested separately; they are not
implicitly equal to the primary baseline. Compose and Lite remain supported
within their own documented boundaries and are not alternative proofs of this
release's full-platform acceptance.

The primary acceptance run must record the selected Edge Runtime mode. The
coordinated Management/Web Console/Edge Runtime upgrade path requires
`EDGE_RUNTIME_MODE=external`; embedded mode is not silently treated as
equivalent upgrade evidence. Caddy and GoTrue remain separate upgrade surfaces.

## Support matrix

| Area | Status | Boundary and evidence |
| --- | --- | --- |
| Native single-host Full Platform | Stable baseline target | Ubuntu 24.04 LTS, `amd64`, systemd, Pigsty `v4.5.0` / PostgreSQL 18, SupaCloud-managed Caddy, and published verified artifacts; Gates 2-4 are still required before claiming production acceptance |
| Lite | Separate bounded product | Single-project local-first runtime with its own compatibility and recovery evidence; not evidence for Full Platform readiness |
| Compose and other installer paths | Deployment-specific / separate acceptance | `docker/self-host` is one GoTrue and one PostgREST. It is not evidence of multi-project Pigsty behavior. Follow the documented boundary; do not treat it as equivalent proof of the native baseline |
| `arm64` and other operating systems | Deployment-specific / separate acceptance | Require explicit installation, upgrade, and recovery evidence for the selected combination |
| External S3 project storage | Deployment-specific / separate acceptance | Requires an explicit project binding and provider-specific reachability, durability, and recovery evidence |
| Embedded Edge Runtime in a coordinated upgrade | Experimental / separate acceptance | The primary coordinated upgrade evidence uses persisted `EDGE_RUNTIME_MODE=external` |
| Control-plane brief outage | Local serving contract | Authenticated REST, Auth, synchronous Functions, and the storage data plane. Not HA. Realtime, opaque keys, and embedded Edge Runtime stay coupled to the Management API. See [control-plane outage](control-plane-outage.md). |
| HA, multi-node scheduling, and multi-region operation | Out of scope for the single-host baseline | Require independent failover, capacity, upgrade, and recovery evidence |
| Application framework, compiler, SDK, and AI tooling | Optional development layer | Useful for application delivery and contracts, but not required to operate a platform project |

“Stable baseline target” describes the intended release profile, not completed
production proof. A release is only accepted after the relevant gates produce
dated evidence on a real host. Gates 2–4 and HA are not production-passed
until that record exists. Merging the change is not that record.

## Platform boundaries

### Control plane

The control plane owns:

- project identity, ownership, status, and resource bindings
- project and platform configuration
- release and activation records
- operation intent, progress, outcome, and reconciliation
- backup inventory, restore plans, and restore receipts
- authorization, audit, and operator-facing diagnostics

Every mutating operation should follow this semantic sequence:

1. Validate authorization and preconditions.
2. Persist the operation intent and stable mutation identity.
3. Execute only the steps that are safe to retry.
4. Read back actual resource state.
5. Reconcile a lost or unknown response before allowing a new mutation.
6. Report success, a recoverable failure, or an outcome requiring operator action.

The platform should extend existing project lifecycle and release contracts.
It must not introduce a second project ledger, source-control system, or
general workflow engine merely to unify names.

### Data plane

The data plane carries project traffic through the gateway to project database,
REST, Auth, Storage, Realtime, Functions, and worker resources.

Authenticated REST and Auth are published directly to PostgREST and GoTrue.
Functions and Storage prefer the Management API and fail over to Edge Runtime
and the storage data-plane process when that listener refuses the connection.
Realtime still enters the Management API. The local contract, its limits, and
the measurements from the only executed drill are in
[control-plane brief outage](control-plane-outage.md). That drill is not a
production failure test and does not make the single-node baseline highly
available.

### Infrastructure

Pigsty remains the database infrastructure provider. SupaCloud owns the
project-level product contract: isolation, routing, runtime lifecycle,
cross-component delivery, operator workflows, and complete recovery
acceptance. PostgreSQL HA, pgBackRest, WAL transport, and node primitives
should be consumed through explicit provider contracts rather than reimplemented
inside the platform.

## Release vocabulary

Use separate records and acceptance for:

| Term | Meaning |
| --- | --- |
| Platform release | A verified combination of Management API, Web Console, runtime artifacts, configuration contract, and supported component versions |
| Project application release | An immutable project artifact set such as functions, frontend assets, runtime configuration, and migration inventory |
| Infrastructure upgrade | A Pigsty, PostgreSQL, Caddy, GoTrue, Realtime, storage, or operating-system change with its own migration and rollback boundary |
| Restore receipt | Evidence that a specified snapshot was restored and verified, including measured RPO/RTO and unresolved deviations |

A binary rollback does not undo a database migration or an external side
effect. A project restore is not the same as a cluster PITR. A successful
backup inventory is not a successful recovery.

## Four acceptance gates

### Gate 1: Product and support boundary

Deliver:

- the primary product statement in the root README and documentation index
- one support matrix with stable, experimental, and out-of-scope labels
- a clear distinction between Full Platform, Lite, and application engineering
- a list of supported OS, architecture, component pins, and HA limitations

Pass condition: a new operator can choose the correct entrypoint and knows
which deployment profile can be relied on.

### Gate 2: Clean installation and two-project operation

Use a fresh host and a published release bundle. Create two representative
projects:

1. A project using the standard Supabase client and platform APIs only.
2. A project using the optional SupaCloud application framework.

Verify for both projects:

- project creation has no untracked or unexplained partial resources
- database, Auth, REST, Storage, routing, and Functions are project-scoped
- one project cannot read, route to, or mutate the other project
- migrations and function releases have immutable identities and read-back
- logs and project status expose a diagnosable failure state
- a host restart returns the platform and both projects to the expected state

The first project is the proof that the platform does not require
`@supacloud/app`.

### Gate 3: Stateful platform upgrade

Start from the previous supported platform bundle with representative data and
configuration. The evidence must identify:

- source and target platform release manifests
- all component versions and artifact digests
- database migration inventory and compatibility conclusion
- backup and preflight result
- each component's activation and health read-back
- actual observation timeout or interruption handling
- rollback target and the remaining manual recovery path

The first baseline may upgrade Management API and Web Console separately from
Caddy, GoTrue, Realtime, or PostgreSQL, but the release notes must say so
explicitly.

### Gate 4: Independent full-project recovery

Restore into a new environment from an approved snapshot stored independently
from the source host. Verify:

- database state and migration/component alignment
- object files and storage namespace
- runtime metadata, secrets, and project identity
- Auth and authorization boundaries
- active routes and function execution
- queues, logs, and audit records where included in the snapshot
- cross-project isolation
- measured RPO, measured RTO, and every unresolved deviation

Synthetic local restore fixtures are valuable for regression testing but do not
establish production recovery guarantees.

## Evidence states

Every acceptance record must label its state explicitly:

| State | Meaning |
| --- | --- |
| Implemented | Source code or documentation exists |
| Locally verified | A deterministic local test or fixture passed |
| Release verified | The published artifact and manifest were verified |
| Deployed | A named host accepted the artifact and returned health evidence |
| Accepted online | An authenticated representative workflow passed on the target |
| Incomplete | Required evidence is missing, unknown, or interrupted |

Do not collapse these states into a single maturity percentage. A green unit
test, a merged pull request, a deployment, and a recovery drill prove different
things.

## Operator acceptance after secret encryption and the package reshape

Merging a pull request is not a production deploy (合码≠上线). Gates 2–4 and
high availability are claimed only after a dated pass on a real host. Do not
describe them as production-passed before that record exists.

`docker/self-host` runs one GoTrue and one PostgREST next to one PostgreSQL
container. That boot is not evidence of multi-project Pigsty behavior.
Multi-project isolation is the systemd and Pigsty profile: one database per
project, with per-project PostgREST and GoTrue.

The `app init`, ZenStack, and Angular rows are the intended post-merge gates
for that reshape. Accept them on a revision that contains it. This checklist
does not publish packages or deploy a host.

| Gate | Pass condition |
| --- | --- |
| Tenant secrets | `db_password`, `jwt_secret`, `anon_key`, `service_role_key`, and `s3_secret_key` are stored only in `*_encrypted` columns. Lookup uses `anon_key_hash` and `service_role_key_hash` (the opaque key already uses `secret_key_hash`). Startup copies leftover plaintext into ciphertext, checks a decrypt round trip, then clears the plaintext columns. Create responses may still return a secret once from process memory. |
| CONNECT | New and branch databases `REVOKE CONNECT` from `PUBLIC` and from `supabase_realtime_admin`. `role_<ref>` and `authenticator_<ref>` receive `CONNECT` only on their own database. |
| HBA pairing | Pigsty inventory admits `authenticator_<ref>` and `role_<ref>` from `127.0.0.1/32` only when they are members of the NOLOGIN role whose name is the database (`samerole`), then rejects every other loopback login of those name patterns. See the re-apply steps below. |
| Cluster LOGIN audit | `supabase_auth_admin` and `supabase_admin` keep their names. `GET /v1/system/cluster-login-audit` (admin) lists current sessions by role, database, client address, application name, and state. It does not return the cluster password or query text. History is the PostgreSQL `connection authorized` line after `log_connections=on` on those roles, plus `supacloud_cluster_login` in the tenant log. A leaked cluster password can still open every tenant database as these roles. Audit is not isolation. |
| Default app init | `supacloud app init` scaffolds `@supabase/supabase-js` only. The compiler, Effect, and `@supacloud/app` stack is `app init --template app`. |
| ZenStack | ZenStack lives in `@supacloud/db-zenstack`. The Management API production closure does not install or import ZenStack. `@supacloud/db` does not depend on it. |
| Angular boundary | The injector and the `HttpClient` that calls `inject()` live at `@supacloud/app/runtime`. `@supacloud/app`, `@supacloud/app/core`, `@supacloud/app/http`, and `@supacloud/app/pending-work` stay Angular-free. |
| Compose vs Pigsty | A `docker/self-host` boot is not recorded as a Gate 2 two-project Pigsty pass. |
| Realtime share | The Elixir Realtime `:4000` production traffic share stays uncounted until the measurement table below is filled. |
| Gates 2–4 and HA | Claimed only from a dated pass on a named real host, not from this document or a merged pull request. |

### Re-applying HBA pairing

Pigsty owns `/pg/data/pg_hba.conf` and regenerates it from `pg_hba_rules`.
SupaCloud only inserts or replaces the titled SupaCloud lines. A later Pigsty
upgrade, a copied inventory, or an earlier rule that already admits every
loopback user restores an unpaired pattern: PostgreSQL matches the user and
database fields separately, so `authenticator_A` can again satisfy HBA for
`supa_B`. `CONNECT` grants remain, and they are a weaker control.

Grant the samerole membership before re-applying the reject rules. Management
API startup and `scripts/upgrade_pigsty_4_4_compat.sh --apply` grant membership
of the NOLOGIN role named exactly as the database, `WITH INHERIT FALSE, SET
FALSE`, to `authenticator_<ref>` and `role_<ref>`. That role must not receive
privileges. Applying the reject rules first refuses tenant logins until the
grant exists.

```bash
cd /path/to/supacloud
PIGSTY_PATH="${PIGSTY_PATH:-$HOME/pigsty}" bash -c 'source ./install.sh && ensure_pigsty_tenant_hba_rule'
```

Sourcing `install.sh` loads the function and does not run the installer.
Afterwards the inventory has `db: samerole` on the authenticator and role
allows, `auth: reject` on the unpaired rules, and no `/^supa_` database
regex. `::1` stays outside this loopback rule.

`supabase_auth_admin` and `supabase_admin` are not renamed. GoTrue still
connects as `supabase_auth_admin`. Realtime CDC still connects as
`supabase_admin`. A PostgreSQL role has one cluster-wide password, so those
names cannot have per-project passwords. Shell helpers that do not connect as
the cluster role no longer receive `PGPASSWORD`, `PG_PASSWORD`, or
`POSTGRES_PASSWORD`. Realtime error logs redact `db_password` fields and URI
passwords. Neither change isolates the cluster roles.

### Elixir Realtime :4000 traffic share

No repository metric counts how much production websocket traffic still enters
the Elixir Realtime listener (upstream default port 4000). Leave the value
`uncounted` until a real host supplies it. Any claim about that share is
conditional on a filled row. Do not invent a percentage.

| Measurement | Value | Host | Date | Method |
| --- | --- | --- | --- | --- |
| Elixir Realtime `:4000` share of production websocket traffic | uncounted | | | |

## Non-goals for the baseline

The baseline does not promise:

- every Linux distribution or CPU architecture
- HA or multi-node scheduling on the single-host profile
- control-plane survival beyond the [brief-outage contract](control-plane-outage.md), including Realtime, opaque keys, embedded Edge Runtime, and backup RPO/RTO
- automatic rollback of database migrations or external side effects
- single-project PITR from a cluster-level physical backup
- full upstream Supabase Cloud feature parity
- mandatory adoption of the SupaCloud application framework
- a second Git, configuration, permission, or operation ledger

Do not expand the mainline with a new runtime, a broader framework, or a
multi-cluster scheduler unless it materially improves installation, operation,
delivery, upgrade, recovery, or an already-promised compatibility contract.

## Acceptance scenarios

```gherkin
Feature: Self-hosted stable baseline

  Scenario: A new operator chooses the supported platform
    Given the root README and support matrix are published
    When an operator selects a deployment entrypoint
    Then the full platform, Lite, and application framework boundaries are explicit
    And the primary OS, architecture, component pins, and HA limit are visible

  Scenario: The platform works without the application framework
    Given a clean supported host and a published release bundle
    When an operator creates a project using a standard Supabase client
    Then the project can use database, Auth, REST, Storage, Functions, logs, and routing
    And no @supacloud/app package is required

  Scenario: Two projects remain isolated
    Given two projects run on the same supported host
    When one project attempts to use the other project's credentials, route, or storage
    Then the operation is denied
    And the denial is recorded with project and request identity

  Scenario: An upgrade reports unknown outcomes safely
    Given a stateful platform upgrade has started
    When observation is interrupted or a component result is unknown
    Then the release is incomplete rather than successful
    And the operator can read the durable status before retrying

  Scenario: A complete restore is independently verified
    Given an approved snapshot and a new isolated environment
    When the database, objects, secrets, runtime metadata, and routes are restored
    Then authenticated project checks pass
    And cross-project access remains denied
    And the receipt records measured RPO, RTO, and unresolved deviations
```

## Existing implementation anchors

The baseline should reuse these existing surfaces:

- [Platform installation and operations](platform-operations.md)
- [Multi-tenant management](multi-tenant-management.md)
- [Project release manifest](project-release-manifest.md)
- [Application release contract](application-release-contract.md)
- [Project restore drills](project-restore-drill.md)
- [Enterprise architecture readiness](enterprise-architecture-readiness.md)
- [Control-plane brief outage](control-plane-outage.md)
- `scripts/linux-delivery-acceptance.ts`
- `scripts/test-project-restore-drill.ts`

These anchors are implementation surfaces, not automatic proof that the
complete baseline has been accepted on a production host.
