# SupaCloud Documentation

## Quick Links

- [CLI Guide](./cli-guide.md) - User CLI vs admin CLI entrypoints and command boundaries
- [Deploy Guide](./deploy-guide.md) - Complete deployment guide
- [Deploy API](./deploy-api.md) - Deployment API reference
- [Configuration Example](./supacloud.yml.example) - Configuration file example
- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - Product positioning and feature comparison

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
- [China OAuth Integration](./china-oauth-integration.md) - China OAuth (WeChat, Alipay, DingTalk)
- [WeChat Auth Integration](./wechat-auth-integration.md) - WeChat Mini Program login

## Operations

- [CLI Guide](./cli-guide.md) - `@supacloud/cli` and `@supacloud/admin`
- [PostgREST Runtime Lifecycle](./postgrest-runtime-lifecycle.md) - Component-level PostgREST desired state, pause/resume/status, and reconciliation
- [Upgrade to Pigsty 4.4](./upgrade-to-pigsty-4.4.md) - Pigsty and Supabase compatibility upgrade guide
- [Docker PostgreSQL 4.4 Upgrade](./upgrade-postgres-docker-4.4.md) - Docker-specific compatibility, backup, and major-version safety guide
- [Troubleshooting Podman DNS](./troubleshooting-podman-dns.md) - Podman DNS troubleshooting

## Development

- [Edge Runtime Guide](./edge-runtime-guide.md) - Bun + Elysia Edge Functions runtime architecture
- [Background Functions](./background-functions.md) - Async Edge Function tasks, retries, logs, and cancellation
- [Background Functions With supabase-js](./background-functions-supabase-js-tutorial.md) - Tenant SDK tutorial for invoke, polling, cancel, DLQ, lifecycle webhooks, and queues
- [Background Functions API Reference](./background-functions-api-reference.md) - Headers, task states, control-plane endpoints, and runtime semantics
- [@supacloud/js](./supacloud-js.md) - Official platform SDK layered on top of `supabase-js`, including tasks, lifecycle webhooks, queues, and OAuth helpers
- [Queues PGMQ Migration Guide](./queues-pgmq-migration.md) - Migration notes for Supabase Queues compatibility and SupaCloud queue extensions

## Product Positioning

- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - When to choose SupaCloud, Supabase Cloud, or official self-hosted Supabase
