# Application Architecture Guide

This guide recommends a scalable application layout for teams building a domain-heavy product on SupaCloud. It is an application convention, not a platform-required filesystem layout. Keep the existing Supabase CLI layout when a project already uses it; do not create a second deployment root merely for organization.

The examples use `supabase/` because it is the standard CLI root. A project whose established deployment tooling requires `supacloud/` can use that name instead, but it must have one authoritative platform root.

The [Engineering Goals](engineering-goals.md) define framework/platform ownership,
static AOP and verification priorities. Enterprise applications use external
SupAuth for a unified user center; verified identity enters through a trusted
host adapter, while object relationships and workflow authorization stay local.
Do not build another login or user-center subsystem under `_shared`.

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
│     ├─ app-api/             # Optional stateless Function entrypoint
│     ├─ app-worker/          # Durable command, workflow, and queue consumers
│     ├─ app-webhooks/        # Third-party callback boundary
│     └─ app-scheduled/       # Scheduled dispatch and maintenance, when needed
│
└─ docs/
   └─ architecture/           # Architecture decision records and domain maps
```

Use a name meaningful to the application in place of `domain-contracts`, `app-api`, and `app-worker`. For example, a failure-analysis application may choose `fa-contracts`, `fa-api`, and `fa-worker`.

## Web Surface And Elysia Backend Boundary

The web framework is an application choice, not a backend boundary or a
VibeUnion-wide profile. An existing product may retain SvelteKit when its
current UX and runtime depend on it. This does not create a `web-sveltekit`
organization profile or change the selected profile for new applications:
public web applications currently use `web-nuxt`, while internal operations
and backoffice applications use `admin-svadmin`.

Rendering mode is also an application choice. SupaCloud migration does not
require SSR: an existing CSR/SPA, SvelteKit client-rendered, Nuxt client-rendered,
static-hosted, edge-rendered, or trusted-server arrangement may remain in place.
Migration checks must preserve the selected topology and only require a trusted
server boundary for operations that genuinely need service credentials,
transactions, or durable side effects.

- **Web surface** owns browser and SSR route composition, assets, client state,
  and optional framework-specific adapters or BFF handlers. SvelteKit, Nuxt,
  or another selected frontend framework may implement this layer.
- **Elysia / `@supacloud/elysia`** owns trusted application execution:
  authenticated APIs, domain mutations, authorization decisions, transaction
  boundaries, orchestration, workers, and durable side effects.
- **SupaCloud** owns the platform protocols and infrastructure: Auth,
  PostgREST, Storage, Realtime, Edge Functions, queues, and project delivery.

For a SupaCloud-native application, ordinary user-scoped reads and CRUD may use
the SupaCloud client and RLS-protected PostgREST APIs. Complex writes,
cross-domain operations, and asynchronous side effects should cross the
Elysia boundary:

```text
browser or mobile client
  -> selected web/admin frontend
  -> user-scoped SupaCloud API for ordinary reads
  -> trusted application API for pooled model-backed commands
  -> Elysia domain modules (in-process command calls)
  -> PostgreSQL / Storage / Realtime / queues

app-worker Function
  -> Elysia worker modules
  -> durable command or workflow side effects
```

For pooled model-backed commands, deliver the synchronous API, identity
adapter and commands together as one versioned release. If the API is already
a Function and its projects share an operator trust domain, keep the Function:
the [model-command recipe](application-starter.md#start) can build a single
Function with a request-scoped PostgreSQL binding. No application listener,
proxy Function or command-only service is needed. A standalone HTTP artifact
is also supported when a dedicated process is appropriate; managed Application
delivery is optional in that case.

The `model-command` delivery profile rejects more than one synchronous target
or a target without its own database binding. Durable jobs may remain
independent. `function-data-plane` is the optional Function-only profile for
PostgREST and governed RPC; those paths do not need a direct database login or
a model migration. Ordinary Auth, Storage, and external system calls are
unaffected. The planner checks declared targets and bindings, not the intent
of arbitrary network calls or configurations outside the compiler plan.

For a direct binding, use a reviewed least-privileged database login and keep
the raw pool at the trusted composition root. Application code still owns
authorization and uses the existing transaction, receipt and audit adapters.
A database secret does not turn a shared Worker into a hard security boundary.

Stateless hooks, schedules, and independent integrations can remain Functions.
Framework-specific server handlers may adapt requests or perform SSR, but
must not become a second owner of domain authorization, transactions or audit.
Keep a separate runtime only for an actual independent scaling, security or
lifecycle boundary, and explicitly define compatibility and rollback across it.

For an existing `Function -> command host` application, bind its existing
durable command port in the Function and keep the same public Function slug.
Do not restore retired RPCs or add another ledger. Preserve Auth, PostgREST,
Storage and independently owned Functions. Keep any older release dependencies
only for an explicit rollback window.

```gherkin
Scenario: A model-backed Function needs only its database binding
  Given one Function release with verified identity and a low-privilege database login
  When the Function executes a command without a separate HTTP service
  Then the authenticated write commits once
  And replay returns the same receipt without another audit entry

Scenario: A missing capability does not introduce a fallback
  Given a Function with a declared database binding
  When the named project secret is absent
  Then the invocation fails without borrowing a default database URL

Scenario: A synchronous split is rejected before packaging
  Given a model-command plan that declares a Function and a separate HTTP target
  When planning or building delivery
  Then the compiler rejects the plan and writes no new release
