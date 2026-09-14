import { expect, test } from "bun:test";
import { initialTableColumns, tableColumnWithType, type TableColumnDraft } from "./table-draft";

test("integer column changes preserve absent identity instead of emitting undefined", () => {
  const column: TableColumnDraft = { name: "quantity", type: "text", nullable: true };
  for (const type of ["integer", "bigint"] as const) {
    const changed = tableColumnWithType(column, type);
    expect(changed).not.toHaveProperty("identity");
    expect(changed).toEqual({ ...column, type });
  }
  expect(column).toEqual({ name: "quantity", type: "text", nullable: true });
});

test("noninteger types disable identity and cannot silently reenable it", () => {
  const primary = initialTableColumns()[0];
  if (!primary) throw new Error("Missing primary column");
  const changed = tableColumnWithType(primary, "uuid");
  expect(changed.identity).toBe(false);
  expect(tableColumnWithType(changed, "integer").identity).toBe(false);
  expect(primary.identity).toBe(true);
});
