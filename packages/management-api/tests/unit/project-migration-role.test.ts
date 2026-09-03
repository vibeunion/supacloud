import { describe, expect, test } from "bun:test";
import { renderProjectMigrationRoleSql } from "../../src/services/project-migration-role";

describe("project migration role preparation", () => {
  test("limits application DDL ownership to project-scoped public objects", () => {
    const sql = renderProjectMigrationRoleSql("supa_parent", "role_parent");

    expect(sql).toContain('GRANT CREATE ON DATABASE "supa_parent" TO "role_parent"');
    expect(sql).toContain('ALTER ROLE "role_parent" BYPASSRLS');
    expect(sql).toContain('ALTER SCHEMA public OWNER TO "role_parent"');
    expect(sql).toContain("c.relname <> 'schema_migrations'");
    expect(sql).toContain("d.deptype = 'e'");
    expect(sql).toContain("GRANT SELECT ON TABLE supabase_migrations.schema_migrations");
    expect(sql).toContain("REVOKE ALL ON TABLE supabase_migrations.schema_migrations FROM PUBLIC, anon, authenticated, service_role");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("record_schema_migration");
    expect(sql).toContain("migration_ledger_leases");
    expect(sql).toContain("sha256(convert_to(migration_token, 'UTF8'))");
    expect(sql).toContain("lease_consumed IS DISTINCT FROM TRUE");
    expect(sql).not.toContain("GRANT SELECT, INSERT ON TABLE");
    expect(sql).not.toContain("SUPERUSER");
    expect(sql).not.toContain("CREATEROLE");
  });

  test("orders tables and partitioned tables before linked sequences", () => {
    const sql = renderProjectMigrationRoleSql("supa_parent", "role_parent");

    expect(sql).toContain("ORDER BY CASE WHEN c.relkind = 'S' THEN 1 ELSE 0 END, c.oid");
  });

  test("rejects unsafe database and role identifiers", () => {
    expect(() => renderProjectMigrationRoleSql("supa_parent; drop database x", "role_parent")).toThrow();
    expect(() => renderProjectMigrationRoleSql("supa_parent", "role_parent; alter role postgres")).toThrow();
  });

  test("grants BYPASSRLS idempotently so migrations can write RLS-protected platform tables", async () => {
    const { prepareProjectMigrationRole } = await import("../../src/services/project-migration-role");
    const executed: string[] = [];
    const adminDb = {
      unsafe(statement: string) {
        executed.push(statement);
        return Promise.resolve([]);
      },
    };

    await prepareProjectMigrationRole(adminDb, "supa_parent", "role_parent");
    await prepareProjectMigrationRole(adminDb, "supa_parent", "role_parent");

    expect(executed).toHaveLength(2);
    for (const statement of executed) {
      expect(statement).toContain('ALTER ROLE "role_parent" BYPASSRLS');
      expect(statement).not.toContain("SUPERUSER");
    }
  });
});
