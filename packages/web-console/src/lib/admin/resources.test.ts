import { describe, expect, test } from "bun:test";
import {
  buildResourceRegistry,
  buildTableRowsResource,
  parseTableColumnsResponse,
  tableColumnsEndpoint,
  tableRowsRouteParams,
  tableRowsResourceName,
  type ResourceLabels,
} from "./resources";

describe("buildResourceRegistry", () => {
  const englishLabels: ResourceLabels = {
    projects: "Projects",
    referenceId: "Reference ID",
    projectName: "Project Name",
    status: "Status",
    active: "Active",
    paused: "Paused",
    creating: "Creating",
    region: "Region",
    localDocker: "Local Docker",
    databaseHost: "PostgreSQL Host",
    databasePort: "PostgreSQL Port",
    tables: "Tables",
    tableName: "Table Name",
    schema: "Schema",
    type: "Type",
    rows: "Rows (est.)",
  };

  const chineseLabels: ResourceLabels = {
    projects: "项目",
    referenceId: "引用 ID",
    projectName: "项目名称",
    status: "状态",
    active: "已激活",
    paused: "已暂停",
    creating: "创建中",
    region: "运行区域",
    localDocker: "本地 Docker",
    databaseHost: "PostgreSQL 主机",
    databasePort: "PostgreSQL 端口",
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

    const chineseProjects = buildResourceRegistry([], chineseLabels).find(
      (resource) => resource.name === "v1/projects",
    );
    expect(chineseProjects).toMatchObject({ label: "项目" });
    expect(chineseProjects?.fields?.map((field) => field.label)).toEqual([
      "引用 ID",
      "项目名称",
      "状态",
      "运行区域",
      "PostgreSQL 主机",
      "PostgreSQL 端口",
    ]);
  });

  test("builds a collision-safe read-only resource for dynamic table rows", () => {
    const resource = buildTableRowsResource({
      projectRef: "alpha",
      schema: "public",
      tableName: "events",
      columns: [
        { column_name: "id", data_type: "bigint", is_nullable: "NO", column_default: null },
        { column_name: "active", data_type: "boolean", is_nullable: "YES", column_default: null },
        { column_name: "payload", data_type: "jsonb", is_nullable: "YES", column_default: null },
        { column_name: "labels", data_type: "ARRAY", is_nullable: "YES", column_default: null },
        { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
        { column_name: "__svadmin_row_id", data_type: "text", is_nullable: "YES", column_default: null },
      ],
    });

    expect(resource).toMatchObject({
      name: tableRowsResourceName("alpha", "public", "events"),
      label: "public.events",
      primaryKey: "__svadmin_row_id_",
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canShow: false,
      showInMenu: false,
      provider: { meta: { tableRowIdentityKey: "__svadmin_row_id_" } },
    });
    expect(resource.fields.map(({ key, type, required, showInList }) => ({ key, type, required, showInList }))).toEqual([
      { key: "id", type: "number", required: true, showInList: true },
      { key: "active", type: "boolean", required: false, showInList: true },
      { key: "payload", type: "json", required: false, showInList: true },
      { key: "labels", type: "array", required: false, showInList: true },
      { key: "created_at", type: "date", required: true, showInList: true },
      { key: "__svadmin_row_id", type: "text", required: false, showInList: true },
      { key: "__svadmin_row_id_", type: "text", required: false, showInList: false },
    ]);
  });

  test("uses a single database primary key without injecting a synthetic field", () => {
    const resource = buildTableRowsResource({
      projectRef: "alpha",
      schema: "public",
      tableName: "events",
      columns: [
        {
          column_name: "event_id",
          data_type: "uuid",
          is_nullable: "NO",
          column_default: null,
          is_primary_key: true,
        },
        { column_name: "payload", data_type: "jsonb", is_nullable: "YES", column_default: null },
      ],
    });

    expect(resource.primaryKey).toBe("event_id");
    expect(resource.provider).toBeUndefined();
    expect(resource.fields.map((field) => field.key)).toEqual(["event_id", "payload"]);
  });

  test("encodes existing PostgreSQL identifiers in table endpoints", () => {
    expect(tableRowsResourceName("alpha", "odd schema", 'a"b/c')).toBe(
      "v1/projects/alpha/database/tables/odd%20schema/a%22b%2Fc/rows",
    );
    expect(tableColumnsEndpoint("alpha", "odd schema", 'a"b/c')).toBe(
      "/v1/projects/alpha/database/tables/odd%20schema/a%22b%2Fc/columns",
    );
  });

  test("encodes dynamic table route parameters before passing them to SvelteKit", () => {
    expect(tableRowsRouteParams("project/alpha", "odd/schema", "events?#2026")).toEqual({
      ref: "project%2Falpha",
      schema: "odd%2Fschema",
      table_name: "events%3F%232026",
    });
  });

  test("validates table column envelopes before building a resource", () => {
    expect(parseTableColumnsResponse({
      data: [{
        column_name: "id",
        data_type: "bigint",
        udt_name: "int8",
        is_nullable: "NO",
        column_default: null,
        is_primary_key: true,
        primary_key_position: 1,
      }],
    })).toEqual([{
      column_name: "id",
      data_type: "bigint",
      udt_name: "int8",
      is_nullable: "NO",
      column_default: null,
      is_primary_key: true,
      primary_key_position: 1,
    }]);
    expect(() => parseTableColumnsResponse({ data: [{ column_name: "id" }] })).toThrow(
      "Invalid table column metadata",
    );
  });
});
