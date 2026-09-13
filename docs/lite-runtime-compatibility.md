# Lite Runtime Compatibility

The goal is to run the same application contracts on a single-project backend,
not to duplicate the Management API. Local Auth remains the default. External
identity and stricter runtime behavior are explicit opt-ins.

## Acceptance

```gherkin
Scenario: Migration identity survives an upgrade
  Given flat SQL files or timestamp folders containing migration.sql
  When Lite loads and applies reviewed target-bound migrations
  Then duplicate versions and changed applied SQL fail before pending SQL executes
  And binding values and project targets are validated by @supacloud/db

Scenario: GraphQL uses a real extension
  Given a database with the pg_graphql extension and graphql.resolve installed
  When a caller sends a query to /graphql/v1
  Then execution uses that caller's database role and verified claims
  And nested reads, introspection and mutations obey database grants and RLS
  And a missing extension is reported rather than emulated or silently skipped

Scenario: External identity cannot grant local privilege
  Given a SupAuth context verifier and an explicit local subject mapping
  When a valid external identity accesses Lite
  Then only authenticated local claims are created from trusted access decisions
  And wrong issuers, audiences, applications and unmapped users are denied
  And local login sessions do not become external identities

Scenario: Strict function defaults
  Given strict runtime mode
  When a function omits limits or background capability
  Then production-aligned limits apply and background work is denied
  And invalid declarations and broken functions prevent startup
  And development mode preserves its existing defaults

Scenario: Diagnose and measure without changing project state
  Given an uninitialized project or an existing project
  When capability doctor runs
  Then it distinguishes unverified extension support from verified availability
  And it does not initialize or migrate the project
  And a synthetic benchmark reports startup, memory, REST, RPC and function latency
```

## Configuration

The following keys live in `supabase/config.toml`. The mode can also be selected
with `--runtime-mode strict` or `SUPACLOUD_LITE_RUNTIME_MODE=strict`.

```toml
[lite]
runtime_mode = "strict"

[lite.graphql]
enabled = true
max_request_body_bytes = 1048576
statement_timeout_ms = 30000

[lite.identity]
module = "lite.identity.ts"

[lite.migration_bindings]
manifest = "supabase/migration-bindings.json"
environment = "local"
project_ref = "local"
```

All sections are optional. Do not enable GraphQL on an engine without
`pg_graphql`. An omitted GraphQL setting auto-detects the installed extension;
`enabled = true` requires it at runtime startup, and `false` disables the route.
Maintenance commands can still initialize the database and apply the extension
migration before the application is started.

For embedded callers, `startRuntimeServices: false` only disables background
services; configured identity verification and required GraphQL checks still
apply to `backend.fetch`. Database-only maintenance explicitly selects
`includeIdentity: false` and `graphql: { enabled: false }`.

### Real pg_graphql

Lite does not emulate GraphQL, translate GraphQL into hand-written SQL, or
silently proxy to another project. It checks the installed `pg_graphql` version
and the extension-owned, security-invoker
`graphql.resolve(text,jsonb,text,jsonb)` function.

- Bundled PGlite does not contain `pg_graphql` and cannot load native PostgreSQL
  shared libraries.
- Stock downloadable native PostgreSQL does not bundle `pg_graphql` either.
- Native Lite can use an operator-managed PostgreSQL installation with an
  ABI-compatible `pg_graphql` extension. Select its installation prefix with
  `--postgres-dir` or `SUPACLOUD_LITE_POSTGRES_DIR`. Lite still owns its own data
  directory, private socket and child process; this is not a connection to a
  shared production database.

For example, on a Linux host where PostgreSQL 18 and its matching extension are
already installed:

```sh
export SUPACLOUD_LITE_POSTGRES_DIR=/usr/lib/postgresql/18
supacloud-lite migrate --engine native
supacloud-lite doctor --engine native --json
supacloud-lite start --engine native
```

Add a reviewed application migration:

```sql
create extension if not exists pg_graphql;
grant usage on schema graphql to anon, authenticated, service_role;
grant execute on function graphql.resolve(text, jsonb, text, jsonb)
  to anon, authenticated, service_role;
```

Tables, columns, RLS policies and mutation privileges remain application-owned.
The extension determines the reflected schema. `/graphql/v1` accepts POST JSON,
binds variables as SQL parameters, applies the caller's role and verified JWT
claims in one transaction, and limits the search path to the configured API
schemas (default `public`). Request-body limits apply to streamed bodies too.
GraphQL errors returned by the extension retain the GraphQL envelope; transport
and database failures use sanitized errors. GET and batched request arrays are
not supported. Generated query clients and schema snapshot export use POST.
Schema export also requires explicitly enabled introspection in the selected
development database, for example the schema comment
`@graphql({"inflect_names":true,"introspection":true})`. Preserve any other
application-owned schema directives when changing that comment. Enabling the
HTTP route does not enable introspection in production.

Changing the PostgreSQL major version of an existing data directory is rejected.
Use a logical migration with separately validated binaries/extensions; do not
swap PostgreSQL installations in place as a database upgrade.

### Migration Compatibility

Both `supabase/migrations/123_name.sql` and
`supabase/migrations/123_name/migration.sql` use version `123`. Duplicate
versions, symlinked migration files and missing folder SQL are rejected.
All supplied applied SQL is compared with the ledger before any pending
migration is executed. A mismatch requires a new forward migration, not an
edit to the applied file. Historical entries without recorded SQL cannot be
automatically verified and are rejected; restore authoritative history rather
than accepting an arbitrary new checksum.

