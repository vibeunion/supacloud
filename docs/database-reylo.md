# Reylo control-plane queries

Reylo types fixed Management API control-plane reads against the live
PostgreSQL schema. Production builds do not need a database: CI generates a
per-commit `.reylo` cache with a real schema, then every build target consumes
that cache offline.

## Query scope

Production queries under `packages/management-api/src/db/reylo/queries` cover:

- full task row by id, with or without a project scope
- full task attempt list
- task statistics summary, trend and top failures

The directory also keeps the original read-only pilot queries for diagnostics:
project task list, due task list, status counts, project by ref and
organization by id.

All queries use explicit columns and named parameters. None use `select *`,
`returning *`, dynamic SQL, DDL, RLS or tenant-database access.

## Lifecycle

```text
schema job (PostgreSQL)
  -> apply the real control-plane schema
  -> tsc --runExternalCode with the Reylo content mapper
  -> run live control-plane query tests
  -> upload .reylo as a commit-scoped artifact

build jobs
  -> download the same commit's .reylo artifact
  -> reylo/esbuild inlines each .sql query
  -> bun build --compile
  -> run the native target in isolation
```

`.reylo` is generated state and is never committed. The cache manifest records
the commit, generation time and query count. A build fails closed when neither a
matching cache nor `DATABASE_URL` is available.

## Commands

Generate or refresh the cache against a development database:

```sh
cd packages/management-api
DATABASE_URL=postgres://... bun run reylo:contracts
```

Run the live query tests:

```sh
cd packages/management-api
DATABASE_URL=postgres://... bun run reylo:test
```

Type-check the query modules with inferred types:

```sh
cd packages/management-api
DATABASE_URL=postgres://... bun run typecheck:reylo
```

Build a standalone binary from cache only:

```sh
cd packages/management-api
env -u DATABASE_URL bun run build:amd64
```

`bun run typecheck` intentionally uses a `.sql` shim so ordinary type checking
does not need a database. `typecheck:reylo` excludes that shim and enforces the
real inferred query contract.

## Production enablement

The compiled standalone build defines `SUPACLOUD_REYLO_QUERIES=1`, so production
uses Reylo for the three task repository paths. Tests and normal source runs
leave it unset and keep the legacy SQL fallback, so unit tests do not require a
database or runtime Reylo engine.

The compiled bundle contains the query text and Reylo decoder, but not the
native engine or `.sql` files. The engine, content mapper and cache are build
and type-check inputs only.

## CI

`Management API CI` runs the `Reylo Contracts` job with PostgreSQL 18, uploads
`management-api-reylo-<sha>`, and hands it to the unit and binary build jobs.
The Management API release job initializes the same schema from the release tag
before building. This keeps the schema source authoritative without committing
generated files.
