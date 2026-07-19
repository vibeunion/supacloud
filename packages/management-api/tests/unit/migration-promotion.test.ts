import { describe, expect, test } from "bun:test";
import {
  buildBranchMigrationPromotionPlan,
  createMigrationLedgerEntry,
  detectDestructiveMigrationOperations,
} from "../../src/services/migration-promotion";

function migration(version: string, name: string, sql: string) {
  return createMigrationLedgerEntry({
    version,
    name,
    statements: [sql],
  });
}

describe("branch migration promotion planning", () => {
  test("promotes only branch migrations missing from the parent ledger", () => {
    const parent = [migration("202607180001", "create_accounts", "create table accounts(id bigint primary key);")];
    const branch = [
      ...parent,
      migration("202607180002", "add_account_status", "alter table accounts add column status text;"),
    ];

    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent,
      branch,
    });

    expect(plan.safe_to_apply).toBe(true);
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]).toMatchObject({
      version: "202607180002",
      name: "add_account_status",
      destructive: false,
    });
    expect(plan.pending[0]?.statements).toEqual(["alter table accounts add column status text;"]);
    expect(plan.blocked).toEqual([]);
    expect(plan.ignored_branch_data).toBe(true);
    expect(plan.plan_checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("blocks when the parent has migrations that the branch has not incorporated", () => {
    const parent = [
      migration("202607180001", "create_accounts", "create table accounts(id bigint primary key);"),
      migration("202607180003", "production_hotfix", "alter table accounts add column hotfix text;"),
    ];
    const branch = [
      parent[0],
      migration("202607180002", "add_account_status", "alter table accounts add column status text;"),
    ];

    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent,
      branch,
    });

    expect(plan.safe_to_apply).toBe(false);
    expect(plan.blocked).toContainEqual(expect.objectContaining({
      code: "parent_ahead",
      version: "202607180003",
    }));
  });

  test("blocks checksum drift for an already-applied migration version", () => {
    const parent = [migration("202607180001", "create_accounts", "create table accounts(id bigint primary key);")];
    const branch = [migration("202607180001", "create_accounts", "create table accounts(id uuid primary key);")];

    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent,
      branch,
    });

    expect(plan.safe_to_apply).toBe(false);
    expect(plan.blocked).toContainEqual(expect.objectContaining({
      code: "checksum_mismatch",
      version: "202607180001",
    }));
  });

  test("blocks SQL that cannot run in the transactional migration path", () => {
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent: [],
      branch: [migration(
        "202607180001",
        "accounts_email_idx",
        "create index concurrently accounts_email_idx on accounts(email);",
      )],
    });

    expect(plan.safe_to_apply).toBe(false);
    expect(plan.blocked).toContainEqual(expect.objectContaining({
      code: "non_transactional_sql",
      version: "202607180001",
    }));
  });

  test("ignores non-transactional keywords inside comments and function bodies", () => {
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent: [],
      branch: [migration(
        "202607180001",
        "document_maintenance_notes",
        `
          -- CREATE INDEX CONCURRENTLY is handled by a separate runbook
          create function maintenance_note() returns text language sql as $$
            select 'VACUUM is not executed here';
          $$;
        `,
      )],
    });

    expect(plan.safe_to_apply).toBe(true);
    expect(plan.blocked).toEqual([]);
  });

  test("requires an explicit confirmation for destructive migrations", () => {
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent: [],
      branch: [migration("202607180001", "drop_legacy", "alter table accounts drop column legacy_code;")],
    });

    expect(plan.safe_to_apply).toBe(true);
    expect(plan.requires_destructive_confirmation).toBe(true);
    expect(plan.pending[0].destructive).toBe(true);
  });

  test("treats every top-level DROP form as destructive", () => {
    for (const statement of [
      "drop domain public.account_code cascade",
      "drop foreign table public.remote_accounts",
      "drop routine public.refresh_accounts()",
      "drop rule account_notify on public.accounts",
      "drop aggregate public.total(numeric)",
    ]) {
      expect(detectDestructiveMigrationOperations([statement])).toContain("DROP object");
    }
  });

  test("treats procedural definitions as manual-review destructive SQL", () => {
    const statement = `
      CREATE FUNCTION wipe_accounts() RETURNS void LANGUAGE sql
      AS $$ DELETE FROM accounts $$;
      SELECT wipe_accounts();
    `;

    expect(detectDestructiveMigrationOperations([statement])).toContain(
      "CREATE FUNCTION or PROCEDURE (manual review required)",
    );
  });

  test("blocks opaque DO blocks from the controlled migration path", () => {
    const sql = "DO $$ BEGIN DROP TABLE accounts; END $$;";
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent: [],
      branch: [migration("202607180001", "conditional_cleanup", sql)],
    });

    expect(plan.safe_to_apply).toBe(false);
    expect(plan.blocked).toContainEqual(expect.objectContaining({ code: "unsupported_sql" }));
  });

  test("blocks transaction, lock, role, and server escape operations", () => {
    const operations = [
      "COMMIT",
      "select pg_advisory_unlock_all()",
      "set local role service_role",
      "copy accounts to program 'sh'",
    ];

    for (const [index, sql] of operations.entries()) {
      const plan = buildBranchMigrationPromotionPlan({
        parentRef: "production",
        branchRef: "preview",
        parent: [],
        branch: [migration(`20260718000${index + 1}`, `unsafe_${index}`, sql)],
      });
      expect(plan.safe_to_apply).toBe(false);
      expect(plan.blocked).toContainEqual(expect.objectContaining({ code: "unsupported_sql" }));
    }
  });

  test("blocks migrations that sort before the latest parent version", () => {
    const parent = [migration("202607180010", "latest", "select 10;")];
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "production",
      branchRef: "preview",
      parent,
      branch: [
        ...parent,
        migration("202607180009", "late_backfill", "select 9;"),
      ],
    });

    expect(plan.safe_to_apply).toBe(false);
    expect(plan.blocked).toContainEqual(expect.objectContaining({
      code: "out_of_order_migration",
      version: "202607180009",
    }));
  });
});
