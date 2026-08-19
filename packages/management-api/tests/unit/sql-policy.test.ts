import { describe, expect, test } from "bun:test";
import {
  isDangerousSQL,
  projectMigrationSqlViolations,
} from "../../src/db/sql-policy";

describe("project migration SQL policy", () => {
  test("blocks cluster, host, external database, transaction, and lock control", () => {
    const statements = [
      "alter role postgres superuser",
      "copy public.accounts to program 'sh'",
      "copy public.accounts to '/var/lib/postgresql/accounts.csv'",
      "select dblink('host=other', 'select 1')",
      "select extensions.\"dblink\"('host=other', 'select 1')",
      "commit",
      "abort and chain",
      "select pg_advisory_unlock_all()",
      "select pg_catalog.\"pg_advisory_lock\"(42)",
      "select pg_catalog.\"pg_read_file\"('/etc/passwd')",
    ];

    expect(projectMigrationSqlViolations(statements)).toEqual(expect.arrayContaining([
      "cluster role management",
      "server copy access",
      "server-side program execution",
      "external database access",
      "transaction control",
      "advisory lock control",
    ]));
  });

  test("allows project-local destructive DDL for separately confirmed promotion", () => {
    expect(projectMigrationSqlViolations([
      "alter table public.accounts drop column legacy_code",
      "drop table public.legacy_accounts",
    ])).toEqual([]);
  });

  test("blocks quoted and unquoted public schema removal", () => {
    expect(projectMigrationSqlViolations(["DROP SCHEMA public CASCADE"]))
      .toContain("public schema removal");
    expect(projectMigrationSqlViolations(['DROP SCHEMA "public" CASCADE']))
      .toContain("public schema removal");
    expect(projectMigrationSqlViolations(["DROP SCHEMA app_private, public CASCADE"]))
      .toContain("public schema removal");
  });

  test("blocks platform schema renames and migration schema management", () => {
    expect(projectMigrationSqlViolations(['ALTER SCHEMA "public" RENAME TO app_public']))
      .toContain("public schema alteration");
    expect(projectMigrationSqlViolations(["DROP SCHEMA IF EXISTS supabase_migrations CASCADE"]))
      .toContain("migration ledger schema management");
    expect(projectMigrationSqlViolations(["ALTER SCHEMA app RENAME TO app_v2"]))
      .not.toContain("public schema alteration");
    expect(projectMigrationSqlViolations([String.raw`DROP SCHEMA U&"p\0075blic" CASCADE`]))
      .toContain("unicode escaped identifier");
  });

  test("blocks direct migration ledger writes and recorder calls", () => {
    expect(projectMigrationSqlViolations([
      "insert into supabase_migrations.schema_migrations(version) values ('999')",
      "delete from public.schema_migrations where version = '1'",
      "drop table if exists supabase_migrations.schema_migrations",
      "drop table public.disposable, public.schema_migrations cascade",
      "truncate table public.disposable, only public.schema_migrations",
      "lock table public.disposable, public.schema_migrations in access exclusive mode",
      "alter table if exists only public.schema_migrations add column tampered boolean",
      "create index ledger_version_idx on public.schema_migrations(version)",
      "create trigger ledger_guard before insert on public.schema_migrations for each row execute function public.audit()",
      "drop trigger if exists ledger_guard on public.schema_migrations",
      "create rule ledger_rule as on insert to public.schema_migrations do instead nothing",
      "drop rule if exists ledger_rule on public.schema_migrations",
      "create policy ledger_policy on public.schema_migrations using (true)",
      "comment on table public.schema_migrations is 'tampered'",
      "security label on table public.schema_migrations is 'tampered'",
      "reindex table public.schema_migrations",
      "reindex (verbose) table concurrently public.schema_migrations",
      "cluster verbose public.schema_migrations",
      "vacuum (analyze) public.schema_migrations",
      "analyze public.schema_migrations",
      "grant select on public.accounts, public.schema_migrations to authenticated",
      "grant select on all tables in schema supabase_migrations to authenticated",
      "grant all on all tables in schema public to authenticated",
      "select supabase_migrations.record_schema_migration('2', array['select 1'], 'fake', 'checksum')",
    ])).toEqual(expect.arrayContaining([
      "migration ledger modification",
      "migration ledger privilege modification",
      "migration ledger recorder access",
    ]));
    expect(projectMigrationSqlViolations(["grant select on public.accounts to schema_migrations"]))
      .not.toContain("migration ledger privilege modification");
    expect(projectMigrationSqlViolations(["grant execute on function public.audit(schema_migrations) to authenticated"]))
      .not.toContain("migration ledger privilege modification");
    expect(projectMigrationSqlViolations(["grant usage on schema schema_migrations to authenticated"]))
      .not.toContain("migration ledger privilege modification");
    expect(projectMigrationSqlViolations(["grant execute on function public.schema_migrations(text) to authenticated"]))
      .not.toContain("migration ledger privilege modification");
    expect(projectMigrationSqlViolations(["create index account_email_idx on public.accounts(email)"]))
      .not.toContain("migration ledger modification");
    expect(projectMigrationSqlViolations(["comment on table public.accounts is 'application data'"]))
      .not.toContain("migration ledger modification");
  });

  test("does not treat PL/pgSQL function-body operations as top-level migration control", () => {
    const functionDefinition = `
      CREATE FUNCTION public.lock_example() RETURNS void
      LANGUAGE plpgsql AS $function$
      BEGIN
        SET LOCAL ROLE postgres;
        PERFORM pg_advisory_xact_lock(1);
      END;
      $function$;
    `;
    expect(projectMigrationSqlViolations([functionDefinition])).not.toContain("transaction control");
    expect(projectMigrationSqlViolations([functionDefinition])).not.toContain("advisory lock control");
    expect(projectMigrationSqlViolations([functionDefinition])).not.toContain("session role control");
    expect(projectMigrationSqlViolations(["DO $$ BEGIN PERFORM 1; END $$;"]))
      .toContain("opaque procedural SQL");
  });

  test("blocks every supported top-level DO body form", () => {
    for (const statement of [
      "DO LANGUAGE plpgsql $$ BEGIN PERFORM pg_advisory_lock(1); END $$;",
      "DO /* generated */ LANGUAGE plpgsql $$ BEGIN SET ROLE postgres; END $$;",
      "DO 'BEGIN PERFORM pg_advisory_lock(1); END';",
      "DO LANGUAGE plpgsql 'BEGIN SET ROLE postgres; END';",
    ]) {
      expect(projectMigrationSqlViolations([statement])).toContain("opaque procedural SQL");
    }
  });

  test("continues to block privileged operations at the migration top level", () => {
    const violations = projectMigrationSqlViolations([
      "CREATE FUNCTION public.safe_body() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$",
      "SET ROLE postgres",
      "SELECT pg_advisory_xact_lock(1)",
      "COMMIT",
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      "session role control",
      "advisory lock control",
      "transaction control",
    ]));
    expect(projectMigrationSqlViolations(["SELECT $unterminated$", "SET ROLE postgres"]))
      .toContain("session role control");
    expect(projectMigrationSqlViolations(["SELECT $unterminated$; SET ROLE postgres"]))
      .toContain("session role control");
  });

  test("keeps the generic migration endpoint's older conservative policy", () => {
    expect(isDangerousSQL("drop table public.accounts")).toBe(true);
  });
});
