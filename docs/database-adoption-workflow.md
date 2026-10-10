# Database Adoption Workflow

## Scope

The goal is to align an existing database with Supabase declarative SQL sources,
then review and deliver forward migrations. SQL is the structural source of truth;
Drizzle is a derived query/type model, not a second migration generator here.
No command overwrites an adopted schema, imports production data, generates a
down migration or claims that structure comparison proves application behavior.
The existing migration executor and deployment ledger remain authoritative.

## Acceptance

```gherkin
Scenario: Manual reverse adoption
  Given an explicitly selected PostgreSQL database and a fresh candidate path
  When db reverse runs
  Then declarative SQL and a read-only catalog snapshot are published as candidates
  And maintained schema files and the deployment ledger remain unchanged

Scenario: Incremental structure candidate
  Given maintained declarative SQL and a reviewed forward migration baseline
  When db diff runs
  Then SQL drafts go only to the candidate directory
  And no database migration is executed

Scenario: Exact reviewed plan
  Given a successful migration plan and its digest
  When SQL bytes, the target project or pending migration state change
  Then db apply rejects the old digest without executing a migration

Scenario: Ordinary role boundary
  Given an application connection with ownership, CREATE privilege or privileged membership
  When db role_check runs
  Then the role boundary fails
  And db role_sql only renders a provisioning candidate without executing it

Scenario: Unknown execution outcome
  Given a migration executor returns an unknown or partial outcome
  When db apply returns
  Then the executor receipt is preserved without claiming verification or retrying automatically
```

## Commands

These commands belong to `@supacloud/cli`, not the offline `supacloud-db`
contract generator. Run them from the application root or select `--root`.

```sh
# Use an explicitly selected read/catalog-capable DATABASE_URL.
supacloud-cli db reverse --schema public --out output/database-audit/reverse

# After manual adoption of SQL sources and a matching migration baseline:
supacloud-cli db diff --schema_dir supabase/schemas --out output/database-audit/diff

# Promote reviewed SQL into a new timestamped file in supabase/migrations/.
supacloud-cli --env test db plan --dir supabase/migrations
supacloud-cli --env test db apply --dir supabase/migrations --approved_digest <digest>

# Use the actual ordinary application's DATABASE_URL for this check.
supacloud-cli db role_check --schema public
supacloud-cli db role_sql --application_role app_user \
  --migration_role app_migrator --database app_db --schema public

# Existing post-apply governance check:
supacloud-cli db module_check --module_file db/modules.ts
```

Reverse/diff use the existing official Supabase CLI resolver: project binary,
PATH, `SUPACLOUD_SUPABASE_CLI_BIN`, or an explicitly pinned
`SUPABASE_CLI_VERSION`. They call experimental declarative generate/sync with
no fallback engine. Select and acceptance-test a compatible version before use.
Reverse uses an explicit read-only DSN, never `db pull` or migration repair.
The DSN is passed in child-process arguments, so restrict access to process
inspection; it is never written into configuration or returned JSON.
Candidates are published only after success; failed temporary output is removed.
The output contains `supabase/schemas/*.sql` and `catalog.json`. Existing output
is never replaced.

The catalog candidate preserves column/default/identity/generated metadata and
the existing RLS/policy/function/trigger/grant inventory. It is not a complete SQL
export: function bodies, exact overload signatures and unrepresented objects
still require explicit SQL sources and independent verification. Declarative generate
and catalog reads use separate snapshots; freeze DDL and review their parity.
Do not treat a limited-privilege catalog view as a complete database inventory.

Review SQL before adopting it into `supabase/schemas`. Establish and review a
matching forward migration baseline using the existing baseline/ledger controls;
reverse never marks it applied. `db diff` copies SQL and history into a fresh
isolated project and calls `declarative sync --no-apply --strict-coverage`.
It compares against replayed history, not the live database; it may start local
shadow databases, but never applies to the selected remote target. Only newly
generated migration SQL is published. Missing history fails closed; bootstrap
and baseline adoption remain manual. Never copy initial CREATE statements into
existing deployment history blindly.
`database.sources.json`, when present, protects the configured source, consumer,
contract and migration paths from candidate output.

The isolated project uses the standard `supabase/schemas` layout, PostgreSQL 17
by default (`--db_major_version` selects 15-18), and no seed or application config.
It does not import arbitrary project hooks, linked targets or credentials.
Custom extension/bootstrap requirements must be validated in the project's
official workflow first. This is an opt-in SQL-first path; legacy Drizzle-first
projects must choose and migrate their source ownership explicitly, never run
both generators against the same maintained migration history. Derive Drizzle
query models/types after adoption, without treating them as another authoring source.
`db context` identifies projects with `supabase/schemas` as SQL-first and treats
`db/schema.ts` as derived; projects without that directory retain the legacy hints.

The focused workflow test accepts `SUPACLOUD_SUPABASE_CLI_BIN` to exercise the
real engine. CLI 2.120.0 was verified with an existing PostgreSQL 18 source and
the official PostgreSQL 17 shadow. Both reverse and incremental diff succeeded
without changing the selected source database. Initial shadow image downloads
can take several minutes; each official invocation is bounded to five minutes.

Plan/apply use the existing Management API `push_migrations` dry-run and strict
risk policy. The digest binds API origin, project ref, migration hashes and the
pending/applied risk report. Apply recomputes the report and requires the exact
digest. Both dry-run and apply use temporary copies of the reviewed SQL bytes,
then remove them. Production confirmation and read-only restrictions still
apply. High-risk changes remain blocked here; use the existing reviewed release
process for destructive migrations. These commands do not add a new ledger,
backup, compatibility proof or multi-migration atomicity guarantee.

## Role Provisioning

`role_sql` renders a candidate only. A privileged operator must review it before
controlled provisioning; it changes cluster roles and default privileges, which
are not safely inferred from table diff. It revokes PUBLIC/application CREATE,
removes migration-role membership and disables elevated role attributes. It
revokes the migration creator's global default PUBLIC function EXECUTE as well
as schema-local defaults. This affects future functions in all schemas created
by that role; existing RPC privileges are preserved and need separate review. It
does not transfer existing ownership or remove arbitrary other memberships.
Keep approved DML/RPC privileges explicit and recheck the ordinary connection.

`role_check` conservatively examines membership-reachable roles, CREATE,
database/schema/relation/function/type ownership, superuser, role/database
creation, replication and RLS bypass. It fails closed on missing selected schemas.
It is a current-state check over the selected schemas, not a SQL sandbox:
privileged SECURITY DEFINER entrypoints and privileges outside the selected
schemas need separate review. Management/operator SQL and emergency break-glass
remain separate audited operations. No live role changes occur merely by
installing this feature.

RLS role matrices, RPC compatibility, triggers/audit, explicit backfill jobs and
Realtime/publication behavior require their own focused acceptance checks.
Production recovery remains forward-fix plus reviewed backups/PITR.
