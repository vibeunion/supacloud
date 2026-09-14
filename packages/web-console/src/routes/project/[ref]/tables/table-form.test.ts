import { describe, expect, test } from "bun:test";
import { isValidTableForm } from "./table-form";

describe("table form schema", () => {
  test("accepts the default table draft", () => {
    expect(isValidTableForm({
      name: "orders",
      columns: [{ name: "id", type: "bigint", nullable: false, primaryKey: true, identity: true }],
    })).toBeTrue();
  });

  test("maps invalid table and column names to field errors", () => {
    expect(isValidTableForm({
      name: "orders;drop",
      columns: [{ name: "1id", type: "text", nullable: true }],
    })).toBeFalse();
  });

  test("rejects empty and oversized column lists", () => {
    expect(isValidTableForm({ name: "orders", columns: [] })).toBeFalse();
    expect(isValidTableForm({
      name: "orders",
      columns: Array.from({ length: 65 }, (_, index) => ({ name: `column_${index}`, type: "text", nullable: true })),
    })).toBeFalse();
  });
});
