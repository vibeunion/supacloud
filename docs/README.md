# SupaCloud Documentation

## Quick Links

- [Deploy Guide](./deploy-guide.md) - Complete deployment guide
- [Deploy API](./deploy-api.md) - Deployment API reference
- [Configuration Example](./supacloud.yml.example) - Configuration file example

## Architecture

- [Multi-Tenant Architecture](./architecture-multi-tenant.md) - Multi-tenant architecture design
- [Multi-Tenant Management](./multi-tenant-management.md) - Multi-tenant management specification

## Deployment

- [Deploy Guide](./deploy-guide.md) - Full deployment guide
- [Deploy API](./deploy-api.md) - Deployment API documentation
- [CI/CD Integration](./ci-cd-integration.md) - CI/CD integration with GitHub webhooks
- [Frontend Hosting](./frontend-hosting.md) - SupaCloud Pages static site hosting

## Authentication

- [OAuth Providers](./oauth-providers.md) - OAuth provider configuration
- [China OAuth Integration](./china-oauth-integration.md) - China OAuth (WeChat, Alipay, DingTalk)
- [WeChat Auth Integration](./wechat-auth-integration.md) - WeChat Mini Program login

## Operations

- [Upgrade to Pigsty 4.1](./upgrade-to-pigsty-4.1.md) - Pigsty upgrade guide
- [Troubleshooting Podman DNS](./troubleshooting-podman-dns.md) - Podman DNS troubleshooting

## Development

- [MCP Server Guide](./mcp-server-guide.md) - MCP Server development guide
- [Edge Runtime Guide](./edge-runtime-guide.md) - Bun + Elysia Edge Functions runtime architecture
- [Background Functions](./background-functions.md) - Async Edge Function tasks, retries, logs, and cancellation
- [Background Functions With supabase-js](./background-functions-supabase-js-tutorial.md) - Tenant SDK tutorial for invoke, polling, cancel, and DLQ
- [Background Functions API Reference](./background-functions-api-reference.md) - Headers, task states, control-plane endpoints, and runtime semantics
- [@supacloud/js](./supacloud-js.md) - Official platform SDK layered on top of `supabase-js`

## Security

- [MCP Security Model](./mcp-server-guide.md#4-安全和最佳实践) - MCP tool annotations, destructiveHint confirmation model
