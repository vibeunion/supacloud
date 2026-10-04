# Enterprise Architecture Readiness

[English](enterprise-architecture-readiness.md) | [简体中文](enterprise-architecture-readiness.zh-CN.md)

> Status: baseline contract
> Updated: 2026-10-04

This document defines the boundary between Pigsty-managed node capabilities and
SupaCloud-managed platform capabilities. A feature is not considered complete
because a command or script exists; it must have an owner, a reversible
operation, an observable result, and an acceptance check.

For the concrete Pigsty/pgBackRest operating procedure, see
[Pigsty Backup Operations](./pigsty-backup-operations.md).

## Ownership Boundary

### Pigsty is the infrastructure substrate

Pigsty may own or provision:

- PostgreSQL cluster topology, Patroni, leader election, and failover
- PostgreSQL replication, connection pooling, extensions, and node-level tuning
- pgBackRest backups and WAL/PITR transport
- Node-level Prometheus/Grafana exporters and infrastructure dashboards
- Base operating-system/database configuration and cluster lifecycle primitives

Pigsty does not by itself complete:

- SupaCloud project and tenant isolation
- Caddy routing, TLS, per-tenant rate limits, and gateway policy
- Management API authorization, approval, audit, and idempotency
- PostgREST, GoTrue, Edge Runtime, Realtime, and pgredis lifecycle coordination
- Release compatibility, artifact identity, deployment receipts, and rollback
- Cross-component request tracing, platform SLOs, or customer-facing incidents
- Object-storage durability, secret rotation, data deletion, and tenant cleanup
- Recovery acceptance for a complete SupaCloud project

### SupaCloud owns the platform contract

SupaCloud must treat Pigsty as a replaceable infrastructure provider. The
platform contract must work with the supported Pigsty deployment and must expose
provider-neutral health, backup, restore, scaling, and failover state.

## Readiness Domains

| Domain | Current baseline | Required completion proof |
| --- | --- | --- |
| Node HA | Patroni/HA scripts and Pigsty integration exist | Automated failover and switchover drill with measured RTO |
| Backup/DR | pgBackRest/PITR and project restore surfaces exist | Off-host backup, scheduled restore drill, measured RPO/RTO |
| Observability | VictoriaLogs, Grafana, metrics, request IDs exist | Trace propagation, SLI/SLO, alert rules, incident runbooks |
| Release safety | SHA-256, provenance, manifests, rollback helpers exist | One receipt covering all components and verified rollback |
| Tenant isolation | RLS, per-tenant runtimes, capability boundaries exist | Cross-tenant negative tests and resource fairness tests |
| Security | TLS, secret files, audit chain, dependency audit exist | Rotation drill, container scan, SBOM archive, access review |
| Capacity | Gateway, worker, queue and database controls exist | Per-tenant quotas, noisy-neighbor test, capacity report |
| Data lifecycle | Backup, storage and deletion operations exist | Retention, deletion, export, and restore-without-access-drift tests |
| Operations | Health checks and upgrade scripts exist | Runbooks, ownership, escalation, change and incident records |

## Required SLO Model

The platform must define and publish at least:

- Control-plane availability and latency
- Tenant REST/Auth/Storage availability
- Edge Function success rate, latency, cold-start rate, and queue delay
- Database failover duration and replication lag
- Backup freshness, backup success rate, and restore success rate
- Log ingestion delay and retention compliance

Each SLO needs an owner, a measurement source, an alert threshold, and a
runbook. A dashboard without an alert and a runbook is not an operational
control.

## Recovery Acceptance

The minimum complete recovery drill must:

1. Select a real or representative tenant fixture.
2. Verify the latest backup and its digest from an independent location.
3. Restore the database, object storage, secrets, and runtime metadata.
4. Reconcile migrations and component versions.
5. Verify anonymous-deny and authenticated-allow boundaries.
6. Verify tenant isolation, active routes, functions, queues, and audit records.
7. Record measured RPO, RTO, restore receipt, and unresolved deviations.

Successful `pgBackRest info` or a healthy Patroni cluster alone is not recovery
acceptance.

## Release Acceptance

A production release is complete only when all of the following are available:

- immutable source commit and component versions
- artifact digests and provenance verification
- compatibility result for database/runtime versions
- preflight backup and migration inventory
- deployment receipt with per-component state
- health and readiness read-back
- representative authenticated smoke
- rollback target and rollback receipt

## Gherkin Acceptance Criteria

```gherkin
Feature: Enterprise recovery readiness

  Scenario: A node failure is recovered through the infrastructure provider
    Given a two-node PostgreSQL cluster managed by Pigsty and Patroni
    And the SupaCloud tenant runtime is healthy
    When the current leader is made unavailable
    Then Patroni elects a healthy replica
    And SupaCloud reports the new leader and replication state
    And the measured recovery time is recorded against the configured RTO

  Scenario: A complete tenant restore is independently verified
    Given a verified off-host backup for a tenant
    When the operator restores the database, storage, secrets, and runtime metadata
    Then the tenant starts with the expected component versions
    And authenticated requests succeed
    And cross-tenant requests remain denied
    And the restore receipt contains measured RPO and RTO

  Scenario: A release cannot report success with incomplete evidence
    Given one component has an unknown deployment outcome
    When the release workflow evaluates the deployment
    Then the release is marked incomplete
    And no retry is issued automatically for a non-idempotent mutation
    And the operator receives the component identity and required read-back

  Scenario: A tenant cannot exhaust shared capacity
    Given two tenants share one Edge Runtime and gateway
    When one tenant exceeds its configured concurrency or queue quota
    Then that tenant is rejected or delayed according to policy
    And the other tenant remains within its latency and availability SLO
    And the quota event is observable by project and request ID
```

## Implementation Order

1. Complete the [Self-Hosted Stable Baseline](self-hosted-stable-baseline.md):
   product boundary, one supported profile, clean installation, and two-project
   operation.
2. Run one stateful platform upgrade with explicit component boundaries and
   durable read-back.
3. Run one independent full-project recovery from an approved off-host
   snapshot, recording measured RPO/RTO.
4. Add unified trace and SLO measurement across gateway, API, workers, queues,
   database, and recovery operations.
5. Add tenant quotas, capacity reports, and noisy-neighbor tests.
6. Add security rotation, container scanning, SBOM retention, and access review.
7. Add broader cross-component upgrade orchestration and verified rollback.
8. Add multi-node and multi-region procedures only after the single-region
   recovery contract is green.
