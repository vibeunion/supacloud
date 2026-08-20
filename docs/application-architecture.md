# Application Architecture Guide

This guide recommends a scalable application layout for teams building a domain-heavy product on SupaCloud. It is an application convention, not a platform-required filesystem layout. Keep the existing Supabase CLI layout when a project already uses it; do not create a second deployment root merely for organization.

The examples use `supabase/` because it is the standard CLI root. A project whose established deployment tooling requires `supacloud/` can use that name instead, but it must have one authoritative platform root.

## Recommended Monorepo Layout

```text
application/
├─ apps/
│  └─ web/
│     ├─ app/                 # Application bootstrap, routing, providers
│     ├─ pages/               # Route-level composition
│     ├─ widgets/             # Reusable business sections
│     ├─ features/            # User-facing business actions
│     ├─ entities/            # Entity state and presentation
│     └─ shared/              # UI, API clients, utilities, configuration
│
├─ packages/
│  ├─ domain-contracts/
│  │  ├─ domain/              # DTOs and Zod schemas by domain
│  │  ├─ auth/                # Capabilities, roles, and policy inputs/outputs
│  │  ├─ commands/            # Idempotent command contracts
│  │  ├─ events/              # Audit, webhook, and workflow event contracts
│  │  └─ state-machines/      # Pure transitions and guards
│  └─ shared-ui/              # Framework-specific but domain-neutral UI primitives
│
├─ supabase/
│  ├─ schemas/                # Optional authored schema sources for new work
│  ├─ migrations/             # Immutable, timestamp-ordered migration history
│  ├─ seed.sql
│  └─ functions/
│     ├─ _shared/
│     │  ├─ platform/         # Clients for Supabase/SupaCloud services
│     │  ├─ http/             # Authentication, error mapping, tracing
│     │  └─ observability/    # Logging and metrics helpers
│     ├─ app-api/             # Synchronous application API entrypoint
│     ├─ app-worker/          # Durable command, workflow, and queue consumers
│     ├─ app-webhooks/        # Third-party callback boundary
│     └─ app-scheduled/       # Scheduled dispatch and maintenance, when needed
│
└─ docs/
   └─ architecture/           # Architecture decision records and domain maps
```

Use a name meaningful to the application in place of `domain-contracts`, `app-api`, and `app-worker`. For example, a failure-analysis application may choose `fa-contracts`, `fa-api`, and `fa-worker`.

## Ownership Boundaries

### Contracts

`packages/<domain>-contracts` is the shared language of the application. It may contain TypeScript types, Zod schemas, command/event envelopes, and pure state-transition rules. It must not depend on browser APIs, Supabase clients, Storage, secrets, database connections, or Function runtime globals.

Keep authorization models here only when they are application contracts used by multiple callers. Split a separate cross-product auth package only after there are multiple independently released products that actually share the same model.

Generated database types are useful clients of these contracts, but they do not replace domain contracts: generated types describe database shape, while contracts describe accepted commands, public API payloads, and state transitions.

`shared-ui` may depend on the chosen frontend framework, but must not depend on application entities, authorization policy, or a Supabase client.

### Database And Migrations

The `migrations/` directory is an append-only deployment ledger. Do not rename, regroup, rewrite, or delete historical migrations in order to make a large project look cleaner.

For projects with many migrations, `schemas/` can hold the current authored structure divided by domain, for example `core.sql`, `cases.sql`, `reports.sql`, `ocr.sql`, `audit.sql`, and `api.sql`. Treat a schema-source change and its generated migration as one reviewed change. The migration remains the authoritative input to deployment.

Each domain should own its tables, indexes, RLS policies, views, triggers, and application RPCs. Cross-domain reads should be explicit through a view, RPC, or documented repository boundary rather than ad hoc joins copied across Functions.

Use a private domain outbox when an accepted transaction must cause asynchronous work. The transaction writes the domain change and the outbox/command intent together; a trusted worker dispatches it later. Do not make browser requests or database triggers depend on best-effort external HTTP delivery.

### Edge Functions

Use a small number of externally addressable Functions with clear trust boundaries:

- `app-api` accepts synchronous application requests and routes to domain modules.
- `app-worker` claims and dispatches durable commands, workflow steps, or queue messages.
- `app-webhooks` verifies and accepts third-party callbacks separately from user-facing APIs.
- `app-scheduled` starts periodic work only when a scheduled boundary is genuinely needed.

An entrypoint should be thin. Domain code belongs under the owning Function, such as `app-api/cases/`, `app-api/reports/`, or `app-worker/ocr/`. `_shared` is reserved for technical cross-cutting code; placing all business services under `_shared` turns it into an unowned dependency sink.

Pass identifiers, immutable input versions, and object paths to asynchronous workers. The worker must read current authoritative domain data, honor leases/cancellation, and make side effects idempotent. Do not put secrets in task, workflow, command, or event payloads.

## SupaCloud Application Capabilities

Use the standard `@supabase/supabase-js` client for normal application runtime traffic:

- Auth sessions and user-scoped authorization.
- PostgREST database access subject to RLS.
- Storage uploads and downloads.
- Realtime subscriptions.
- Standard `supabase.functions.invoke()` calls.

Use `@supacloud/js` from trusted server-side code for platform-specific capabilities:

- Background task submission, status, cancellation, retry, wait, subscription, and DLQ inspection.
- Supabase Queues/PGMQ send, receive, acknowledgement, archive, and diagnostics helpers.
- Service-role-only Durable Workflow execution: claim, advance, retry, fail, complete, and cancel.
- Service-role-only transactional command receipts for idempotent, atomic domain transition plus enqueue.
- Immutable Storage artifact registration and acyclic artifact lineage.
- Project OAuth/OIDC migration helpers and trusted SupAuth provisioning, reconciliation, and verification helpers.

The related platform contracts are documented in [Background Functions](./background-functions.md), [Durable Workflows](./durable-workflows.md), and [Application Platform Primitives](./application-platform-primitives.md).

## Security Rules

- Browser and mobile clients use user sessions and RLS-protected APIs only.
- `service_role`, Management API tokens, tenant database credentials, and webhook secrets remain in trusted server-side configuration.
- Platform workflow, command, and artifact ledgers are execution/audit mechanisms; domain tables remain the authority for approval, signing, delivery, and other business state.
- Large async inputs and outputs belong in Storage or application tables. Queue and workflow payloads should carry small identifiers and trace metadata.

## Incremental Adoption

Do not reorganize a mature product in one migration. First document domain ownership and introduce contracts for new or changed behavior. Then add the outbox/worker pattern for the highest-risk asynchronous flow. Move individual Functions or frontend features only when they change for business reasons, preserving the existing deployment topology throughout.
