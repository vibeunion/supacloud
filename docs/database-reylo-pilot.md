# Reylo pilot for control-plane reads

This pilot evaluates [Reylo](https://reylo.dev) for a small set of fixed,
read-only Management API queries. It is intentionally isolated from the normal
Management API runtime and build so an unavailable development database or a
Reylo regression cannot break production startup.

## Scope

Seven queries under `packages/management-api/src/db/reylo-pilot/queries`:

- task by id
- project task list
- due task list
- task status counts
- task attempt list
- project by ref
- organization by id

All queries use explicit column lists and named parameters. None use
`select *` or `returning *`. They are read-only; the pilot does not claim write
query coverage, dynamic SQL, DDL, RLS or tenant-database access.

## Requirements

- TypeScript 7.1 beta, which provides content mappers
- `tsc --runExternalCode` so the compiler executes the Reylo mapper
- Reylo's Bun preload (`reylo/register`) for `.sql` imports at runtime
- a live PostgreSQL development database for type inference
- Bun 1.4.4 for the runtime and standalone compile check

The Management API pins `typescript` to `7.1.0-beta` and `reylo` to `0.7.0` as
development dependencies. Normal `bun run typecheck` excludes the pilot.
The pilot has its own `tsconfig.reylo.json` with `contentMappers`.

## Run against a development database

```sh
cd packages/management-api
DATABASE_URL=postgres://... \
SUPACLOUD_REYLO_PILOT=1 \
REYLO_PROJECT_REF=demo \
bun run reylo:live
```

`bunfig.toml` preloads `scripts/reylo-preload.ts`, which registers
`reylo/register` only when `SUPACLOUD_REYLO_PILOT=1`. Normal application and
test runs do not import the pilot.

Type-check the pilot against the live schema:

```sh
DATABASE_URL=postgres://... bun run typecheck:reylo
```

Reylo caches schema facts under `packages/management-api/.reylo`; the cache is
intentionally not committed.

## Standalone compile check

```sh
DATABASE_URL=postgres://... bun run reylo:build
```

The script:

1. bundles the pilot entry with `reylo/esbuild`, which turns each `.sql` file
   into a typed query module;
2. asserts the bundle contains the SQL text and no `.sql` import;
3. runs `bun build --compile`;
4. copies the binary to an empty directory and executes it there without
   `node_modules` or `.sql` files.

Verified on Bun 1.4.4 and macOS arm64:

- SQL text is inlined into the bundle.
- The compiled binary runs all seven queries from an empty directory.
- Reylo's native engine is not bundled into the binary. The engine is needed
  only for typechecking and building the query module; the compiled runtime
  uses the inlined query metadata and Reylo's decoder, and starts without the
  engine package present.

`Bun.build({ compile: ... })` with a plugin did not resolve `.sql` imports in
Bun 1.4.4. The working path is therefore two-step: bundle with the Reylo
plugin, then pass the bundle to `bun build --compile`.

## Promotion criteria

Before replacing any existing repository query, add:

- a live fixture for empty and populated result sets;
- contract parity checks against the existing decoder;
- a standalone binary test in CI on each release target;
- an explicit decision on keeping the Reylo engine available for rebuilds.
