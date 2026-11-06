# ZenStack / Bun SQL breaking upgrade

Status: implemented; focused local validation is recorded below. This document is not deployment evidence.

For day-to-day feature work, start with the [feature development guide](../feature-development.md).
The [static AOP decision](static-aop.md) explains framework references and current enforcement limits.

## Decision

New model authoring uses ZModel. ZenStack owns model inference and data policies;
SupaCloud owns application compilation, static execution boundaries, durable
commands and migration delivery. Bun SQL is the PostgreSQL driver through a
small Kysely dialect maintained in `@supacloud/db`. Pure domain functions remain
ordinary TypeScript; Effect programs execute inside the command lifetime.

Reylo and Drizzle are removed, including their dependencies, public adapters,
commands, starter configuration, query loaders and build caches. There is no
compatibility alias or dual query path. Existing database contents and applied
migration history are preserved. Framework replacement does not authorize a
production deployment or migration-history rewrite.

## Acceptance

```gherkin
Feature: One model-driven database path
  Scenario: Removed tools cannot silently remain active
    Given the upgraded packages and a newly generated application
    When dependencies, exports, scripts and CLI inputs are inspected
    Then neither Reylo nor Drizzle is installed or invoked
    And obsolete configuration is rejected rather than silently ignored

  Scenario: Native driver preserves transaction scope
    Given a command with business writes, audit and receipt writes
    When execution fails before commit
    Then every write uses the same reserved PostgreSQL connection and rolls back
    And the connection is released on success and failure

  Scenario: Model contracts are reproducible
    Given a maintained ZModel and generated schema
    When the model changes without regeneration
    Then the contract freshness gate rejects the stale artifacts
    And ordinary compilation never mutates a database

  Scenario: Migration delivery has one authority
    Given an existing applied migration ledger
    When model changes produce a migration candidate
    Then only reviewed forward SQL enters the existing delivery directory
    And no second production migration ledger is created

  Scenario: Policies cannot be bypassed through ordinary application imports
    Given a governed application operation
    When it requests a raw client or removes the policy plugin
    Then the source boundary rejects it
    And trusted infrastructure remains responsible for verified identity
```

## Upgrade sequence

1. Pin matching ZenStack packages and Kysely. Generate the TypeScript schema from
   the reviewed ZModel; commit source and generated contracts together.
2. Replace old database adapters, configuration and commands using the mapping
   documented below. Remove old packages and regenerate lockfiles.
3. Bind the policy client to trusted identity at the composition root. HTTP and
   workers use the same command boundary; raw connections stay in infrastructure.
4. Compare the existing database with a migration replay. Adopt a reviewed model
   baseline without recreating existing tables or marking migrations applied.
5. Generate forward migration candidates in a shadow/development database,
   review SQL, then deliver through the existing SupaCloud plan/apply ledger.
6. Verify rollback, cross-project access, policy enforcement, receipt replay and
   the actual Bun standalone artifact before publishing or deploying.

Rollback restores the previous application artifact only while schema changes
remain backward compatible. Destructive schema changes require a separate data
recovery plan. Never remove task receipts, audit records or queued work as part
of removing an ORM or query generator.

## Ownership and enforcement

| Layer | Owns | Must not own |
| --- | --- | --- |
| ZModel / ZenStack | Business structure, inferred model types, row policies | HTTP DTOs, command retries, migration deployment |
| Compiler / static AOP | Dependency graph, authorization/transaction/audit execution order, source checks | A second ORM, runtime schema reflection |
| Effect | Typed failures, resource lifetime and cancellation of application programs inside Command execution | Independent commit/retry boundaries around non-idempotent writes |
| CommandStore | Receipt, audit, idempotency and one database transaction | Public raw database access |
| Bun SQL dialect | Connection reservation, bound parameters, commit/rollback/savepoints | Business authorization or model generation |

