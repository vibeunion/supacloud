import { describe, expect, test } from "bun:test";
import { isSqlTabNameAvailable, nextSqlTabName } from "./sql-tab-names";

describe("SQL tab names", () => {
  test("starts untitled tabs at one and fills the first available suffix", () => {
    expect(nextSqlTabName([], "Untitled query")).toBe("Untitled query 1");
    expect(nextSqlTabName([
      { id: "first", name: "Untitled query 1" },
      { id: "third", name: "Untitled query 3" },
    ], "Untitled query")).toBe("Untitled query 2");
  });

  test("prevents duplicate renamed tabs without rejecting the current tab name", () => {
    const tabs = [
      { id: "first", name: "Untitled query 1" },
      { id: "second", name: "Revenue" },
    ];

    expect(isSqlTabNameAvailable(tabs, "second", "revenue")).toBe(true);
    expect(isSqlTabNameAvailable(tabs, "second", " untitled query 1 ")).toBe(false);
  });
});
