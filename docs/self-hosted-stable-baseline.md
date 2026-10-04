# Self-Hosted Stable Baseline

[English](self-hosted-stable-baseline.md) | [简体中文](self-hosted-stable-baseline.zh-CN.md)

> Status: product boundary and acceptance contract  
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

The current platform still routes some public Functions, Realtime, and Storage
requests through Management API. Therefore, independent data-plane survival
during a control-plane outage is a target acceptance property, not a current
guarantee. The first implementation step is logical separation of permissions,
connection pools, concurrency budgets, and lifecycles. Process separation
should follow measured failure propagation rather than an architecture diagram.

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

## Non-goals for the baseline

The baseline does not promise:

- every Linux distribution or CPU architecture
- HA or multi-node scheduling on the single-host profile
- control-plane outage survival before a failure drill proves it
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
- [Project restore drills](project-restore-drill.md)
- [Enterprise architecture readiness](enterprise-architecture-readiness.md)
- `scripts/linux-delivery-acceptance.ts`
- `scripts/test-project-restore-drill.ts`

These anchors are implementation surfaces, not automatic proof that the
complete baseline has been accepted on a production host.
