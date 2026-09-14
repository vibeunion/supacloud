import { describe, expect, test } from "bun:test";
import { createSchemaFormValidator } from "../../../../../node_modules/@svadmin/core/src/schema-form.ts";
import { tableFormSchema } from "./table-form";

const validate = createSchemaFormValidator(tableFormSchema);

describe("table form schema", () => {
  test("accepts the default table draft", () => {
    expect(validate({
      name: "orders",
      columns: [{ name: "id", type: "bigint", nullable: false, primaryKey: true, identity: true }],
    })).toBeNull();
  });

  test("maps invalid table and column names to field errors", () => {
    const errors = validate({
      name: "orders;drop",
      columns: [{ name: "1id", type: "text", nullable: true }],
    });
    expect(errors).toMatchObject({ name: "Invalid value", "columns.0.name": "Invalid value" });
  });

  test("rejects empty and oversized column lists", () => {
    expect(validate({ name: "orders", columns: [] })).toMatchObject({ columns: "Invalid value" });
    expect(validate({
      name: "orders",
      columns: Array.from({ length: 65 }, (_, index) => ({ name: `column_${index}`, type: "text", nullable: true })),
    })).toMatchObject({ columns: "Invalid value" });
  });
});
