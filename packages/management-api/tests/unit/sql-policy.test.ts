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

  test("keeps the generic migration endpoint's older conservative policy", () => {
    expect(isDangerousSQL("drop table public.accounts")).toBe(true);
  });
});
