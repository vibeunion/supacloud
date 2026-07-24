import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("project dashboard", () => {
  test("renders the project quick links in exactly one section", () => {
    expect(pageSource.match(/\{#each QUICK_LINKS/g) ?? []).toHaveLength(1);
    expect(pageSource).toContain("<!-- Quick Links -->");
    expect(pageSource).not.toContain("<!-- Quick Access Cards -->");
  });
});
