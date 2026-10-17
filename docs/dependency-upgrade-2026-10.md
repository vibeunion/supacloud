# Dependency Upgrade Notes (2026-10)

This upgrade was checked against the official npm registry on 2026-10-15,
using Bun 1.4.3. It covers repository-owned npm manifests, generated starter
versions and affected lockfiles, not host binaries, container images or running
databases. `latest` is not used to downgrade an existing prerelease.

## Coordinated runtime changes

- Elysia moves from `2.0.0-beta.21` to `2.0.0-beta.32`.
- `@elysia/openapi` moves to `2.0.0-beta.6`.
- Elysia fluent lifecycle methods now use `onRequest`, `onBeforeHandle`,
  `onAfterHandle`, `onAfterResponse` and `onError`. Route object hook keys stay
  unchanged. Response validators are a `Map` and must be read with `.get()`.
  Direct routes, adapter cleanup/telemetry and corresponding fixtures migrate
  together; old fluent names fail at runtime. Multipart deployment routes use
  `parse: "formdata"` instead of the removed `type: "multipart"` option.
- Effect moves to `4.0.5`; TypeBox moves to `1.3.37`.
- GraphQL remains on the compatible `^16` range (`16.14.2` in the compiler
  lockfile). GraphQL 17 cannot currently be loaded by the code generation
  chain's CommonJS `graphql-tag` dependency. Code generation and promise
  helpers are updated without adopting that incompatible major version.
- PGlite `0.5.10`, pgvector `0.0.11`, PostGIS `0.2.10`, pg_textsearch `0.0.12`
  and PGMQ `0.0.8` form one set. Back up existing data directories before using
  the new WASM/extension assets; do not mix old and new extension bundles.
- Drizzle ORM and Kit are paired at `1.0.0-rc.5-5935859`, including the exact DB
  peer, compiler development dependency and generated starter metadata. Review
  generated SQL before applying it; no existing migration is rewritten.
- SvelteKit moves to `3.1.0`, SVAdmin UI to `0.83.1`, Svelte Query to `6.3.2`
  and Query Core to `5.104.2`. Existing Svelte `5.57.2` and Vite `8.3.4` are
  already current. SvelteKit and svelte-check still require TypeScript 6;
  keep TypeScript `6.0.3` for their semantic API and the native CLI alias on
  `7.0.2`. The compiler's separate `@typescript/typescript6` stays at `6.0.2`.
- Angular core/compiler development dependencies move together to `22.2.3`.
  Angular core is a host-provided peer (`^22.2.2`) so minimum-version consumers
  do not install a second runtime. Tar streaming, module lexer,
  GraphQL tools, sanitization and HTTP security overrides are refreshed.
- Lite uses published `@supacloud/db@0.17.0`; the umbrella package uses published
  CLI `0.98.0`. CLI adapter development uses the local candidate so beta.32 is
  tested with the matching adapter, not a published beta.21 peer.
  Lite explicitly installs the local contracts candidate for its DB dependency.

## Consumer migration

Publish the updated adapter and DB packages before publishing their new starter
tuple. Release Please owns package version changes; do not run the modified
starter against the old published adapter/DB versions and assume compatibility.
Existing applications need the exact Elysia/TypeBox/Effect tuple plus matching
SupaCloud releases. Regenerate compiler artifacts after updating dependencies.
Historical benchmark documents are not new acceptance evidence.
GraphQL 17 requires Node 22 or newer; consult each package's engine constraint
when using Node instead of the tested Bun runtime. The SvelteKit alias
deprecation and existing large-chunk/CSS warnings are not suppressed.

## pgflow boundary

pgflow remains pinned to `0.16.0` in this change. pgflow `0.17.x` changes the
`start_tasks` signature, adds private step queues, and introduces an opt-out
telemetry migration. Its upstream guidance requires stopping and draining
workers, pausing producers and maintenance writers, applying all migrations
transactionally, then deploying matching packages and workers together. The
existing installation ledger and migration checksums must not be rewritten as
part of an ordinary dependency refresh.

The worker's SQL parser also stays at `libpg-query@17.7.4` to preserve its
canonical shared-profile SQL receipts. A trial with pgflow `0.17.2` and parser
`18.1.5` produced different hashes for 22 historical upstream migrations, in
addition to four new migrations. The trial was not retained. A dedicated
upgrade must preserve previous receipts, migrate the three-argument
`start_tasks` wrapper and grants, handle decimal-string message IDs, explicitly
disable unapproved telemetry, and test both fresh and existing shared/dedicated
databases with backup/restore before advancing the engine binding.

The framework comparison fixture retains its separately evaluated Aponia and
class-validator versions; it is not a deployed application dependency graph.

## Verification and rollback

Install using `bun install --frozen-lockfile --registry https://registry.npmjs.org`.
Build local `file:` prerequisites before installing their consumers; Bun can
copy package contents. Reinstall consumers after building prerequisites.
Regeneration must also pass the Elysia declaration/local-snapshot check.

Run focused compatibility, compiler GraphQL, PGlite, Drizzle and Elysia
conformance tests before publishing. A rollback restores the previous manifests,
lockfiles and generated artifacts; it does not reverse already-applied database
migrations or durable workflow side effects. No database mutation or deployment
is performed by this dependency change.

## Local evidence

Verification was limited to affected test files; no full repository test suite
or production/test-server operation was run.

- Elysia declarations and lock snapshots: 23 tests; declaration check passed.
- Strict governance regression: 2 tests.
- Compiler GraphQL contracts: 33 tests.
- Compiler migration preview/apply/rollback: 14 tests.
- Elysia native/adapter conformance: 17 tests.
- Elysia HTTP policy/cache/telemetry: 16 tests.
- Generated contract upgrade/restore: 1 test.
- PGlite engine/extensions/timezone: 5 tests.
- Drizzle generated starter/type/SQL checks: 5 tests.
- Starter metadata synchronizer: 9 tests; CLI composition: 5 tests.
- Management auth/OpenAPI routes: 34 tests; observability: 8 tests.
- Edge HTTP body limits: 3 tests; Pgredis API: 5 tests.
- Adapter and Management API typechecks, Drizzle-specific typecheck, local
  prerequisite builds and Web Console production build passed.
- pgflow canonical bundle check passed without changing its ledger or SQL.
- Frozen installs passed for all 18 changed package lockfiles.
- An additional six-file GraphQL run hit two default five-second timeouts.
  Separate reruns of `graphql.test.ts` (33 tests) and
  `graphql-runtime.test.ts` (15 tests) passed with `--timeout 30000`; the other
  four files passed in the initial run. The initial timeout run is not claimed
  as a clean pass.

PostgreSQL runtime-safety, packed publication, authenticated browser acceptance,
deployment and database upgrade/restore are not claimed by these local checks.
