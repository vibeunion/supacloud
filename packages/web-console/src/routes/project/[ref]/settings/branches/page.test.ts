import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("branch promotion page", () => {
  test("presents migration promotion as the safe default", () => {
    expect(source).toContain("Review migrations");
    expect(source).toContain("not automatically copy branch data");
    expect(source).toContain("plan_checksum");
    expect(source).toContain("Review SQL");
    expect(source).toContain("Applied before failure");
  });

  test("isolates whole-database replacement behind explicit confirmation", () => {
    expect(source).toContain("Replace entire database");
    expect(source).toContain("replace_database");
    expect(source).toContain("REPLACE ");
    expect(source).toContain("replacementRecoveryRequired");
    expect(source).toContain("disabled={replacementRecoveryRequired || replaceDatabaseMut.isPending}");
    expect(source).toContain("required backup database name");
  });
});
