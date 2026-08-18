# SupaCloud Documentation

## Quick Links

- [CLI Guide](./cli-guide.md) - User CLI vs admin CLI entrypoints and command boundaries
- [Project Endpoint Projection](./project-endpoint-projection.md) - Authoritative API/Auth/Studio origins, CLI boundaries, and legacy backup compatibility boundary
- [Deploy Guide](./deploy-guide.md) - Complete deployment guide
- [Deploy API](./deploy-api.md) - Deployment API reference
- [Configuration Example](./supacloud.yml.example) - Configuration file example
- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - Product positioning and feature comparison
- [Database Environment Promotion](./database-environment-promotion.md) - Local, preview, staging, and production migration workflow

## Architecture

- [Multi-Tenant Architecture](./architecture-multi-tenant.md) - Multi-tenant architecture design
- [Multi-Tenant Management](./multi-tenant-management.md) - Management API specification, auth boundaries, and operational hardening

## Deployment

- [Deploy Guide](./deploy-guide.md) - Full deployment guide
- [Deploy API](./deploy-api.md) - Deployment API documentation
- [CI/CD Integration](./ci-cd-integration.md) - CI/CD integration with GitHub webhooks
- [Frontend Hosting](./frontend-hosting.md) - SupaCloud Pages static site hosting

## Authentication

- [OAuth Providers](./oauth-providers.md) - OAuth provider configuration
- [OAuth 2.1 / OIDC Provider](./oauth-oidc-provider.md) - Project-scoped OAuth server migration, discovery, JWKS, and OAuth client management
- [GoTrue v2.191.0 to v2.193.0 Historical Upgrade Baseline](./gotrue-v2.193-upgrade.md) - Historical checksums, additive migration read-back, opt-in provider linking, MFA acceptance, and rollback boundary
- [China OAuth Integration](./china-oauth-integration.md) - China OAuth (WeChat, Alipay, DingTalk)
- [WeChat Auth Integration](./wechat-auth-integration.md) - WeChat Mini Program login

## Operations

- [CLI Guide](./cli-guide.md) - `@supacloud/cli` and `@supacloud/admin`
- [PostgREST Runtime Lifecycle](./postgrest-runtime-lifecycle.md) - Component-level PostgREST desired state, pause/resume/status, and reconciliation
- [pgredis Runtime](./pgredis-runtime.md) - Private cache data plane, control-plane APIs, Web Console operations, and safety boundaries
- [Platform Component Upgrade Notes](./platform-component-upgrade-notes.md) - Breaking changes, migrations, optional features, and rollback notes for current runtime components
- [Upgrade to Pigsty 4.4](./upgrade-to-pigsty-4.4.md) - Pigsty and Supabase compatibility upgrade guide
- [Docker PostgreSQL 4.4 Upgrade](./upgrade-postgres-docker-4.4.md) - Docker-specific compatibility, backup, and major-version safety guide
- [Troubleshooting Podman DNS](./troubleshooting-podman-dns.md) - Podman DNS troubleshooting

## Development

- [Edge Runtime Guide](./edge-runtime-guide.md) - Bun + Elysia Edge Functions runtime architecture
- [Observability](./observability.md) - VictoriaLogs + 内置采集器基线、Grafana 可选运行方式，以及禁止 Logflare 的规范
- [Background Functions](./background-functions.md) - Async Edge Function tasks, retries, logs, and cancellation
- [Background Functions With supabase-js](./background-functions-supabase-js-tutorial.md) - Tenant SDK tutorial for invoke, polling, cancel, DLQ, lifecycle webhooks, and queues
- [Background Functions API Reference](./background-functions-api-reference.md) - Headers, task states, control-plane endpoints, and runtime semantics
- [@supacloud/js](./supacloud-js.md) - Official platform SDK layered on top of `supabase-js`, including tasks, lifecycle webhooks, queues, and OAuth helpers
- [Queues PGMQ Migration Guide](./queues-pgmq-migration.md) - Migration notes for Supabase Queues compatibility and SupaCloud queue extensions
- [Durable Workflows](./durable-workflows.md) - Service-role-only PostgreSQL/PGMQ workflow execution and DBOS design rationale

## Product Positioning

- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - When to choose SupaCloud, Supabase Cloud, or official self-hosted Supabase
