# SupaCloud Multi-Tenant Architecture

> **Status**: Implemented (Option C+)  
> **Last Updated**: 2026-02-25

## Current Architecture

```
┌─────────────┐     ┌──────────┐     ┌────────────────┐     ┌───────────────┐
│ Nginx Proxy │ ──► │   Kong   │ ──► │ PostgREST(:310x)──► │ supa_tenant_1 │
└─────────────┘     │(:80/8000)│     │ GoTrue(:410x)  │     └───────────────┘
                    └──────────┘     │ (per-tenant)   │     ┌───────────────┐
                                     └────────────────┘ ──► │ supa_tenant_N │
                                                            └───────────────┘
```

> **Note**: SupaCloud natively relies on Kong. 
To support proper multi-tenant isolation safely and effectively without massive monolithic overhead, we adopted Option C+ (Per-Tenant Processes + Declarative Routing).

### 1. PostgREST & GoTrue (Per-Tenant Processes) ⭐ Implemented
These core REST, GraphQL, and Authentication services are extremely lightweight (20-50MB RAM). 
We spin up a unique `postgrest` AND `gotrue` process for *every* tenant dynamically using `systemd` templates (`supacloud-pgrst@.service` and `supacloud-gotrue@.service`):
- They bind to unique deterministically generated ports (e.g., PostgREST starts from 3100, GoTrue starts from 4100).
- They connect securely to the tenant's isolated Postgres database (`supa_<ref>`) using unique credentials.
- They possess isolated `JWT_SECRET`s to ensure cryptographic boundary security (users from Tenant A cannot authenticate into Tenant B).

### 2. Kong Declarative Routing ⭐ Implemented
Since standard Supabase Kong is run in `KONG_DATABASE=off` (DB-less) mode, Admin API routing edits are ephemeral and ineffective. We use dynamic **declarative configuration**:
- Whenever a tenant is created or removed, `gateway_manager.sh` manages a YAML fragment in `/etc/supabase/kong_tenants/<ref>.yml`.
- These are merged into the global `kong.yml` and hot-reloaded (`kong reload`).
- `X-Project-Ref: <ref>` headers reliably route traffic to the tenant's exact local port for Database REST (`/rest/v1`, `/graphql/v1`) and Auth (`/auth/v1`).

### 3. Storage API
The Node.js based Storage API handles binary uploads to Object Storage AND metadata insertions into PostgreSQL (including Row Level Security checks).
If globally shared, tenant uploads would pollute the default database's `storage.objects` table and bypass tenant RLS.
**Status**: To be fully isolated, Storage API must eventually be separated into per-tenant processes just like GoTrue, connecting to the specific tenant's database.

### 4. Realtime API & Studio
- **Realtime (Elixir)**: Very resource-intensive as it listens to PostgreSQL logical replication slots. Recommended to remain a shared premium feature or require dedicated high-tier clusters.
- **Studio**: Tied to a single connection pool. It serves as the Host/SuperAdmin dashboard. Tenant-level UI should use generic database tooling (e.g., PGWeb, Adminer) dynamically provisioned based on connection strings.

## Additional Issues Found

### authenticator Role CONNECT Privilege

`db_manager.sh` now grants `CONNECT ON DATABASE` to the `authenticator` role and creates it if missing. This is required for PostgREST to connect to tenant databases.

### Nginx ACME Compatibility

`router_manager.sh` now detects the SSL mode (`acme` / `certbot` / `self-signed`) before generating Nginx configs, preventing crashes on non-Pigsty Nginx builds.

### Disk Space Pre-Check

`db_manager.sh` now checks available disk space (default: 10GB minimum) before creating databases, preventing WAL write failures that can crash the entire Patroni cluster.