The internal dialect uses upstream Kysely's PostgreSQL adapter/compiler. It does
not vendor the community `kysely-bun-sql` implementation or maintain a patched
copy of Kysely. A reproduced driver defect should receive a small local fix and
regression test; upstream fixes can later replace it without changing business
interfaces. Cursor streaming is deliberately unsupported. This adapter does not
claim per-query AbortSignal cancellation.

`createZenStackDatabase(schema, pool, {})` belongs in the trusted composition root.
After identity verification, `forIdentity(identity)` returns read-only `models`
and `commandStore`. The command runtime receives the store; business commands
receive only `session.transaction.db`. Model delegates are copied as operation
closures so their private ORM client cannot leak. Writes are available only in
the command transaction. The captured identity is cloned, and transaction
capabilities fail after the transaction ends. Exact model query argument typing
is enabled; validation and capability switches cannot be overridden. The host
owns `pool.close()`.

`session.transaction` exposes exactly two capabilities: `db` (model operations)
and `lock(keys)`. `lock` takes transaction-scoped PostgreSQL advisory locks
(`pg_advisory_xact_lock`) on the command connection, deduplicates the keys and
acquires them in sorted order, so it is released by commit or rollback, never
survives into another command, and cannot deadlock against a command that takes
the same key set in a different order. Use it when a write depends on an
aggregate another transaction may extend concurrently (read-check-write across
rows): without the lock, two commands can both pass the same invariant check.
Keys are validated before any SQL is sent — an empty array, a blank key, more
than 16 keys or a key longer than 200 characters is rejected as
`COMMAND_INPUT_INVALID` rather than silently colliding on a shared hash.

Framework receipt SQL is enabled on the **private** client, because ZenStack's
policy plugin blocks raw SQL by default. Raw SQL and policy/plugin controls are
absent from both business facades. Native operational SQL and the reference
starter's existing RLS/locking adapters remain trusted infrastructure. This
change does not rewrite every platform SQL statement as a model operation.

`database.sources.json` lists reviewed `trustedHosts` (default `src/host`). The
command starter explicitly adds its delivery host and worker entrypoints.
The source gate rejects raw database/ORM value imports and direct host imports
from ordinary `src` consumers; type-only model contracts remain allowed. This
is a compiler/source convention plus a restricted runtime API, not a JavaScript
sandbox. Keep least-privilege roles and RLS for paths such as PostgREST and RPC.

For generic read-heavy admin surfaces, `@supacloud/elysia` provides
`createZenStackReadPlugin`. It mounts only explicit GET/HEAD resources, binds a
verified identity for every request, accepts TypeBox contracts and argument
builders, and invokes only the read methods exposed by `ModelReadClient`. It
does not expose writes, raw clients or arbitrary CRUD routes. Durable writes
remain Commands using `transaction.db`; business routes remain compiler-emitted
Elysia routes. The official `@zenstackhq/server` automatic Elysia handler is not
the default integration: its 3.10 peer baseline targets Elysia 1.x, while this
adapter targets the repository's Elysia 2 runtime and keeps one application
boundary.

## Breaking command and API mapping

| Removed | Replacement |
| --- | --- |
| Reylo dependency, query imports, cache/build plugin, contract/live commands | Existing native Bun SQL control-plane repositories and explicit decoders |
| `@supacloud/db/drizzle`, `/drizzle-bun` | `@supacloud/db/zenstack` for models; `/bun` for trusted operational SQL |
| ORM table objects in `defineDatabaseModule.tables` | Explicit qualified names such as `public.orders` |
| `drizzleSchema` compiler option | `modelSchema: "zenstack/generated/schema.ts"` |
| ORM configs and generate/pull scripts | `supacloud-model generate/check/diff/pull` |
| `dev migrate` and its config/flags | Generate/review a candidate, then the existing `db plan` / `db apply` workflow |
| `scanDrizzleSql` | `scanQuerySql`, scanning Kysely SQL escape hatches |

No compatibility exports or command aliases remain. Remove the obsolete packages,
configs, scripts, loader declarations and generated query caches from applications.
Preserve already-applied migrations and their IDs/checksums. Old schema snapshots
may be archived as historical evidence; do not rewrite the applied SQL.

