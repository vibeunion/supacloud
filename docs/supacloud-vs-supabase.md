# SupaCloud vs Supabase

This document compares **SupaCloud**, **Supabase Cloud**, and **Supabase Self-Hosted** from an operator and product-integration perspective. SupaCloud's product target is project-level functional and protocol compatibility with Supabase Cloud.

It is intentionally focused on what each option **ships as a built-in capability**, not what can theoretically be assembled with extra tooling.

## Executive summary

- **Choose SupaCloud** when you want to run **many isolated Supabase-style projects on your own servers** with a built-in control plane, web console, operator CLI, tenant routing, background task orchestration, and integrated frontend hosting.
- **Choose Supabase Cloud** when you want the most complete **managed** Supabase experience, including hosted branching, managed backups/PITR, hosted logs explorer, and multi-region managed operations.
- **Choose Supabase Self-Hosted** when you want the official Supabase stack on your own infrastructure and are willing to operate Docker/services directly. Supabase Self-Hosted gives you the core products, but not a multi-tenant control plane out of the box.

Current scope exclusions are deliberate: organization/team governance, platform billing, Supabase Analytics/Logflare, and Analytics/Iceberg buckets. Project logs remain in scope, implemented independently with the embedded collector and VictoriaLogs.

## Positioning

| Product | Primary role |
|---|---|
| **SupaCloud** | Self-hosted multi-tenant PaaS for running and operating many Supabase-compatible projects on shared infrastructure |
| **Supabase Cloud** | Fully managed Supabase platform operated by Supabase |
| **Supabase Self-Hosted** | Official self-hosted Supabase stack, primarily operated as your own Docker deployment |

## Feature matrix

Legend:

- `Built-in`: shipped as a first-class capability
- `Partial`: available, but with narrower scope or more operator responsibility
- `External / manual`: possible, but not shipped as a built-in product capability
- `Cloud only`: available on Supabase Cloud, not documented as part of the standard self-hosted stack

| Capability | SupaCloud | Supabase Cloud | Supabase Self-Hosted |
|---|---|---|---|
| Core Postgres + REST API + Auth + Realtime + Storage | **Built-in** | **Built-in** | **Built-in** |
| OAuth 2.1 / OIDC Provider | **Built-in** (project-scoped, Supabase-compatible beta surface) | **Built-in** (beta) | Partial / operator-configured |
| Edge Functions runtime | **Built-in** (Bun-based, Deno-compat layer) | **Built-in** | **Built-in** |
| Multi-project control plane on one cluster/server | **Built-in** | **Built-in** | **External / manual** |
| Project lifecycle API (create/pause/restore/restart/settings) | **Built-in** | **Built-in** via Management API | **External / manual** |
| Self-host operator web console | **Built-in** | N/A as self-host control plane | **External / manual** |
| Project-user CLI + operator CLI split | **Built-in** (`supacloud-cli`, `supacloud-admin`; optional `supacloudctl` dispatcher) | Partial (`supabase` CLI + hosted dashboard) | Partial (`supabase` CLI + manual ops) |
| Built-in tenant routing and per-project domains | **Built-in** | **Built-in** | **External / manual** |
| Built-in multi-tenant task queue / background function receipts | **Built-in** | External pattern recommended for long jobs | External / manual |
| Task monitoring UI and task control APIs | **Built-in** | External / manual | External / manual |
| Frontend hosting / Pages-style deployment | **Built-in** | External product choice (not a core Supabase product) | External / manual |
| Git webhook deploy pipeline for hosted frontends | **Built-in** | External / manual | External / manual |
| Built-in China-focused OAuth integrations (WeChat / Alipay / DingTalk) | **Built-in** | Partial via generic auth providers, no equivalent China-focused operator surface documented as built-in | Partial / manual |
| Runtime log streaming in the self-host control plane | **Built-in** | **Built-in** in hosted dashboard/log explorer | External / manual |
| Persistent project logs explorer | **Built-in** (embedded collector + VictoriaLogs; no Analytics/Logflare) | **Built-in** | Partial / Analytics-based |
| Configurable log drains (forward to webhook / Datadog / Loki / Elasticsearch) | **Built-in** | **Built-in** | External / manual |
| S3-compatible storage API with SigV4 (ListBuckets / PutObject / GetObject / DeleteObject / HeadObject) | **Built-in** (SigV4 + Bearer) | Partial (via extensions) | External / manual |
| Scheduled Edge Functions (cron-based triggers) | **Built-in** | **Built-in** (pg_cron + pg_net) | Manual (pg_cron) |
| pg-meta typed metadata API (tables / columns / indexes / roles / policies / etc.) | **Built-in** | **Built-in** | External tool |
| Built-in platform backups / restore surface | **Built-in** | **Built-in** | Operator responsibility |
| Built-in PITR-style restore API surface | **Built-in** (platform-managed in control plane) | **Built-in** | Operator responsibility |
| Managed branching / preview environments | **Built-in** (API + UI + Git auto-branch) | **Built-in** | Cloud only |
| Passkey sign-in | **Built-in** (experimental, GoTrue v2.194+; not Lite) | **Built-in** (experimental) | Version/config dependent |
| Custom OAuth/OIDC providers | **Built-in** | **Built-in** | Version/config dependent |
| Storage Vector Buckets API + current `supabase-js` client | **Built-in** | **Built-in** (alpha) | External / manual |
| RLS Tester | **Built-in** (experimental, bounded read-only role impersonation + policy trace) | **Built-in** (preview) | External / manual |
| Temporary database access | **Built-in** (expiring isolated login roles + IPv4/IPv6 CIDR TCP gateway + branch inheritance) | **Built-in** (preview, PAT/JWT JIT) | External / manual |
| Declarative schema / pg-delta CLI workflow | **Built-in** through official CLI adapter | **Built-in** (alpha) | CLI-dependent |
| CDC Pipelines to BigQuery | **Built-in** (pinned official Supabase ETL runtime) | **Built-in** (public alpha) | External / manual |
| Stripe and MongoDB Wrappers | **Built-in** (Vault-backed setup) | **Built-in** | Extension/manual SQL |
| AWS PrivateLink project connectivity | **Not yet implemented** | **Built-in** (AWS projects) | External / manual |
| Automated PostgreSQL major version upgrades | **Workflow built-in** (cluster-scoped preflight, full-backup gate, approval, provider executor, validation and rollback journal; executor must be configured per deployment) | **Built-in** | Operator responsibility |
| Shared-infra multi-tenancy to improve self-host density | **Built-in** | N/A to end users | External / manual |
| Official Docker self-host quickstart | **Built-in** (`docker/self-host`) | N/A | **Built-in** |

