# Database Source Contracts

## Boundary

Database-enabled starters separate Drizzle structure, maintained function sources,
append-only migrations, derived RPC contracts and audit dumps. HTTP/Edge-only
starters do not require a database. This is not a new migration executor or ledger.
SQL size is not a violation; consuming an audit dump as application/type/test input is.

## Acceptance

```gherkin
Scenario: Default database project
  Given a new command starter
  When its dependencies are installed and its documented initialization is run
  Then its default check includes database source boundaries and contract freshness

Scenario: Audit input regression
  Given an application or ordinary test references an audit SQL dump
  When database checks run
  Then the check fails without modifying the source or dump

Scenario: Contract drift
  Given committed contracts and a changed function, schema or migration
  When database checks run
  Then stale contracts fail until explicitly regenerated and reviewed

Scenario: Safe types
  Given overloaded functions with defaults and explicit grants
  When contracts are generated
  Then overloads and optional arguments are preserved and opaque results remain unknown
  And bigint and numeric are not narrowed to number

Scenario: Existing project
  Given a project without a source-boundary configuration
  When assessment runs
  Then it returns adoption steps and findings without writing files or connecting to a database
```

## Commands

The `@supacloud/db` package supplies `supacloud-db`:

```sh
supacloud-db assess --root .
supacloud-db generate --root .
supacloud-db check --root .
```

`assess` is read-only and also works before adoption. `generate` writes only the
configured contracts directory; it never rewrites schemas, maintained SQL or
migrations. `check` is read-only and fails on boundary violations or missing/stale
contracts. All three commands work offline and return JSON. Installed packages
must contain this feature; repository implementation is not npm publication.

Configuration is `database.sources.json` at the project root:

```json
{
  "version": 1,
  "schema": ["db/schema.ts"],
  "functions": "db/functions",
  "migrations": "migrations",
  "contracts": "db/contracts",
  "audit": "output/database-audit",
  "consumers": ["src", "scripts", "tests"],
  "auditConsumers": [],
  "role": "service_role"
}
```

Paths are project-relative and must not traverse symlinks. Source, migration,
contract and audit locations cannot overlap. Freshness follows relative TypeScript
schema imports (extensionless, `.ts`, or directory `index.ts`); list additional
local schema entrypoints explicitly instead of relying on path aliases.
Each maintained SQL file owns one
schema-qualified function and its own explicit EXECUTE grants/revocations.
Overloads use distinct files. Internal functions remain sources but are excluded
from the callable map. Role membership and database default privileges are not
inferred: exported functions require an explicit PUBLIC decision and a declared
grant to PUBLIC or the configured role. Real effective authorization still needs
PostgreSQL catalog reconciliation and role/RLS integration tests.

The generated catalog contains signatures, types and input hashes, not function
bodies. Function names are schema-qualified. JSON, records and custom SQL types
remain `unknown`; bigint/numeric preserve `number | string`. No driver validation
or deployed-catalog parity is implied by offline types.
Array elements and scalar results retain nullability. The contracts manifest is
a committed local source baseline, not a record of applied database migrations.
Explicit top-level migration CREATE/DROP/RENAME signatures are tracked to report
functions missing a maintained source. This does not interpret dynamic DDL or
prove that a maintained function body matches migration replay; use catalog
reconciliation for that proof.

The boundary check analyzes static source references (including constant path
composition) in configured consumers. It detects configured audit paths and
recognized PostgreSQL dumps, not arbitrary runtime-generated paths. It is not a
sandbox or a proof against deliberately obfuscated file I/O. Explicit audit-only
scripts can be listed in `auditConsumers`; ordinary tests should select maintained
functions or replay migrations at an explicit historical boundary. Exported
GraphQL and PostgREST type snapshots are legitimate protocol contracts, not SQL
audit dumps, and remain allowed.

## Adoption and Rollback

1. Run assessment and review the reported dump references.
2. Keep the existing migration directory and deployment ledger unchanged.
3. Capture/review Drizzle structure and function sources against a local migration
   replay. Do not silently import an unverified production dump.
4. Add the configuration and replace ordinary dump consumers.
5. Generate and commit contracts; wire `supacloud-db check` before generators in
   the project's default check. Run catalog, ACL and behavior integration checks.
6. Keep full SQL exports only under the ignored audit directory. Use an explicit
   existing dump command and selected database target; these tools never connect.

Drizzle introspection and migration drafts go to separate candidate directories;
review them before promoting a forward migration through the existing ledger.
Reverting the adoption commit restores the prior source/tooling layout without
rolling back a database. Back up uncommitted dumps before removing tracked copies.
