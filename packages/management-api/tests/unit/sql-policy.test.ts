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
      "select dblink('host=other', 'select 1')",
      "commit",
      "select pg_advisory_unlock_all()",
    ];

    expect(projectMigrationSqlViolations(statements)).toEqual(expect.arrayContaining([
      "cluster role management",
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

  test("blocks direct migration ledger writes and recorder calls", () => {
    expect(projectMigrationSqlViolations([
      "insert into supabase_migrations.schema_migrations(version) values ('999')",
      "delete from public.schema_migrations where version = '1'",
      "select supabase_migrations.record_schema_migration('2', array['select 1'], 'fake', 'checksum')",
    ])).toEqual(expect.arrayContaining([
      "migration ledger modification",
      "migration ledger recorder access",
    ]));
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
