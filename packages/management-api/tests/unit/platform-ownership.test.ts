import { describe, expect, test } from "bun:test";
import { repairPlatformRpcOwnership, renderPlatformRpcOwnershipSql, PLATFORM_PUBLIC_ROUTINES } from "../../src/services/platform-ownership";
import { renderProjectMigrationRoleSql } from "../../src/services/project-migration-role";

describe("platform workflow ownership", () => {
  test("restores SECURITY DEFINER workflow wrappers without granting private routines", () => {
    const sql = renderPlatformRpcOwnershipSql();

    expect(PLATFORM_PUBLIC_ROUTINES).toHaveLength(14);
    for (const [name] of PLATFORM_PUBLIC_ROUTINES) expect(sql).toContain(`public.${name}(jsonb)`);
    expect(sql).toContain("n.nspowner AS expected_owner");
    expect(sql).not.toContain("ALTER SCHEMA");
    expect(sql).not.toContain("LIKE");
    expect(sql).not.toContain("GRANT EXECUTE");
    expect(sql).not.toContain("service_role");
  });

  test("standalone repair executes only the bounded ownership statement", async () => {
    const statements: string[] = [];
    await repairPlatformRpcOwnership({ unsafe: async sql => { statements.push(sql); } });
    expect(statements).toEqual([renderPlatformRpcOwnershipSql()]);
  });

  test("prepare excludes exact platform signatures and repairs existing owners", () => {
    const sql = renderProjectMigrationRoleSql("supa_test", "role_test");
    expect(sql).toContain("WHERE p.oid = to_regprocedure(platform.signature)");
    expect(sql).toContain(renderPlatformRpcOwnershipSql());
  });
});
