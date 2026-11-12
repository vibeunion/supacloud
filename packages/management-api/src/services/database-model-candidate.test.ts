import { expect, test } from "bun:test";
import { renderDatabaseModelCandidate } from "./database-model-candidate";

test("remote database model candidates are reviewable and contain no connection material", () => {
  const result = renderDatabaseModelCandidate({
    schemas: ["public"],
    policyCount: 1,
    enums: [{ schema: "public", name: "order_state", values: ["draft", "approved"] }],
    tables: [{
      schema: "public", name: "orders", primaryKey: ["id"], foreignKeys: [],
      columns: [
        { name: "id", dataType: "uuid", udtName: "uuid", nullable: false, defaultExpression: null },
        { name: "display_name", dataType: "text", udtName: "text", nullable: false, defaultExpression: null },
      ],
    }],
  });
  expect(result.candidate).toContain('model Orders');
  expect(result.candidate).toContain('id String @id');
  expect(result.candidate).toContain('displayName String @map("display_name")');
  expect(result.candidate).not.toContain("postgresql://");
  expect(result.warnings).toContain("1 PostgreSQL policies were detected; relationship and policy rules require explicit review");
});
