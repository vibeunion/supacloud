# SupaCloud Multi-Tenant Architecture

> **Status**: Implemented (Option C)  
> **Last Updated**: 2026-02-25

## Current Architecture

```
┌─────────────┐     ┌──────────┐     ┌─────────────────────────────────┐
│  Nginx      │────▶│  Kong    │────▶│  Shared Container Layer         │
│  (per-tenant│     │  Gateway │     │  ┌──────────┐ ┌──────────────┐  │
│   routing)  │     │          │     │  │PostgREST │ │ GoTrue(Auth) │  │
└─────────────┘     └──────────┘     │  │(single)  │ │ (single)     │  │
                                     │  └────┬─────┘ └──────┬───────┘  │
                                     └───────┼──────────────┼──────────┘
                                             │              │
                    ┌────────────────────────┼──────────────┘
                    ▼                        ▼
          ┌──────────────────────────────────────────┐
          │  PostgreSQL (Pigsty)                      │
          │  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
          │  │supa_proj1│ │supa_proj2│ │supa_projN│  │
          │  │(isolated)│ │(isolated)│ │(isolated)│  │
          │  └──────────┘ └──────────┘ └──────────┘  │
          └──────────────────────────────────────────┘
```

## Core Issue

PostgREST and GoTrue are **global singletons** bound to a single `PGRST_DB_URI` and `PGRST_JWT_SECRET` at startup. They cannot dynamically switch databases or JWT secrets per-request.

**Impact**: Only **one tenant** can be active at a time. Requests from other tenants will fail with authentication errors or hit the wrong database.

## Proposed Solutions

### Option A: Schema-Based Soft Isolation (Lightweight)

Use PostgreSQL schemas + RLS within a single database. All tenants share one DB, one PostgREST, one GoTrue.

| Pros | Cons |
|------|------|
| Minimal resource usage | Weaker isolation |
| Simple deployment | Complex RLS policy management |
| No container orchestration needed | Noisy neighbor risks |

**Implementation**: Add `tenant_id` column + RLS policies. PostgREST uses JWT claim `x-tenant-id` to set `current_setting('request.jwt.claims')`.

### Option B: Per-Tenant Container Groups (Strong Isolation)

Each tenant gets its own PostgREST + GoTrue containers, connecting to its dedicated database.

| Pros | Cons |
|------|------|
| Full isolation | High resource usage |
| Independent JWT secrets | Requires container orchestration |
| Per-tenant scaling | Complex provisioning |

**Implementation**: Management API calls Docker/Podman API to spin up per-tenant containers with unique ports. Kong routes traffic to the correct container port based on `X-Project-Ref` header.

### Option C: PostgREST Multi-Tenant Proxy (Balanced) ⭐ Recommended

> **Note**: SupaCloud already uses Kong (`gateway_manager.sh` manages consumers, JWT plugins, rate limiting, and CORS via Kong Admin API at `localhost:8001`). This makes Option C the most natural upgrade path — leveraging existing infrastructure.

Deploy a Kong plugin that rewrites the PostgREST database connection per-request based on `X-Project-Ref` header.

| Pros | Cons |
|------|------|
| Leverages **existing** Kong infrastructure | Requires PostgREST 13+ or custom pgrst-proxy |
| Moderate resource usage | JWT validation per-tenant adds complexity |
| Database-level isolation preserved | Custom Kong plugin development needed |
| No container orchestration needed | |

**Implementation**: Kong plugin maps `X-Project-Ref` → tenant DB URI + JWT secret, passes them via PostgREST config override headers. Each request hits the correct tenant database with the correct JWT validation.

## Recommendation

Since Kong is already deployed and actively used (`gateway_manager.sh`):

1. **Recommended**: Option C (Kong-based multi-tenant proxy) — lowest friction, leverages existing infrastructure
2. **Fallback**: Option B (per-tenant containers) if PostgREST doesn't support dynamic DB override
3. **Quick MVP**: Option A (schema isolation) for immediate multi-tenant capability

## Additional Issues Found

### authenticator Role CONNECT Privilege

`db_manager.sh` now grants `CONNECT ON DATABASE` to the `authenticator` role and creates it if missing. This is required for PostgREST to connect to tenant databases.

### Nginx ACME Compatibility

`router_manager.sh` now detects the SSL mode (`acme` / `certbot` / `self-signed`) before generating Nginx configs, preventing crashes on non-Pigsty Nginx builds.

### Disk Space Pre-Check

`db_manager.sh` now checks available disk space (default: 10GB minimum) before creating databases, preventing WAL write failures that can crash the entire Patroni cluster.