### Application upgrade

1. Upgrade the DB, compiler, CLI and umbrella packages together. The new package
   versions must be published before consumers can use them; source changes do
   not establish npm availability. The release publisher rewrites repository
   `file:` references to released versions. Keep the umbrella's semver ranges
   synchronized with the published CLI/admin releases.
2. Remove the old ORM/query-generator dependencies. Pin ZenStack packages to
   `3.10.0` and Kysely to `0.29.0`. Development tooling is ZenStack CLI `3.10.0`,
   Prisma `6.19.3` and `pg` `8.23.1`. `pg` is needed only by ZenStack introspection;
   application model queries use Bun SQL. Regenerate and commit the lockfile.
3. Author `zenstack/schema.zmodel`, preserving SQL names via `@map`/`@@map`, native
   types, nullability, defaults, relation actions, keys and indexes. Use PostgreSQL
   with `url = env("DATABASE_URL")`, without alternate direct/shadow URL fields.
   Add explicit model policies before enabling
   model writes. ORM policies do not create database RLS policies.
4. Compile the model, then source contracts:

   ```sh
   bun run db:generate
   bun run db:check
   ```

   The starter maps these to `supacloud-model generate && supacloud-db generate`
   and `supacloud-model check && supacloud-db check`. Commit the ZModel,
   `zenstack/generated/` and `db/contracts/` together. Each configured root ZModel
   has its generated output in the adjacent `generated/` directory. The source
   gate checks fresh model generation before accepting a new source manifest.
5. Set `SUPACLOUD_MODEL_DATABASE_URL` explicitly to the local/shadow database,
   preferably with a read-only account. Commands accept no ambient production
   default and never apply SQL:

   ```sh
   bun run db:pull -- --candidate output/database-audit/baseline.zmodel
   bun run db:diff -- --candidate output/database-audit/change.sql
   ```

   Candidate files must be new, outside generated contracts, and use `.zmodel`
   or `.sql` respectively. Review introspection output; it cannot infer business
   policy. Diff compares the selected database with the generated Prisma model.
6. Replay the existing migrations in a shadow database. Review the baseline diff
   and remove unintended table/column drops or constraint changes by correcting
   the model first. Prisma cannot express every PostgreSQL object: preserve
   reviewed RLS, functions, grants, checks, triggers and extensions in their
   maintained SQL sources and migration history.
7. Promote only reviewed forward SQL to the existing migration directory. Run
   `supacloud db plan` for the explicitly selected environment; apply using that
   plan's exact digest through the existing workflow. Do not run Prisma migrate
   dev/deploy, ZenStack db push, or a second migration executor.
8. Cut over verified identity and transaction bindings per application. Test
   cross-tenant access, denied writes, rollback, receipt replay, and direct
   PostgREST/RPC RLS before release. Keep model writes inside Command execution;
   never open another transaction from a business handler.

## Local validation and release boundary

The focused `packages/db/src/zenstack-upgrade.test.ts` regression covers real
model generation and consumer typing, stale-generation rejection, source imports,
SQL candidate generation, native driver lifecycle, and a disposable local
PostgreSQL instance with actual Bun SQL. It checks policy isolation, denied writes,
shared model/receipt/audit rollback and commit, expired capabilities, and both
`diff` and `pull` against the disposable database. It uses the actual persistence
table definitions, not the complete PGMQ/worker deployment.

Local result: **6 passed, 0 failed, 54 assertions** under Bun `1.4.4`, including
both candidate commands and the disposable PostgreSQL tests. DB and compiler JS /
declaration builds and the CLI bundle / tool-runtime / declaration build passed.
The focused regression also passed strict TypeScript checking. Its clean-environment
preparation installs the CLI dependencies used by the command-removal checks.
The compiler API snapshot, starter metadata and workflow YAML were checked.

Only this focused test file was run. `git diff --check` supplements it. Full application/standalone acceptance, npm
publication, remote migration, merge and deployment are separate release steps.