```

Validate these scenarios in staging before retiring any prior dependency.
Function rollback restores compatible code and configuration, not business data.

The boundary has three practical rules:

1. Browser and mobile clients use user-scoped sessions and RLS-protected APIs.
   They never receive `service_role`, Management API tokens, or tenant
   database credentials.
2. The frontend may call ordinary SupaCloud APIs or adapt a request for SSR,
   but Elysia owns governed command contracts, authorization, transactions,
   and audit behavior.
3. Functions and workers remain thin entrypoints. Shared domain contracts stay
   in a platform-neutral package and are consumed by the selected frontend
   clients and the Elysia runtime.

## Ownership Boundaries

### Contracts

`packages/<domain>-contracts` is the shared language of the application. It may contain TypeScript types, Zod schemas, command/event envelopes, and pure state-transition rules. It must not depend on browser APIs, Supabase clients, Storage, secrets, database connections, or Function runtime globals.

Keep authorization models here only when they are application contracts used by multiple callers. Split a separate cross-product auth package only after there are multiple independently released products that actually share the same model.

Generated database types are useful clients of these contracts, but they do not replace domain contracts: generated types describe database shape, while contracts describe accepted commands, public API payloads, and state transitions.

`shared-ui` may depend on the chosen frontend framework, but must not depend on application entities, authorization policy, or a Supabase client.

When a product has more than one frontend or backend runtime, keep shared
request and response schemas in `packages/<domain>-contracts`. Do not import
frontend route modules into Elysia, or Elysia application modules into browser
bundles.

### Database And Migrations

The `migrations/` directory is an append-only deployment ledger. Do not rename, regroup, rewrite, or delete historical migrations in order to make a large project look cleaner.

For projects with many migrations, `schemas/` can hold the current authored structure divided by domain, for example `core.sql`, `cases.sql`, `reports.sql`, `ocr.sql`, `audit.sql`, and `api.sql`. Treat a schema-source change and its generated migration as one reviewed change. The migration remains the authoritative input to deployment.

Each domain should own its tables, indexes, RLS policies, views, triggers, and application RPCs. Cross-domain reads should be explicit through a view, RPC, or documented repository boundary rather than ad hoc joins copied across Functions.

Use a private domain outbox when an accepted transaction must cause asynchronous work. The transaction writes the domain change and the outbox/command intent together; a trusted worker dispatches it later. Do not make browser requests or database triggers depend on best-effort external HTTP delivery.

### Edge Functions

Use a small number of externally addressable Functions with clear trust boundaries:

- A stateless `app-api` can serve Function-native endpoints. Choose a trusted
  runtime that meets the database and lifecycle requirements for a pooled API.
- `app-worker` claims and dispatches durable commands, workflow steps, or queue messages.
- `app-webhooks` verifies and accepts third-party callbacks separately from user-facing APIs.
- `app-scheduled` starts periodic work only when a scheduled boundary is genuinely needed.

An entrypoint should be thin. Domain code belongs under the owning Function, such as `app-api/cases/`, `app-api/reports/`, or `app-worker/ocr/`. `_shared` is reserved for technical cross-cutting code; placing all business services under `_shared` turns it into an unowned dependency sink.

Pass identifiers, immutable input versions, and object paths to asynchronous workers. The worker must read current authoritative domain data, honor leases/cancellation, and make side effects idempotent. Do not put secrets in task, workflow, command, or event payloads.

## SupaCloud Application Capabilities

`@supacloud/js` is a frontend-facing platform SDK as well as a trusted-server SDK.
It wraps an existing `@supabase/supabase-js` client; it does not replace its session
store or transport. Create one user-scoped Supabase client and pass that instance
to SupaCloud and existing frontend providers. Ordinary operations remain available
through the same client (also exposed as `supacloud.supabase`):

- Auth sessions and user-scoped authorization.
- PostgREST database access subject to RLS.
- Storage uploads and downloads.
- Realtime subscriptions.
- Standard `supabase.functions.invoke()` calls.

Choose SDK capabilities by their server-enforced trust boundary, not merely by
whether a method is exported:

| Caller | SDK use |
| --- | --- |
| Browser with a user session | Background task submission and authorized task status/actions; browser business-command composition through `@supacloud/js/contracts` |
| Trusted application server or worker | Service-role Workflow/Command RPCs and privileged artifact or queue operations |
| Trusted operator | Project administration, queue administration and OAuth/OIDC management |

Each endpoint must independently authorize the caller. A browser facade is not a
permission grant. Never put Management API tokens or service-role credentials in
the frontend to make an operation work. The SDK does not implement SupAuth
provisioning, reconciliation or rollback.

Generated application clients own business-specific routes, queries and public
types, not another session system. Reuse the same current-session resolver with
the SDK's authenticated transport. UI routing, forms and caches stay with the
selected frontend framework or svadmin; no frontend DI container is required.
See [Frontend SDK Integration](./frontend-sdk-integration.md) for the composition
recipe, browser/server boundaries and focused acceptance scenarios.

The related platform contracts are documented in [Background Functions](./background-functions.md), [Durable Workflows](./durable-workflows.md), and [Application Platform Primitives](./application-platform-primitives.md).

## Security Rules

- Browser and mobile clients use user sessions and RLS-protected APIs only.
- `service_role`, Management API tokens, tenant database credentials, and webhook secrets remain in trusted server-side configuration.
- Platform workflow, command, and artifact ledgers are execution/audit mechanisms; domain tables remain the authority for approval, signing, delivery, and other business state.
- Large async inputs and outputs belong in Storage or application tables. Queue and workflow payloads should carry small identifiers and trace metadata.

## Incremental Adoption

Do not reorganize a mature product in one migration. First document domain ownership and introduce contracts for new or changed behavior. Then add the outbox/worker pattern for the highest-risk asynchronous flow. Move individual Functions or frontend features only when they change for business reasons, preserving the existing deployment topology throughout.
