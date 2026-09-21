import { expect, test } from "bun:test";
import { parseSqlEditorDrafts, serializeSqlEditorDrafts, sqlRowsToCsv, wrapSqlWithRole } from "./sql-editor-drafts";

test("restores only draft fields, never cached rows or execution metadata", () => {
  const saved = [{ id: "one", name: "Query", sql: "select 1", results: [{ secret: "old-result" }], error: "stale" }];
  expect(parseSqlEditorDrafts(saved)).toEqual([{ id: "one", name: "Query", sql: "select 1" }]);
  expect(JSON.parse(serializeSqlEditorDrafts(saved))).toEqual([{ id: "one", name: "Query", sql: "select 1" }]);
});

test("rejects malformed or ambiguous drafts atomically", () => {
  const valid = { id: "one", name: "Query", sql: "" };
  for (const value of [null, {}, [], [null], [valid, null], [valid, valid],
    [{ ...valid, id: "" }], [{ ...valid, name: " " }], [{ ...valid, sql: 1 }], new Array(1)]) {
    expect(() => parseSqlEditorDrafts(value)).toThrow("Invalid SQL drafts");
  }
  expect(parseSqlEditorDrafts([valid])).toEqual([valid]);
});

test("quotes role identifiers without changing the submitted SQL", () => {
  expect(wrapSqlWithRole("select 1;", "postgres")).toBe("select 1;");
  expect(wrapSqlWithRole("select 1;", "authenticated")).toBe('SET ROLE "authenticated";\nselect 1;\nRESET ROLE;');
  expect(wrapSqlWithRole("select 1;", 'x"; RESET ROLE; --')).toBe('SET ROLE "x""; RESET ROLE; --";\nselect 1;\nRESET ROLE;');
  expect(wrapSqlWithRole("select 1;", "role'name")).toContain('"role\'name"');
  expect(() => wrapSqlWithRole("select 1", "\0")).toThrow("Invalid SQL role");
  expect(() => wrapSqlWithRole("select 1", " ")).toThrow("Invalid SQL role");
});

test("CSV aligns reordered rows and quotes headers, CR, LF and double quotes", () => {
  expect(sqlRowsToCsv([])).toBe("");
  expect(sqlRowsToCsv([{ "a,b": 'x"y', next: "line\rbreak" }, { next: false, "a,b": 0 }]))
    .toBe('"a,b",next\n"x""y","line\rbreak"\n0,false');
  expect(sqlRowsToCsv([{ a: null, b: { nested: true } }, { b: "\n" }]))
    .toBe('a,b\n,"{""nested"":true}"\n,"\n"');
});
