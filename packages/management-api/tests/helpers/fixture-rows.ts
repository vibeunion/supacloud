import { Type, type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function fixtureRows<T extends TObject>(schema: T, value: unknown): Static<T>[] {
  if (!Value.Check(Type.Array(schema), value)) {
    throw new Error("Invalid database fixture rows");
  }
  return value;
}

export function fixtureRow<T extends TObject>(schema: T, value: unknown): Static<T> {
  const rows = fixtureRows(schema, value);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error("Expected exactly one database fixture row");
  }
  return row;
}