## Where SupaCloud is stronger

### 1. Self-hosted multi-tenancy is a product, not an ops afterthought

SupaCloud is opinionated about running **many projects per server or cluster**. The repository includes:

- a management API for project lifecycle and settings
- a self-hosted web console
- tenant runtime generation/restart flows
- Caddy-based per-project routing
- operator and project-user CLIs

That is the main difference from the official self-hosted Supabase stack, which is documented as Docker-based self-hosting where **you are responsible for server provisioning, security hardening, database operations, backups, and disaster recovery**.

### 2. Background jobs are a first-class integration surface

SupaCloud adds a task model on top of function invocation:

- task receipts
- task polling/cancel/retry
- DLQ/task state surfaces
- task-aware web console pages
- queue workers integrated with the platform

Supabase Edge Functions docs explicitly recommend keeping edge functions short-lived and moving heavy long-running jobs to background workers. SupaCloud turns that guidance into a built-in operator surface.

### 3. Frontend hosting is part of the platform

SupaCloud includes:

- deployment records
- Git-based and upload-based deployment flows
- frontend domains
- webhook-triggered deployments

This is useful when the goal is to operate an entire app platform around Supabase-compatible tenants, not only the backend primitives.

### 4. China-oriented auth/operator features are built into the control plane

SupaCloud exposes China-specific provider flows and admin surfaces that are operationally important for certain deployments. Supabase Auth supports many providers and custom OAuth/OIDC, but the SupaCloud repo ships a more opinionated built-in surface for this specific use case.

## Where Supabase Cloud is stronger

### 1. Managed operations

Supabase Cloud has the clear advantage whenever the requirement is:

- managed infrastructure
- managed backups and PITR
- managed logs explorer
- fully managed Git-based branching with deeper CI integration
- hosted SLA/operational ownership

SupaCloud targets the same project-level product functions, while hosted SLA, global infrastructure ownership, capacity guarantees, and vendor-operated incident response remain operational differences rather than API features.

### 2. Branching

