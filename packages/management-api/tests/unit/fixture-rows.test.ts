import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { fixtureRow, fixtureRows } from "../helpers/fixture-rows";

const schema = Type.Object({
  id: Type.String(),
  count: Type.Integer(),
  enabled: Type.Boolean(),
  labels: Type.Union([Type.Array(Type.String()), Type.Null()]),
});
const row = { id: "one", count: 0, enabled: false, labels: null };

describe("database fixture read-back", () => {
  test("preserves native null, false, zero and arrays", () => {
    expect(fixtureRow(schema, [row])).toEqual(row);
    const rows = [row, { ...row, id: "two", labels: ["", "a,b", "back\\slash"] }];
    expect(fixtureRows(schema, rows)).toEqual(rows);
    expect(fixtureRows(schema, [])).toEqual([]);
  });

  for (const value of [undefined, null, {}, "rows", [null], [{ ...row, count: "0" }],
    [{ ...row, enabled: 0 }], [{ ...row, labels: [1] }], [{ id: "one" }]]) {
    test(`rejects malformed result ${JSON.stringify(value)}`, () => {
      expect(() => fixtureRows(schema, value)).toThrow("Invalid database fixture rows");
    });
  }

  test("rejects missing and duplicate single-row receipts", () => {
    expect(() => fixtureRow(schema, [])).toThrow("Expected exactly one");
    expect(() => fixtureRow(schema, [row, row])).toThrow("Expected exactly one");
  });
});
