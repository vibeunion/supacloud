# Authorization Boundary

## Decision

SupaCloud owns platform control-plane RBAC. Business applications own
relationship-based authorization (ReBAC) and workflow authorization in their
own PostgreSQL database.

SupAuth is the external unified user-center dependency for enterprise applications.
Its platform authorization product and compatibility surface sits over SupaCloud
RBAC; it is not a second RBAC database or a centralized ReBAC/PDP service.
GoTrue remains the underlying authentication, session and token authority.
Unified identity does not imply shared business permissions across applications.

## Ownership

| Capability | Authority | SupaCloud responsibility |
| --- | --- | --- |
| Enterprise unified user center | External SupAuth integration, backed by GoTrue | Provide trusted integration boundaries; do not duplicate application login/user centers |
| Platform roles and permissions | SupaCloud Management API | Persist, version, audit, and expose project-scoped RBAC |
| Organization and application assignments | SupaCloud Management API | Validate targets and provide management APIs |
| RBAC projection | SupaCloud -> GoTrue metadata through the approved bridge | Preserve project isolation and bounded claims |
| Business relationships | Application PostgreSQL schema | Provide the database and transaction substrate; do not copy facts into platform RBAC |
| Workflow authorization | Application RPCs and RLS | Preserve state-machine, maker-checker, ownership, and concurrency rules |
| Identity and tokens | GoTrue | Keep authentication, sessions, MFA, JWT signing, and standard claims |

## Runtime Rules

- Management API and runtime command adapters may enforce coarse permission
  strings such as `reports.export` or `users.read`.
- A business application must resolve current relationship facts locally for
  object-level decisions such as project membership, assignment, ownership, or
  reviewer separation.
- RLS and `SECURITY DEFINER` command functions remain the final boundary for
  database reads and writes.
- UI capability checks are hints only; they never replace API, RPC, or RLS
  authorization.
- Revocation of business relationships takes effect with the application
  transaction and must not wait for JWT refresh.

## Explicit Non-Goals

SupaCloud must not:

- store copied application memberships, assignments, or workflow relationships;
- make JWT `role` represent a business role;
- require applications to call a remote ReBAC service for every database row;
- replace application-owned state-machine and audit decisions with platform RBAC.

SupAuth and SupaCloud should expose reusable contracts, adapters, projection
helpers, and conformance checks, but the business application's own facts
remain authoritative for ReBAC.

## Integration Contract

SupAuth documents the product-facing projection and application-local
authorization kit. SupaCloud provides the Management API, runtime boundary,
GoTrue integration, and PostgreSQL/RLS substrate. Independent applications
can use the framework contracts without installing SupAuth or moving their business
authorization data into SupaCloud. Enterprise applications using unified identity
connect to the external SupAuth center rather than installing a user center in
every application. Framework-only local tests do not require that dependency.

The host must construct request identity from verified credentials, resolve
application-local access separately, and deny access when verification fails.
See [Engineering Goals](engineering-goals.md#unified-identity-contract) for the
integration and failure contract. The runtime's `createSupAuthRequestContext`
and starter's `createSupAuthApp` provide verification integration; applications
still supply local access resolution and durable authorization.

See SupAuth's
[`docs/application-authorization-kit.md`](https://github.com/vibeunion/supauth/blob/main/docs/application-authorization-kit.md)
for the application-local adapter contract.
