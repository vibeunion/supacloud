import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  buildResourceRegistry,
  getTenantResources,
  buildTableRowsResource,
  parseTableColumnsResponse,
  tableColumnsEndpoint,
  tableRowsRouteParams,
  tableRowsResourceName,
  type ResourceLabels,
} from "./resources";
import type { TenantAuthUserRecord, TenantTableRecord } from "./contracts";
import { tenantTablesContract, tenantAuthUsersContract } from "./contracts";
import { getResourceList } from "./typed-list";
import { Type } from "typebox";
import { parseContractRecord } from "@svadmin/core/resource-contract";
import { defineSvadminResource } from "./svadmin-contract";

describe("buildResourceRegistry", () => {
  test("uses native TypeBox contracts without mutating schemas with legacy markers", () => {
    const schema = Type.Object({ id: Type.String(), email: Type.Optional(Type.String()) });
    const contract = defineSvadminResource("native-users", { record: schema });
    expect(Object.getOwnPropertySymbols(schema)).toEqual([]);
    expect(Object.getOwnPropertySymbols(schema.properties.id)).toEqual([]);
    expect(parseContractRecord(contract, { id: "user-1" })).toEqual({ id: "user-1" });
    expect(() => parseContractRecord(contract, { id: "user-1", email: 42 })).toThrow();
    expect(() => parseContractRecord(contract, { id: "user-1", admin: true })).toThrow();
  });
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

  test("keeps static svadmin record types attached to resource contracts", () => {
    const table: TenantTableRecord = {
      id: "users",
      table_name: "users",
      table_schema: "public",
      table_type: "BASE TABLE",
      row_estimate: "3",
    };
    const user: TenantAuthUserRecord = {
      id: "user-1",
      email: null,
      role: "authenticated",
      created_at: null,
      last_sign_in_at: null,
    };

    expect(table.table_name).toBe("users");
    expect(user.id).toBe("user-1");
  });

  test("typechecks inferred resource results and rejects incorrect field access", () => {
    const result = Bun.spawnSync([
      "./node_modules/.bin/tsc", "--ignoreConfig", "--noEmit", "--strict",
      "--skipLibCheck", "--module", "esnext", "--moduleResolution", "bundler",
      "--target", "es2022", "src/lib/admin/typed-list.typecheck.ts",
    ], { cwd: fileURLToPath(new URL("../../../", import.meta.url)) });
    expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("keeps memoized contracts isolated by resource and tenant", () => {
    expect(tenantTablesContract("alpha")).toBe(tenantTablesContract("alpha"));
    expect(tenantAuthUsersContract("alpha")).toBe(tenantAuthUsersContract("alpha"));
    expect(tenantTablesContract("alpha")).not.toBe(tenantTablesContract("beta"));
    expect(tenantTablesContract("alpha")).not.toBe(tenantAuthUsersContract("alpha"));
  });

  test("reads typed tenant resources through projection and strict validation", async () => {
    const originalFetch = globalThis.fetch;
    const [tables, users] = getTenantResources("alpha", englishLabels);
    const requests: string[] = [];
    let payload: unknown = {
      data: [{ table_name: "events", table_schema: "public", table_type: "BASE TABLE", row_estimate: "3", extra: true }],
      total: 1,
    };
    globalThis.fetch = async (request) => {
      requests.push(String(request));
      return Response.json(payload);
    };
    try {
      const result = await getResourceList(tables);
      expect(result.data).toEqual([{
        id: "events", table_name: "events", table_schema: "public",
        table_type: "BASE TABLE", row_estimate: "3",
      }]);
      expect(new URL(requests[0]!).pathname).toBe("/v1/projects/alpha/database/tables");
      payload = { users: [{ id: "user-1", email: null, user_metadata: { private: true } }], total: 1 };
      expect((await getResourceList(users)).data).toEqual([{ id: "user-1", email: null }]);
      expect(new URL(requests[1]!).pathname).toBe("/v1/projects/alpha/auth/users");
      payload = { users: [{ id: "user-1", email: 42 }], total: 1 };
      await expect(getResourceList(users)).rejects.toThrow();
      payload = { data: [{ table_name: "events", table_schema: "public", table_type: "BASE TABLE", row_estimate: false }], total: 1 };
      await expect(getResourceList(tables)).rejects.toThrow();
      const requestCount = requests.length;
      await expect(getResourceList({ ...tables, name: "v1/projects/beta/database/tables" })).rejects.toThrow();
      expect(requests).toHaveLength(requestCount);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  test("identifies public-schema tables by the key returned by the API", () => {
    const tableResource = buildResourceRegistry(["alpha123"], englishLabels).find(
      (resource) => resource.name === "v1/projects/alpha123/database/tables",
    );
    const rows: Record<string, unknown>[] = [
      { table_schema: "public", table_name: "users" },
      { table_schema: "public", table_name: "events" },
    ];

    // SVAdmin contracts require an id-based record, so the provider projects
    // every API row's table_name into the contract id.
    expect(tableResource?.contract?.name).toBe("v1/projects/alpha123/database/tables");
    expect(tableResource?.provider?.meta?.contractProjection).toMatchObject({
      contractKeys: ["table_name", "table_schema", "table_type", "row_estimate"],
      idFrom: "table_name",
    });
    const identities = rows.map((row) => row["table_name"]);
    expect(identities).toEqual(["users", "events"]);
    expect(new Set(identities).size).toBe(rows.length);
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
      primaryKey: "id",
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canShow: false,
      showInMenu: false,
      provider: {
        meta: {
          tableRowIdentityKey: "__svadmin_row_id_",
          contractProjection: {
            idFrom: "__svadmin_row_id_",
            stringifyComplex: true,
          },
        },
      },
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

    expect(resource.primaryKey).toBe("id");
    expect(resource.provider?.meta?.contractProjection).toMatchObject({
      idFrom: "event_id",
      stringifyComplex: true,
    });
    expect(resource.fields.map((field) => field.key)).toEqual(["event_id", "payload"]);
  });

  test("binds the table-row contract to the encoded resource name", () => {
    const resource = buildTableRowsResource({
      projectRef: "odd project",
      schema: "odd schema",
      tableName: 'a"b/c',
      columns: [
        { column_name: "event_id", data_type: "uuid", is_nullable: "NO", column_default: null, is_primary_key: true },
      ],
    });

    expect(resource.contract?.name).toBe(resource.name);
    expect(resource.name).toBe(tableRowsResourceName("odd project", "odd schema", 'a"b/c'));
  });

  test("encodes existing PostgreSQL identifiers in table endpoints", () => {    expect(tableRowsResourceName("alpha", "odd schema", 'a"b/c')).toBe(
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
