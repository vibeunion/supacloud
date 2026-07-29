import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("query performance report", () => {
  test("renders rows when multiple statistics contain the same query text", () => {
    expect(source).toContain("{#each stats as stat}");
    expect(source).not.toContain("{#each stats as stat (stat.query)}");
  });

  test("uses the restricted query-performance endpoint instead of admin SQL", () => {
    expect(source).toContain("/database/query-performance");
    expect(source).not.toContain('mode: "admin"');
    expect(source).not.toContain("FROM ${schemaPrefix}pg_stat_statements");
  });
});
