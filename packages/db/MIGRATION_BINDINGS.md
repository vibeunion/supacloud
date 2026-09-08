# Controlled Migration Bindings

This is a deployment-time API for **public environment bindings**, not a general
SQL template language or another migration engine. Use identical migrations for
schema, indexes, business functions and state machines. Explicitly register only
SQL that must bind to a target-specific application ID, HTTPS URL or resource
name. One-off account transfers and production data cleanup remain separately
reviewed operations.

## Drizzle v1 Boundary

Reviewed against the Drizzle v1 PostgreSQL documentation on 2026-09-08:
official documentation repository commit
`dae09afd99baa6362ece434cfa7bab60ef4b8692`.

- [Upgrade to v1](https://orm.drizzle.team/docs/upgrade-v1):
  v1 removes the journal file and groups SQL and snapshots in migration folders.
  Do not run `drizzle-kit up` automatically on an application's existing history.
- [Custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations):
  `drizzle-kit generate --custom` is the extension point for custom SQL.
- [Migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate):
  migration execution reads applied history and supports separate configuration
  files for different deployment targets.

Those documents do not define this parameter-rendering API. This is a SupaCloud
extension, not a claim that Drizzle automatically reconciles account changes.
The renderer accepts `20260908100000_binding/migration.sql` as well as legacy
flat SQL filenames. It neither discovers nor changes snapshots, migration
identities, order, or metadata. Call it on a deployment copy, never write its
output over generated source SQL. When SupaCloud is the executor, continue using
its canonical applied-migration ledger; do not additionally execute
`drizzle-kit migrate` against that same migration stream.

## Usage

Commit a manifest containing explicit target pairs and reviewed source hashes.
`templateSha256` is the SHA-256 of the exact UTF-8 source, including whitespace.
An author obtains and reviews it once when adding a template; do not recompute
and accept a changed source hash automatically during deployment.

```ts
import { renderMigrationBindings } from '@supacloud/db';

const result = renderMigrationBindings({
  manifest: {
    schema: 'supacloud.migration-bindings.v1',
    targets: [
      { environment: 'test', projectRef: 'test-project' },
      { environment: 'production', projectRef: 'production-project' },
    ],
    templates: [{
      file: '20260908100000_binding/migration.sql',
      templateSha256: reviewedSourceSha256,
      parameters: [{
        placeholder: '__SC_BINDING_APPLICATION_ID__',
        variable: 'APPLICATION_ID',
        type: 'uuid',
        occurrences: 1,
      }],
    }],
  },
  target: selectedTarget,
  migrations: sourceFiles,
  values: selectedEnvironment,
});
// Send result.migrations to the existing dry-run/apply pipeline.
// Persist result.attestation in the existing release artifacts.
```

Example source:

```sql
SELECT '__SC_BINDING_APPLICATION_ID__'::uuid;
```

The caller must select and verify the environment before invoking this API.
Values are explicitly passed; the API does not read `process.env`, env files,
SSH configuration, or another target's fallback values. The target pair must
match the manifest. The full set of declared template sources must be supplied.
Plain SQL sources pass through byte-for-byte.

Only complete single-quoted placeholder literals are supported, including
literals in dollar-quoted PostgreSQL function bodies. `uuid`, `https-url`, and
`resource-name` have restricted alphabets excluding quotes, dollar delimiters,
backslashes and control characters. HTTPS URLs must not contain userinfo.
Do not put credentials, tokens, secrets or arbitrary text in these bindings.
Object identifiers, SQL fragments and arbitrary string interpolation are
intentionally unsupported.

`__SC_BINDING_*__` is reserved. Undeclared reserved tokens, stray declared
legacy tokens, duplicate definitions, missing inputs, changed source bytes,
wrong occurrence counts, unknown fields and unknown types fail closed.
Legacy tokens such as `__FA_SUPAUTH_CLIENT_ID__` can be explicitly declared
without editing historical SQL.

## Evidence And Changes

The attestation includes the target pair, manifest digest, source digest,
rendered digest and parameter names/types. It excludes SQL and parameter values.
The returned `migrations` contain SQL and must not be logged as an attestation.
This is reproducibility evidence, not a signature or proof of the database's
current state. Store it in an existing access-controlled release receipt or
artifact, and separately read back the target's applied migration inventory.

The renderer never marks a migration as applied and has no database access.
Compare the rendered SQL with the existing executor's inventory. A changed
environment value is **not** permission to rewrite an applied migration or its
ledger row. Add a forward binding migration and retain the old release artifact;
historical reconciliation must use target-specific reviewed evidence.

The CLI does not automatically enable this API. An application deployment
adapter must supply the selected sources and target, then use its existing
executor. In particular, this API does not add recursive Drizzle-folder discovery
to the CLI's legacy flat-directory `push_migrations` command.

## Acceptance

```gherkin
Scenario: Same template, separate targets
  Given a reviewed template and explicit test and production project bindings
  When each target provides its own valid parameters
  Then source digests match and rendered digests differ without changing source files

Scenario: Missing or unsafe parameter
  Given a missing value, injected SQL fragment or secret-bearing URL
  When rendering begins
  Then it fails without echoing the supplied value or requesting any database mutation

Scenario: Undeclared or changed SQL
  Given a changed template, unexpected token or unregistered target
  When rendering begins
  Then deployment preparation fails before SQL is returned

Scenario: Applied parameter changes
  Given an already-applied binding migration and a changed parameter
  When rendering again
  Then a different digest is produced, not an automatic replay or ledger repair
```
