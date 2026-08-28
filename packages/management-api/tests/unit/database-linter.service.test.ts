import { describe, expect, it } from "bun:test";
import { normalizeDatabaseSchema } from "../../src/services/database-governance-input";
import { runDatabaseLinter } from "../../src/services/database-linter.service";

describe("normalizeDatabaseSchema", () => {
  it("accepts standard PostgreSQL schema identifiers", () => {
    expect(normalizeDatabaseSchema(" public ")).toBe("public");
  });

  it("rejects unsafe and oversized schema identifiers", () => {
    expect(() => normalizeDatabaseSchema("public; drop schema x")).toThrow();
    expect(() => normalizeDatabaseSchema("a".repeat(64))).toThrow();
  });
});

describe("runDatabaseLinter", () => {
  it("detects tables without primary keys, RLS disabled, missing FK indexes, and search_path missing on security definer functions", async () => {
    const mockDb = {
      unsafe: async (sqlText: string) => {
        if (sqlText.includes("FROM information_schema.tables t")) {
          return [
            { table_schema: "public", table_name: "events_log" },
          ];
        }
        if (sqlText.includes("FROM pg_tables")) {
          return [
            { schemaname: "public", tablename: "events_log" },
            { schemaname: "public", tablename: "audit_trail" },
          ];
        }
        if (sqlText.includes("FROM pg_constraint fk")) {
          return [
            { table_schema: "public", table_name: "orders", column_names: ["customer_id", "region_id"] },
          ];
        }
        if (sqlText.includes("WHERE p.prosecdef = true")) {
          return [
            {
              schema_name: "public",
              function_name: "approve_order",
              identity_args: "order_id uuid, approved_by uuid",
              proconfig: null,
            },
          ];
        }
        return [];
      },
    };

    const issues = await runDatabaseLinter(mockDb as any, "public");

    expect(issues.length).toBe(5);

    const noPk = issues.find((i) => i.type === "no_primary_key");
    expect(noPk).toBeDefined();
    expect(noPk?.severity).toBe("danger");
    expect(noPk?.category).toBe("integrity");
    expect(noPk?.object_name).toBe("events_log");
    expect(noPk?.fix_sql).toContain("ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY");

    const noRlsList = issues.filter((i) => i.type === "no_rls");
    expect(noRlsList.length).toBe(2);
    expect(noRlsList[0]?.severity).toBe("warning");
    expect(noRlsList[0]?.category).toBe("security");
    expect(noRlsList[0]?.fix_sql).toContain("ENABLE ROW LEVEL SECURITY");

    const noFkIndex = issues.find((i) => i.type === "no_index_on_fk");
    expect(noFkIndex).toBeDefined();
    expect(noFkIndex?.severity).toBe("info");
    expect(noFkIndex?.column_names).toEqual(["customer_id", "region_id"]);
    expect(noFkIndex?.fix_sql).toContain('CREATE INDEX ON "public"."orders" ("customer_id", "region_id")');

    const secDef = issues.find((i) => i.type === "security_definer_no_search_path");
    expect(secDef).toBeDefined();
    expect(secDef?.severity).toBe("danger");
    expect(secDef?.category).toBe("security");
    expect(secDef?.object_name).toBe("approve_order");
    expect(secDef?.fix_sql).toBe('ALTER FUNCTION "public"."approve_order"(order_id uuid, approved_by uuid) SET search_path = pg_catalog;');
  });

  it("uses exact catalog metadata for foreign-key coverage and scopes function checks", async () => {
    const statements: string[] = [];
    const mockDb = {
      unsafe: async (sqlText: string) => {
        statements.push(sqlText);
        return [];
      },
    };

    await runDatabaseLinter(mockDb as any, "tenant_api");

    const foreignKeyQuery = statements.find((sql) => sql.includes("FROM pg_constraint fk"));
    expect(foreignKeyQuery).toContain("unnest(idx.indkey) WITH ORDINALITY");
    expect(foreignKeyQuery).toContain("idx.indpred IS NULL");
    expect(foreignKeyQuery).not.toContain("indexdef LIKE");

    const functionQuery = statements.find((sql) => sql.includes("WHERE p.prosecdef = true"));
    expect(functionQuery).toContain("p.prokind = 'f'");
    expect(functionQuery).toContain("n.nspname = 'tenant_api'");
  });
});