Target bindings reuse `@supacloud/db`'s reviewed manifest, source checksum,
parameter type, occurrence and target validation. Values come from environment
variables declared in that manifest. Nothing guesses a production target.
`migrate --json` and `status --json` return applied versions and a hash-only
binding attestation, without rendered SQL or binding values.

Development mode retains legacy SQL compatibility rewrites except that
`pg_graphql` extension errors are never swallowed. Strict mode preserves
migration SQL, so unavailable extensions and transaction-incompatible
`CONCURRENTLY` statements fail explicitly.

Restart and maintenance preserve application table, sequence, schema and
default ACLs. Default public-schema grants are only initialized on first boot.
Older installations can retain overly broad historical grants; this change
does not guess which existing grants were intended or revoke them in bulk.
Audit and tighten them with explicit application migrations.

### SupAuth Bridge

External identity reuses the application's shared SupAuth verifier. Install
`@supacloud/elysia` in the consuming application, not as a Lite runtime
dependency. A trusted local identity module can export:

```ts
import { createSupAuthRequestContext } from '@supacloud/elysia'
import { createSupAuthLiteIdentity } from '@supacloud/lite'
import { resolveApplicationAccess, lookupLocalUserId } from './src/identity-access'

const projectId = process.env.APP_PROJECT_ID!
export default createSupAuthLiteIdentity({
  projectId,
  context: createSupAuthRequestContext({
    issuer: process.env.SUPAUTH_ISSUER!,
    audience: process.env.SUPAUTH_AUDIENCE!,
    clientId: process.env.SUPAUTH_CLIENT_ID!,
    jwksUrl: process.env.SUPAUTH_JWKS_URL!,
    projectId,
    resolveAccess: resolveApplicationAccess,
  }),
  resolveLocalSubject: lookupLocalUserId,
})
```

The two imported access functions are application-owned trusted lookups, not
request-header parsing. `lookupLocalUserId` maps the verified issuer/subject to
a local UUID, or returns null. Lite never auto-creates users or assigns
membership. The shared verifier pins HTTPS endpoints, asymmetric algorithms,
issuer, audience and OAuth application, then resolves current application
access. Missing membership or subject mapping returns 403; verification
outages return 503. No HTTP or symmetric fallback is added.

The bridge creates only `authenticated` SQL claims, taking `tenant_id`,
`project_id` and permissions from the trusted access decision, never arbitrary
token or forwarded-header claims. REST, RPC, GraphQL, protected Functions and
Storage share this verification. Realtime uses the same verifier on joins and
token refresh, drops channels after failed refresh, and expires external-token
subscriptions. Changing permissions should invalidate/refresh active client
subscriptions; this is not an instantaneous server-pushed revocation service.

External mode disables `/auth/v1` local login and rejects locally issued user
tokens. Canonical local anon and service-role API keys retain their existing
roles; service-role credentials remain server-only. A public function explicitly
configured with `verify_jwt = false` still owns its own authentication. An
application using `createSupAuthApp` can verify its bearer itself, but that does
not grant direct Data API access without the Lite bridge.

### Strict Functions

Strict mode defaults to a 900-second invocation limit, 30 MiB request and
response limits, and a 300-second background waiting limit. Declared limits may
be lower but not exceed these caps. Background work requires explicit
`background = true`. Malformed declarations, missing declared functions and
failed imports prevent startup. Explicit secret/outbound-host allowlists retain
their existing meaning.

These are compatibility checks for trusted in-process application code, not
worker isolation. A blocked event loop cannot be preempted; module-level
side effects, direct process APIs and detached tasks are not sandboxed.
Production worker termination and atomic multi-function release manifests are
not reproduced. `doctor` reports project release manifests as unsupported.

## Verification

```sh
cd packages/supacloud-lite
bun run typecheck
bun test
# Opt-in real native backend matrix:
bun run test:native
# Build the repository's isolated PostgreSQL + pg_graphql fixture first:
docker build -t supacloud-graphql-test:pg18 ../../docker/graphql-test
bun run test:graphql
# Synthetic in-process baseline, no business data:
bun run benchmark
bun run benchmark --native
```

The GraphQL test uses Lite's real native wire implementation against an isolated
PostgreSQL container, checking extension ownership/version, role-scoped
introspection, nested RLS, mutation denial and concurrent caller isolation.
Catalog records, resolver envelopes and dynamically loaded identity claims are
validated before use; malformed values fail closed. Boundary tests use unknown
values and observable behavior instead of unchecked casts into private state.
The starter test generates the current application starter, compiles it with
the declared compiler development dependency, and loads
its real Elysia function through Lite's bundler, and checks HTTP contracts,
authorization, idempotent replay and native validated JSON responses. Its
in-memory governance fixture is test-only, not production SQL acceptance.

The benchmark reports startup and warm REST/RPC/function latency percentiles for
1,000 synthetic rows. RSS is for the Bun process only; native PostgreSQL child
memory is not included. Cold downloads, network transport, sustained
concurrency and production-scale workloads require separate measurement.
No universal speedup, memory saving or production SLA is claimed.

Type checks include the package's source, scripts and tests under `strict`,
`noImplicitOverride` and `noFallthroughCasesInSwitch`. This compatibility change
does not claim repository-wide type-safety migration: existing unchecked-index,
exact-optional-property and dependency-declaration checking gaps remain separate
work. No compiler diagnostics are disabled to pass the package gates.

`doctor --json` never creates project state or applies migrations. An existing,
stopped database can be inspected; running databases retain exclusive ownership
and must be stopped first. An uninitialized database reports GraphQL as
`unverified`, not `supported`. Required-but-unverified/missing GraphQL exits
nonzero. Identity module configuration is reported without executing the module
or pretending its external service has been authenticated.
