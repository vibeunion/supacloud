# SupaCloud Multi-Tenant Architecture

> **Status**: Implemented (Option C+ with Kong Native API-Driven Gateway)  
> **Last Updated**: 2026-04-06

## Current Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Kong (Native │ ──► │ PostgREST(:310x) ──► │ supa_tenant_1 │
│  OpenResty)  │     │ GoTrue(:410x)    │     └───────────────┘
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
```

> **Note**: SupaCloud natively relies on **Kong (DB-backed, API-driven)** running as a systemd service.
> All tenant routing, rate limiting, CORS, and SSL are managed via Kong Admin API — no manual config file edits needed.

### 1. PostgREST & GoTrue (Per-Tenant Processes) ⭐ Implemented
These core REST, GraphQL, and Authentication services are extremely lightweight (20-50MB RAM). 
We spin up a unique `postgrest` AND `gotrue` process for *every* tenant dynamically using `systemd` templates (`supacloud-pgrst@.service` and `supacloud-gotrue@.service`):
- They bind to unique deterministically generated ports (e.g., PostgREST starts from 3100, GoTrue starts from 4100).
- They connect securely to the tenant's isolated Postgres database (`supa_<ref>`) using unique credentials.
- They possess isolated `JWT_SECRET`s to ensure cryptographic boundary security (users from Tenant A cannot authenticate into Tenant B).

### 2. Kong API-Driven Gateway ⭐ Implemented
Kong runs in **DB-backed mode** (PostgreSQL) as a native systemd service, fully managed via the Kong Admin API:
- `GatewayService.ensureServiceAndRoute()` creates/updates Kong services and routes per tenant.
- Per-route plugins (CORS, rate-limiting, JWT, request-transformer) are applied dynamically.
- Global plugins (Gzip compression, security response headers, ACME SSL) are configured at the Kong level.
- **Programmable Rate Limiting**: Per-tenant rate limits can be set via `PUT /v1/projects/:ref/gateway/rate-limit` (supports tier presets or custom second/minute/hour values).
- No manual YAML editing or `kong reload` — all changes take effect immediately via Admin API.

### 3. Storage API
The Node.js based Storage API handles binary uploads to Object Storage AND metadata insertions into PostgreSQL (including Row Level Security checks).
If globally shared, tenant uploads would pollute the default database's `storage.objects` table and bypass tenant RLS.
**Status**: To be fully isolated, Storage API must eventually be separated into per-tenant processes just like GoTrue, connecting to the specific tenant's database.

### 3. Real-Time Features ⭐ Implemented

| Feature | Protocol | Description |
|---------|----------|-------------|
| **SSE Log Stream** | `text/event-stream` | `GET /v1/projects/:ref/logs/stream` — real-time `journalctl --follow` streaming, per-tenant max 5 connections |
| **WebSocket Tasks** | `ws://` | `ws://host/ws/tasks` — real-time task progress broadcast from TaskWorker |
| **DB Graceful Degradation** | HTTP | `503 + Retry-After` on transient DB failures, exponential backoff retry (100ms → 400ms → 1600ms) |

### 4. Storage API
The Node.js based Storage API handles binary uploads to Object Storage AND metadata insertions into PostgreSQL (including Row Level Security checks).
If globally shared, tenant uploads would pollute the default database's `storage.objects` table and bypass tenant RLS.
**Status**: To be fully isolated, Storage API must eventually be separated into per-tenant processes just like GoTrue, connecting to the specific tenant's database.

### 5. Realtime API & Admin Console
- **Realtime (Elixir)**: Very resource-intensive as it listens to PostgreSQL logical replication slots. Recommended to remain a shared premium feature or require dedicated high-tier clusters.
- **Web Console (SVAdmin Hybrid Mount)**: The central dashboard (`web-console`) is fully multi-tenant aware via URL routing parameter `[ref]`. It acts as the Host/SuperAdmin dashboard, but internally relies on the `@svadmin/core` `DataProvider`. When standard CRUD is requested (e.g. Auth Users or DB Tables), the root `+layout.svelte` dynamically bridges SvelteKit routing into SVAdmin's resources array. 
  - This allows the UI to render `svadmin` `<AutoTable>` and `useList` hooks seamlessly while hitting RESTful routes securely proxied to the tenant specific GoTrue / PostgREST instances via the Kong proxy.

### 6. Edge Function Preheating ⭐ Implemented
When a function is deployed via the Management API:
1. `Bun.build()` bundles the source into a self-contained `.js`
2. `invalidateCache()` evicts the old version from Worker thread caches
3. `POST /preheat/:ref/:slug` → Worker imports the module ahead of time
4. First real request hits warm LRU cache → **0ms cold-start**

## Additional Issues Found

### authenticator Role CONNECT Privilege

`db_manager.sh` now grants `CONNECT ON DATABASE` to the `authenticator` role and creates it if missing. This is required for PostgREST to connect to tenant databases.

### Disk Space Pre-Check

`db_manager.sh` now checks available disk space (default: 10GB minimum) before creating databases, preventing WAL write failures that can crash the entire Patroni cluster.
