# Supabase Upstream Adoption

This document records the Supabase capabilities that SupaCloud exposes or
intentionally keeps optional. It is a compatibility boundary, not a second
implementation of the Supabase platform.

## Stable baseline

The repository uses `@supabase/supabase-js` `2.117.3` as the shared SDK
baseline for Edge Runtime, Management API, SupaCloud JS, Compiler, and Lite.
Generated application starters use the same peer dependency.

The official Supabase CLI compatibility adapter recommends `2.120.0` for
`SUPABASE_CLI_VERSION`; an installed binary or an explicit
`SUPACLOUD_SUPABASE_CLI_BIN` still takes precedence.

## Capabilities already implemented

These capabilities are already part of SupaCloud and must be extended through
their existing routes, contracts, and tests:

- Passkey/WebAuthn configuration and `/passkeys` proxying for GoTrue-backed
  projects.
- Project-scoped OAuth 2.1/OIDC server migration, discovery, JWKS, client CRUD,
  and KMS-backed RS256 configuration.
- Stateless Streamable HTTP MCP surfaces for platform, project, developer, and
  application contexts, with tenant authorization and plan-only writes.
- Supabase Storage Vector API compatibility backed by the project vector
  service.
- Supabase Queues compatibility through the `pgmq_public` API.
- `pg_graphql` compatibility through the real PostgreSQL extension.

## Optional application packages

`@supabase/ssr` and `@supabase/server` remain application-layer dependencies.
They are not added to SupaCloud Runtime or Management API because those
packages own framework/server-client construction, while SupaCloud owns the
project Auth and Management API boundary. Application starters may add them
when a framework-specific SSR entrypoint is generated.

## Deliberately deferred

- TanStack DB Supabase adapters remain optional until their public API and
  persistence/sync contract stabilizes.
- Analytics Buckets remain an infrastructure capability rather than a core
  runtime dependency.
- Vector Buckets are exposed through the existing compatibility surface; they
  do not replace the current `pgvector` plus PostgreSQL hybrid-search path.

## Acceptance

An upstream adoption change must pass the affected package's focused tests,
the official SDK/CLI compatibility harness where applicable, and
`git diff --check`. A package version bump alone is not evidence of live
Auth, Realtime, Storage, GraphQL, or MCP compatibility.
