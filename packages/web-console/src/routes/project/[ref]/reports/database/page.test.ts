import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const reportIndexSource = readFileSync(new URL("../+page.svelte", import.meta.url), "utf8");

describe("database report table", () => {
  test("keeps database and query performance on distinct routes", () => {
    expect(reportIndexSource).toContain('href: "database"');
    expect(reportIndexSource).toContain('href: "query-performance"');
  });

  test("keeps the sticky header opaque and above table rows", () => {
    expect(source).toContain('<thead class="bg-card border-b sticky top-0 z-10">');
  });
});
