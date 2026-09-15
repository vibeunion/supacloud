# SupaCloud Documentation

[English](./README.md) | [简体中文](./README.zh-CN.md)

## Quick Links

- [CLI Guide](./cli-guide.md) - User CLI vs admin CLI entrypoints and command boundaries
- [Project Endpoint Projection](./project-endpoint-projection.md) - Authoritative API/Auth/Studio origins and project/Admin read boundaries
- [Deploy Guide](./deploy-guide.md) - Complete deployment guide
- [Deploy API](./deploy-api.md) - Deployment API reference
- [Configuration Example](./supacloud.yml.example) - Configuration file example
- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - Product positioning and feature comparison
- [Database Environment Promotion](./database-environment-promotion.md) - Local, preview, staging, and production migration workflow

## Architecture

- [Multi-Tenant Architecture](./architecture-multi-tenant.md) - Multi-tenant architecture design
- [Multi-Tenant Management](./multi-tenant-management.md) - Management API specification, auth boundaries, and operational hardening
- [Enterprise Architecture Readiness](./enterprise-architecture-readiness.md) - Infrastructure boundaries, SLO model, recovery acceptance, and release governance ([中文](./enterprise-architecture-readiness.zh-CN.md))

## Deployment

- [Deploy Guide](./deploy-guide.md) - Full deployment guide
- [Deploy API](./deploy-api.md) - Deployment API documentation
- [CI/CD Integration](./ci-cd-integration.md) - CI/CD integration with GitHub webhooks
- [Frontend Hosting](./frontend-hosting.md) - SupaCloud Pages static site hosting
- [Release Control Automation & Canary Spec](./release-control-automation-spec.md) - Proposed contracts for headless PKCE canary, batch function releases, and CAS rollback primitives

## Authentication

- [OAuth Providers](./oauth-providers.md) - OAuth provider configuration
- [OAuth 2.1 / OIDC Provider](./oauth-oidc-provider.md) - Project-scoped OAuth server migration, discovery, JWKS, and OAuth client management
- [GoTrue v2.191.0 to v2.193.0 Historical Upgrade Baseline](./gotrue-v2.193-upgrade.md) - Historical checksums, additive migration read-back, opt-in provider linking, MFA acceptance, and rollback boundary
- [China OAuth Integration](./china-oauth-integration.md) - China OAuth (WeChat, Alipay, DingTalk)
- [WeChat Auth Integration](./wechat-auth-integration.md) - WeChat Mini Program login

## Operations

- [CLI Guide](./cli-guide.md) - `@supacloud/cli` and `@supacloud/admin`
- [Optional AI Operations MCP](./mcp-ai-operations.md) - Streamable HTTP MCP server, tools, capabilities, and plan-only policy ([中文](./mcp-ai-operations.zh-CN.md))
- [AI Operations MCP Test Requirements](./mcp-ai-operations-test-requirements.en.md) - Protocol, authorization, safety, and testing requirements ([中文](./mcp-ai-operations-test-requirements.md))
- [Pigsty Backup Operations](./pigsty-backup-operations.md) - pgBackRest inventory verification, PITR planning, and recovery drills ([中文](./pigsty-backup-operations.zh-CN.md))
- [Observability](./observability.en.md) - VictoriaLogs + in-process collector baseline, Prometheus metrics, and SLO definitions ([中文](./observability.md))
- [Project Endpoint Projection](./project-endpoint-projection.md) - Fixed endpoint schema, commands, and readiness limitations
- [PostgREST Runtime Lifecycle](./postgrest-runtime-lifecycle.md) - Component-level PostgREST desired state, pause/resume/status, and reconciliation
- [pgredis Runtime](./pgredis-runtime.md) - Private cache data plane, control-plane APIs, Web Console operations, and safety boundaries
- [Platform Component Upgrade Notes](./platform-component-upgrade-notes.md) - Breaking changes, migrations, optional features, and rollback notes for current runtime components
- [Upgrade to Pigsty 4.5](./upgrade-to-pigsty-4.5.md) - Current Pigsty version pin and upgrade validation
- [Historical Pigsty 4.4 compatibility migration](./upgrade-to-pigsty-4.4.md) - Analytics and Supabase compatibility migration background
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
- [Application Business State Machines](./business-state-machines.md) - Maker-Checker transition RPC, audit, versioning, and XState projection pattern
- [PowerSync Local-First Integration](./powersync-local-first.md) - Self-hosted sync boundary, replication readiness, RLS upload path, ELN conflicts, and cleanup
- [Application Architecture Guide](./application-architecture.md) - Scalable monorepo, migration, Function, worker, and contract boundaries for SupaCloud applications
- [Application Framework](./application-framework.md) - Angular-style modules, compile-time DI, and Elysia runtime (`@supacloud/app` / `compiler` / `elysia`)
- [Route Contract Migration](./route-contract-migration.md) - Schema-first routes, generated client decoding, OpenAPI, and Management API registry migration
- [Database Governance](./database-governance.md) - RLS/RPC as first-class resources with catalog reconcile and SQL lint (`@supacloud/db`)
- [Application Platform Primitives](./application-platform-primitives.md) - Custom PostgREST schemas, transactional command receipts, and immutable artifact lineage

## Product Positioning

- [SupaCloud vs Supabase](./supacloud-vs-supabase.md) - When to choose SupaCloud, Supabase Cloud, or official self-hosted Supabase
