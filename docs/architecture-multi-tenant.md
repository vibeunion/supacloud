# SupaCloud Multi-Tenant Architecture

> **Status**: Implemented (Option C+ with Caddy Admin API-Driven Gateway)  
> **Last Updated**: 2026-05-11

## Current Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Caddy       │ ──► │ PostgREST(:310x) ──► │ supa_tenant_1 │
│  Gateway     │     │ GoTrue(:410x)    │     └───────────────┘
│  :80/:443    │     │ (per-tenant)     │     ┌───────────────┐
│              │     └──────────────────┘ ──► │ supa_tenant_N │
│  Plugins:    │                              └───────────────┘
│  - ACME SSL  │     ┌──────────────────┐
│  - Gzip      │     │ Management API   │
│  - Sec Hdrs  │ ──► │ (:9090 Elysia)   │
│  - Rate Limit│     │ ├─ SSE Logs      │
│  - CORS      │     │ ├─ WebSocket     │
└──────────────┘     │ └─ Static Assets │
                     └──────────────────┘
                     ┌──────────────────┐
                 ──► │ Edge Runtime     │
                     │ (:9000 Elysia)   │
                     │ ├─ Worker Pool   │
                     │ └─ Preheat Cache │
                     └──────────────────┘
                              │ request-scoped internal capability
                              ▼
                     ┌──────────────────┐
                     │ pgredis-runtime  │
                     │ (:9010 private)  │
                     │ ├─ Tenant Pools  │
                     │ └─ L1 + NOTIFY   │
                     └──────────────────┘
```

> **Note**: SupaCloud natively relies on **Caddy** running as a systemd service.
> All tenant routing, rate limiting, CORS, and TLS are managed via the Caddy Admin API — no manual config file edits needed.

### 1. PostgREST & Authentication Runtime ⭐ Implemented
PostgREST remains a per-tenant process. Authentication supports two explicit product modes:

- **Local mode (default):** the project owns its own `gotrue` process and `auth` schema.
- **SupAuth shared mode:** `SUPACLOUD_AUTH_RUNTIME_OWNER_REF=<owner-ref>` designates one project as the authentication authority. Other projects do not start local GoTrue; their public `/auth/v1` traffic is routed to the owner's GoTrue runtime.

In local mode, we spin up unique `postgrest` and `gotrue` processes dynamically using `systemd` templates (`supacloud-pgrst@.service` and `supacloud-gotrue@.service`):
- They bind to unique deterministically generated ports (e.g., PostgREST starts from 3100, GoTrue starts from 4100).
- They connect securely to the tenant's isolated Postgres database (`supa_<ref>`) using unique credentials.
- They possess isolated `JWT_SECRET`s to ensure cryptographic boundary security (users from Tenant A cannot authenticate into Tenant B).
- PostgREST now has a component-level lifecycle controller in Management API: `pausePostgrest`, `resumePostgrest`, `statusPostgrest`, and `restartPostgrest`.
- Desired state is stored per project in dedicated `projects.postgrest_*` metadata columns and is reconciled to actual systemd state in the runtime worker.
- PostgREST-only lifecycle actions do not restart GoTrue, so REST-only repairs do not disturb authentication traffic.

In SupAuth shared mode:

- only the owner project can manage users, providers, OAuth clients, MFA, SSO, email templates, hooks, rate limits, and other GoTrue configuration
- dependent Studio projects expose local RLS policy management, but hide and server-side block GoTrue user/configuration pages
- service status points to `supacloud-gotrue@<owner-ref>` and is read-only from dependent projects; project-wide start/stop/restart does not control the shared owner runtime
- local project databases remain the authority for business data, project membership, profiles, and RLS; application tables should reference the verified JWT `sub` as an external identity rather than treating local `auth.users` as the user authority
- disabling shared mode restores per-project GoTrue only after the operator has planned user/config migration; SupaCloud does not silently copy global users into tenant databases
- the owner must use ES256 or RS256 signing so dependents can verify public JWKS without receiving the owner's private key; enabling shared mode with HS256-only owner signing is rejected
- shared dependents use only the SupAuth owner plus their legacy API-key verification material; a dependent `third_party_auth` issuer is not admitted while shared mode is enabled because PostgREST cannot bind payload claims to key provenance
- official Realtime tenant auth currently accepts a single HS256 secret rather than JWKS, so authenticated Realtime subscriptions are explicitly unsupported for shared dependents until the upstream runtime supports asymmetric JWKS

This prevents duplicate authentication authorities and avoids exposing the shared global user directory through every tenant's Studio panel.

### 2. Caddy API-Driven Gateway ⭐ Implemented
Caddy runs as a native systemd service, fully managed via the Caddy Admin API:
- `GatewayService.ensureServiceAndRoute()` creates/updates Caddy routes per tenant.
- Per-route CORS, rate-limiting, auth forwarding, and websocket behavior are rendered dynamically into JSON config.
- Global Automatic HTTPS, security response headers, and TLS issuance policy are configured at the gateway level.
- **Programmable Rate Limiting**: Per-tenant rate limits can be set via `PUT /v1/projects/:ref/gateway/rate-limit` (supports tier presets or custom second/minute/hour values).
- No manual config editing or daemon reload workflow — all changes take effect via Admin API publishing.

### 3. Storage API
SupaCloud serves Supabase-compatible Storage through Management API storage routes. Binary data is written to the configured physical backend, while metadata is written to the tenant database with Row Level Security context applied.

Current safeguards:

- tenant resolution is derived from trusted project headers, API keys, or host routing and rejects mismatches
- signed upload URLs are one-time tokens consumed atomically before accepting the upload body
- object size metadata is cast defensively so malformed metadata cannot break dashboard or list queries
- upload and move paths can register compensation cleanup for newly written physical objects when metadata persistence fails

### 4. Real-Time Features ⭐ Implemented

| Feature | Protocol | Description |
|---------|----------|-------------|
| **SSE Log Stream** | `text/event-stream` | `GET /v1/projects/:ref/logs/stream` — real-time `journalctl --follow` streaming, per-tenant max 5 connections |
| **WebSocket Tasks** | `ws://` | `ws://host/ws/tasks` — real-time task progress broadcast from TaskWorker |
| **DB Graceful Degradation** | HTTP | `503 + Retry-After` on transient DB failures, exponential backoff retry (100ms → 400ms → 1600ms) |

