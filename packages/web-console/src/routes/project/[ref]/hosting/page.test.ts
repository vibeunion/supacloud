import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("./+layout.svelte", import.meta.url), "utf8");

describe("hosting deployment entrypoints", () => {
  test("shows only the empty-state action when no deployments exist", () => {
    expect(pageSource).toContain("{#if deployments.length > 0}");
    expect(pageSource).toContain('{$t("Hosting.no_deployments")}');
    expect(layoutSource).not.toContain('{ id: "new"');
  });
});