Supabase Cloud provides branch environments and preview branches as a fully managed product. SupaCloud now ships branching support:
- Branching API (`/v1/projects/:ref/branches`) with schema-only preview branches by default, controlled migration promotion, and an explicit administrator-only `pg_dump | psql` replacement break-glass path
- Web console UI for branch management (create, delete, promote with confirmation)
- Git auto-branching: configure auto-branch rules per project, and Git push events automatically create preview branches for non-base branches
- Auto-branching config API (`/v1/projects/:ref/auto-branching`) with exclude patterns and branch prefix support

### 3. Hosted observability ergonomics

Supabase Cloud documents a hosted Logs Explorer. SupaCloud provides the corresponding project-scoped query, search, time-range and service filtering surface using its embedded collector and VictoriaLogs, plus live journald streaming and log drains. It intentionally does not install or depend on Supabase Analytics/Logflare.

## Where Supabase Self-Hosted is still the right answer

Choose the official self-hosted Supabase stack if:

- you only need **one or a small number of projects**
- you do **not** need a multi-tenant control plane
- your team is comfortable operating Docker services directly
- you want to stay as close as possible to the official upstream stack

In that model, adding your own project control plane, routing model, logs UI, tenant runtime generator, frontend deploy pipeline, and task queue surface becomes your responsibility. SupaCloud exists to package those concerns as a product.

## Recommended decision framework

### Choose SupaCloud when

- you need to host **many customer/workspace projects** on your own infra
- you want a built-in API + console for tenant operations
- you want integrated background job orchestration for functions
- you want app hosting and backend hosting in one self-hosted platform
- you want operator ergonomics closer to a PaaS than a raw Docker stack

### Choose Supabase Cloud when

- you want minimal infrastructure ownership
- you need fully managed Git-based branching and auto-deploy previews
- you need managed observability with hosted log explorer
- you are fine with vendor-hosted control plane and pricing
- you want the shortest path to production with the fewest ops responsibilities

### Choose Supabase Self-Hosted when

- you need official upstream self-hosting
- you are okay owning the operational glue
- you do not need multi-tenant project lifecycle management as a built-in feature

## Important nuance

The compatibility target covers Supabase Cloud's project products and project management workflows. Organization/team governance, billing, Analytics/Logflare, and Analytics/Iceberg buckets are explicitly out of the current implementation scope. Hosted SLA and globally managed infrastructure are service-delivery properties and are not represented as local feature parity.

Known project-level gaps are tracked rather than treated as exclusions: AWS PrivateLink needs provider-side provisioning, and PostgreSQL major-upgrade execution still requires a deployment-specific provider executor; the control-plane workflow fails closed until that executor passes preflight.

## Source basis

### SupaCloud repository evidence

- [README](../README.md)
- [CLI Guide](./cli-guide.md)
- [Frontend Hosting](./frontend-hosting.md)
- [Background Functions](./background-functions.md)
- [Edge Runtime Guide](./edge-runtime-guide.md)
- [Management API project routes](../packages/management-api/src/routes/project-crud.ts)
- [Management API project settings routes](../packages/management-api/src/routes/project-config.ts)
- [Frontend deployment routes](../packages/management-api/src/routes/frontend.ts)
- [Webhook deployment routes](../packages/management-api/src/routes/webhook.ts)
- [Task routes](../packages/management-api/src/routes/tasks.ts)
- [OAuth/OIDC Provider routes](../packages/management-api/src/routes/auth-oauth-server.ts)
- [RLS Tester and database routes](../packages/management-api/src/routes/database.ts)
- [Temporary database access routes](../packages/management-api/src/routes/database-jit.ts)
- [Pipelines routes](../packages/management-api/src/routes/pipelines.ts)
- [Storage Vector compatibility routes](../packages/management-api/src/routes/storage-compat.ts)

### Supabase official documentation

- [Supabase Platform](https://supabase.com/docs/guides/platform)
- [Self-Hosting](https://supabase.com/docs/guides/self-hosting)
- [Management API Reference](https://supabase.com/docs/reference/api/introduction)
- [Database](https://supabase.com/docs/guides/database/overview)
- [Auth](https://supabase.com/docs/guides/auth)
- [Storage](https://supabase.com/docs/guides/storage)
- [Realtime](https://supabase.com/docs/guides/realtime)
- [Edge Functions](https://supabase.com/docs/guides/functions)
- [Self-Hosted Functions](https://supabase.com/docs/guides/self-hosting/self-hosted-functions)
- [Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Branching](https://supabase.com/docs/guides/deployment/branching)
- [Logs Explorer / Logging](https://supabase.com/docs/guides/telemetry/logs)