### 5. Dashboard And Storage Hot Paths

The Web Console project dashboard uses `GET /v1/projects/:ref/dashboard/summary` for the initial aggregate view. The endpoint caches short-lived dashboard metrics and keeps partial failures isolated, which avoids issuing many tenant SQL queries from the browser hot path.

Storage object listing is paginated and sorted in SQL rather than loading full object sets into application memory.

### 6. Realtime API & Admin Console
- **Realtime (Elixir)**: Very resource-intensive as it listens to PostgreSQL logical replication slots. Recommended to remain a shared premium feature or require dedicated high-tier clusters.
- **Web Console (SVAdmin Hybrid Mount)**: The central dashboard (`web-console`) is fully multi-tenant aware via URL routing parameter `[ref]`. It acts as the Host/SuperAdmin dashboard, but internally relies on the `@svadmin/core` `DataProvider`. When standard CRUD is requested (e.g. Auth Users or DB Tables), the root `+layout.svelte` dynamically bridges SvelteKit routing into SVAdmin's resources array. 
  - This allows the UI to render `svadmin` `<AutoTable>` and `useList` hooks seamlessly while hitting RESTful routes securely proxied to the tenant specific GoTrue / PostgREST instances via the Caddy gateway.

### 7. Edge Function Preheating ⭐ Implemented
When a function is deployed via the Management API:
1. `Bun.build()` bundles the source into a self-contained `.js`
2. `invalidateCache()` evicts the old version from Worker thread caches
3. `POST /preheat/:ref/:slug` → Worker imports the module ahead of time
4. First real request hits warm LRU cache → **0ms cold-start**

### 8. Private Cache Data Plane ⭐ Implemented

- `pgredis-runtime` owns per-tenant PostgreSQL pools and bounded L1 caches; cross-tenant Worker singletons own neither.
- Edge Workers call a stable `globalThis.SupaCloud.pgredis` facade. The parent runtime injects only a short-lived, project-scoped capability for the active request.
- Tenant database credentials are loaded from the dedicated, runtime-owned `/etc/supabase/pgredis-tenants/<ref>_pgredis.env` files and must use the matching `role_<ref>` role; Edge Runtime never mounts this directory.
- Mutations and invalidation notifications commit in the same PostgreSQL transaction. Reconnect clears the tenant L1 before reads resume.
- Web Console operations go through the authenticated Management API proxy. The browser never receives the internal service token or connects to port `9010`; the proxy exposes bounded platform/project status, exact-key operations, and a project-ref-confirmed namespace flush.
- Namespace flush deletes cached rows and emits the `clearNamespace` invalidation in one PostgreSQL transaction, then clears that runtime instance's L1 only after commit.
- The service has no Caddy route or host port and does not implement queues or platform rate limiting. PGMQ and Caddy remain the sole owners of those capabilities.

## Additional Issues Found

### authenticator Role CONNECT Privilege

`db_manager.sh` now grants `CONNECT ON DATABASE` to the `authenticator` role and creates it if missing. This is required for PostgREST to connect to tenant databases.

### Disk Space Pre-Check

`db_manager.sh` now checks available disk space (default: 10GB minimum) before creating databases, preventing WAL write failures that can crash the entire Patroni cluster.
