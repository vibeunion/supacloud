# End-to-end type contracts

SupaCloud uses one explicit contract chain from persistence to the browser:

```text
schema / migrations
  -> database contract manifest
  -> repository result
  -> domain/application contract
  -> Elysia + TypeBox HTTP contract
  -> Eden-compatible client
  -> frontend view model
```

## Rules

- TypeBox is the canonical request, response and runtime validation schema.
- Effect is the canonical application execution and typed failure model for
  compiler-managed features. Routes declare dependencies, public error mappings,
  timeout and retry policy explicitly.
- Drizzle owns table declarations, migrations, transactions and general reads or
  writes. Reylo owns fixed, read-only queries whose SQL is compiled into a
  standalone build.
- Database row types are never exported directly as browser API types. Domain
  mapping and a stable HTTP DTO are required at the API boundary.
- The compiler core owns orchestration, manifest format, fingerprints and drift
  checks. Database engines belong to adapters and build jobs, never to the
  browser or compiler runtime.
- Generated files are build products. They must contain their source fingerprint,
  adapter version and a clear generated header; hand edits are rejected by check
  commands.

## Database contract manifest

`@supacloud/compiler` emits `database.manifest.json`. It records the ordered
migrations, hashed inputs, hashed outputs and a schema fingerprint. Consumers
must fail closed when the fingerprint is stale or the manifest is malformed.
Only configured protocols are emitted, so a project that uses PostgREST does not
silently acquire Drizzle or GraphQL types.

## Feature workflow

New work should start with `supacloud feature create <name>` and keep the
vertical slice together:

```text
feature/
  domain/          business state and tagged errors
  application/     Effect programs and ports
  contracts/       TypeBox schemas and DTOs
  infrastructure/  Drizzle or Reylo adapters
  http/             Elysia routes
```

The first implementation target is a complete read or command path. Migrate
legacy routes one vertical slice at a time; do not introduce a second schema
library or copy a DTO into the frontend by hand.
