import { describe, expect, test } from "bun:test";
import { buildResourceRegistry } from "./resources";

describe("buildResourceRegistry", () => {
  const englishLabels = {
    tables: "Tables",
    tableName: "Table Name",
    schema: "Schema",
    type: "Type",
    rows: "Rows (est.)",
  };

  const chineseLabels = {
    tables: "数据表列表",
    tableName: "表名",
    schema: "模式",
    type: "类型",
    rows: "行数（估算）",
  };

  test("includes tenant auth resources for every known project", () => {
    const registry = buildResourceRegistry(["alpha123", "beta456"], englishLabels);
    const names = registry.map((resource) => resource.name);

    expect(names).toContain("v1/projects/alpha123/auth/users");
    expect(names).toContain("v1/projects/beta456/auth/users");
    expect(names).toContain("v1/projects/alpha123/database/tables");
  });

  test("deduplicates repeated project refs", () => {
    const registry = buildResourceRegistry(["alpha123", "alpha123"], englishLabels);
    const authResources = registry.filter(
      (resource) => resource.name === "v1/projects/alpha123/auth/users",
    );

    expect(authResources).toHaveLength(1);
  });

  test("keeps table creation on the dedicated migration-backed page", () => {
    const tableResource = buildResourceRegistry(["alpha123"], englishLabels).find(
      (resource) => resource.name === "v1/projects/alpha123/database/tables",
    );

    expect(tableResource?.canCreate).toBe(false);
    expect(tableResource?.canEdit).toBe(false);
  });

  test("keeps Auth user actions on the dedicated page instead of API-like routes", () => {
    const [authUsers] = buildResourceRegistry(["alpha123"], englishLabels).filter(
      (resource) => resource.name === "v1/projects/alpha123/auth/users",
    );

    expect(authUsers).toMatchObject({
      canCreate: false,
      canEdit: false,
    });
  });

  test("uses the caller's locale labels without translating technical resource values", () => {
    const englishTables = buildResourceRegistry(["alpha123"], englishLabels).find(
      (resource) => resource.name === "v1/projects/alpha123/database/tables",
    );
    const chineseTables = buildResourceRegistry(["alpha123"], chineseLabels).find(
      (resource) => resource.name === "v1/projects/alpha123/database/tables",
    );

    expect(englishTables?.label).toBe("Tables");
    expect(chineseTables?.label).toBe("数据表列表");
    expect(chineseTables?.fields?.map((field) => field.label)).toEqual([
      "表名",
      "模式",
      "类型",
      "行数（估算）",
    ]);
  });
});
