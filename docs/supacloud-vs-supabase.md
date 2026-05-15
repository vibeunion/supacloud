# SupaCloud vs Supabase

This document compares **SupaCloud**, **Supabase Cloud**, and **Supabase Self-Hosted** from an operator and product-integration perspective.

It is intentionally focused on what each option **ships as a built-in capability**, not what can theoretically be assembled with extra tooling.

## Executive summary

- **Choose SupaCloud** when you want to run **many isolated Supabase-style projects on your own servers** with a built-in control plane, web console, operator CLI, tenant routing, background task orchestration, and integrated frontend hosting.
- **Choose Supabase Cloud** when you want the most complete **managed** Supabase experience, including hosted branching, managed backups/PITR, hosted logs explorer, and multi-region managed operations.
- **Choose Supabase Self-Hosted** when you want the official Supabase stack on your own infrastructure and are willing to operate Docker/services directly. Supabase Self-Hosted gives you the core products, but not a multi-tenant control plane out of the box.

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
| Project-user CLI + operator CLI split | **Built-in** (`supacloud`, `supacloud-admin`) | Partial (`supabase` CLI + hosted dashboard) | Partial (`supabase` CLI + manual ops) |
| Built-in tenant routing and per-project domains | **Built-in** | **Built-in** | **External / manual** |
| Built-in multi-tenant task queue / background function receipts | **Built-in** | External pattern recommended for long jobs | External / manual |
| Task monitoring UI and task control APIs | **Built-in** | External / manual | External / manual |
| Frontend hosting / Pages-style deployment | **Built-in** | External product choice (not a core Supabase product) | External / manual |
| Git webhook deploy pipeline for hosted frontends | **Built-in** | External / manual | External / manual |
| Built-in China-focused OAuth integrations (WeChat / Alipay / DingTalk) | **Built-in** | Partial via generic auth providers, no equivalent China-focused operator surface documented as built-in | Partial / manual |
| Runtime log streaming in the self-host control plane | **Built-in** | **Built-in** in hosted dashboard/log explorer | External / manual |
| Built-in platform backups / restore surface | **Built-in** | **Built-in** | Operator responsibility |
| Built-in PITR-style restore API surface | **Built-in** (platform-managed in control plane) | **Built-in** | Operator responsibility |
| Managed branching / preview environments | External / manual today | **Built-in** | Cloud only |
| Shared-infra multi-tenancy to improve self-host density | **Built-in** | N/A to end users | External / manual |
| Official Docker self-host quickstart | **Built-in** (`docker/self-host`) | N/A | **Built-in** |

## Where SupaCloud is stronger

### 1. Self-hosted multi-tenancy is a product, not an ops afterthought

SupaCloud is opinionated about running **many projects per server or cluster**. The repository includes:

- a management API for project lifecycle and settings
- a self-hosted web console
- tenant runtime generation/restart flows
- Kong-based per-project routing
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
- hosted branching / preview environments
- hosted SLA/operational ownership

SupaCloud does not try to replace Supabase Cloud on those hosted platform dimensions. Its value is in **self-hosted control plane + multi-tenant operations**.

### 2. Branching

Supabase Cloud provides branch environments and preview branches as a documented product capability. SupaCloud does not currently ship an equivalent built-in branching product.

### 3. Hosted observability ergonomics

Supabase Cloud documents a Logs Explorer and product-specific logs surfaces in the hosted dashboard. SupaCloud provides logs and streaming in its own control plane, but it is not equivalent to Supabase Cloud’s fully hosted observability stack.

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
- you need managed branching and managed observability
- you are fine with vendor-hosted control plane and pricing
- you want the shortest path to production with the fewest ops responsibilities

### Choose Supabase Self-Hosted when

- you need official upstream self-hosting
- you are okay owning the operational glue
- you do not need multi-tenant project lifecycle management as a built-in feature

## Important nuance

This is **not** a claim that SupaCloud replaces every Supabase Cloud capability.

A more precise statement is:

- **SupaCloud extends the self-hosted Supabase model**
- it adds a **self-hosted multi-tenant control plane**
- it also adds operator workflows that are usually externalized in the official self-hosted stack

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
