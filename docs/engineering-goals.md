# Engineering Goals

[English](engineering-goals.md) | [简体中文](engineering-goals.zh-CN.md)

Status: architecture contract and implementation priorities, not a completion claim.
Updated: 2026-09-08

## Outcome

Help developers and AI build business features with less repeated infrastructure
code, earlier feedback and explicit ownership. Optimize for verifiable business
changes, not the number of decorators, packages or generated files.

The four goals are reliable foundations, convenient vibe coding, earlier error
detection through types and compilation, and maintainability through module
boundaries and static AOP.

## Ownership

| Layer | Owns | Does not own |
| --- | --- | --- |
| SupAuth, external unified user center | Product-facing unified login and user-center integration, backed by GoTrue authentication, sessions and token issuance | Application object relationships or business workflow decisions |
| Application framework | Metadata/contracts in `@supacloud/app`, static analysis and generation in `@supacloud/compiler`, execution/adapters in `@supacloud/elysia` | A second identity provider, arbitrary dynamic interception, universal business models |
| SupaCloud platform | Project isolation, control-plane RBAC, database/runtime lifecycle, delivery and operational primitives | Copies of each application's membership or workflow database |
| Business application | Domain contracts, authoritative relationships, object permissions, state transitions and transactional persistence | Password verification, token issuance or a duplicated unified user center |

SupAuth is a separately integrated dependency for enterprise unified identity,
not a mandatory dependency for compiling applications or running local tests.
The existing platform GoTrue and Lite Auth modes are separate supported modes;
this contract does not remove them or silently migrate their users.
See [Authorization Boundary](authorization-boundary.md).

## Existing Foundations And Remaining Proof

The following are source-level integration points, not evidence of production
acceptance or a newly published release.

| Goal | Existing foundation | Next required proof |
| --- | --- | --- |
| Reliable foundations | Command governance adapters, workflow/queue primitives and memory sandbox | Durable database integration, concurrency, rollback and failure tests for each adopted business flow |
| Vibe coding | Application starter, compiler JSON diagnostics and Context Pack | Representative feature creation and repair using local context; never include credentials or live user data |
| Earlier detection | Static dependency/governance checks, generated code type checking and route schemas | Negative fixtures for each supported diagnostic; runtime tests for external data and database races |
| Large-project maintenance | Module contracts and explicit module/route/command/job aspects | Execution-order and failure-path tests, ownership rules and inspectable generated code |

Use existing package boundaries. Do not introduce an aggregate framework,
a general workflow engine or a second schema source solely to satisfy these goals.

## Unified Identity Contract

For enterprise applications using SupAuth:

1. Delegate login and session handling to the approved SupAuth integration.
   Do not implement password storage, token signing or refresh flows in business modules.
2. The trusted host verifies credentials before constructing runtime request
   identity. Bind validation to configured issuer, audience and allowed signing
   algorithms/keys, including token expiry. Never use an unverified decoded token,
   request body or user-supplied identity header as authority.
3. Map the verified issuer and subject to application-local access context.
   A unified subject does not automatically confer access to every project.
   Do not assume a local `auth.users` row exists in a shared-auth dependent.
4. Resolve object relationships and workflow permissions from current application
   data. Keep platform RBAC, token database roles and business roles distinct.
5. Deny protected access when identity cannot be verified; never fall back to a
   demo identity, local login or a service-role bypass. Whether a previously
   issued token remains verifiable during an outage follows the configured
   verification/cache policy, not a blanket outage bypass.
6. Keep request identity and authorization separate. Re-evaluate business
   permission on idempotent replay; a cached success must not bypass revocation.

The runtime provides `createSupAuthRequestContext` and the starter exports
`createSupAuthApp` for signature verification and application-local access
resolution. See the [runtime recipe](../packages/elysia/README.md#external-supauth-identity).
Local tests use real signatures with synthetic keys and HTTP requests; real
SupAuth sessions and application database acceptance remain deployment gates.
This does not claim that a user-center instance has been installed or migrated.

## Static AOP Contract

Declare aspects explicitly at supported module, route, command and job boundaries.
Use existing command governance for authorization, idempotency, transactions and
audit rather than duplicating these mechanisms in unrelated aspects.

Keep business decisions in domain code. Require deterministic, inspectable
execution order and tests for early rejection, exceptions and cleanup. An aspect
must not invoke the business handler twice or silently retry a write. Transaction
and audit atomicity must be provided by durable adapters, not inferred from the
presence of a decorator. Response validation can fail after commit; read the
durable receipt instead of blindly retrying.

## Implementation Order

1. Adopt this ownership contract in root documentation and the generated starter.
2. Complete a supported SupAuth host-adapter recipe with verified identity,
   project-local access resolution and authenticated multi-application tests.
3. For one real business command, verify durable authorization, concurrency,
   idempotency, transaction and audit behavior together.
4. Add compiler checks only for statically provable mistakes, with actionable
   diagnostics and negative fixtures; keep runtime checks for external facts.
5. Exercise AI-assisted feature creation/repair and multi-module AOP behavior.
   Extend shared capabilities only when this exposes meaningful repeated work.

## Local Implementation

- External identity adapter with pinned HTTPS trust, asymmetric verification,
  application-local access, cross-project denial and no forwarded-identity fallback.
- Guarded command/transaction/idempotency/job continuations and metadata-only
  execution observation; durable adapters remain application responsibilities.
- Invalid command mode diagnostics with explicit semantic fixes. Compilation
  defaults to preserving good artifacts when errors exist.
- Directional context packs, aspect source files, relevant diagnostics and static
  execution plans; the starter includes the production identity entry and repair loop.

Package tests and the packed starter gate verify these local contracts. They do
not establish production SupAuth sessions, PostgreSQL/RLS guarantees, publication
or deployment. The implementation order above remains the adoption sequence for
each real business application, not a request to duplicate its domain database.

## Acceptance Criteria

```gherkin
Feature: Verifiable enterprise application development
  Scenario: Local development has no identity-center dependency
    Given a new starter project without SupAuth credentials
    When the developer runs the documented local verification
    Then compilation and deterministic tests can run without SupAuth
    And the memory demo cannot serve as the production identity adapter

  Scenario: Unified login does not grant cross-application access
    Given a verified SupAuth subject with membership only in application A
    When the subject requests a protected resource in application B
    Then application B denies access without business side effects
    And an unverifiable credential never falls back to a demo identity

  Scenario: Permission revocation applies to a replay
    Given a successful command receipt and subsequently revoked local permission
    When the caller repeats the command with the same idempotency key
    Then authorization rejects the request before returning the cached success

  Scenario: Static mistakes preserve working artifacts
    Given working compiler output
    When a change introduces an unresolved dependency or dynamic aspect reference
    Then compilation reports a diagnostic identifying the mistake
    And working generated artifacts are not replaced

  Scenario: AOP failure does not duplicate a business operation
    Given an explicit aspect chain and durable command adapters
    When execution fails around a business operation
    Then the operation is not automatically executed a second time
    And committed outcomes are resolved using durable receipts
```

## Related Contracts

- [Application Architecture](application-architecture.md)
- [Application Starter](application-starter.md)
- [Application Platform Primitives](application-platform-primitives.md)
- [Compiler](../packages/compiler/README.md)
- [Runtime And Static AOP](../packages/elysia/README.md)
- [Enterprise Operational Readiness](enterprise-architecture-readiness.md)
