import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("branch promotion page", () => {
  test("presents migration promotion as the safe default", () => {
    expect(source).toContain('$t("Branches.review_migrations")');
    expect(source).toContain('$t("Branches.migration_first_description")');
    expect(source).toContain("plan_checksum");
    expect(source).toContain('$t("Branches.review_sql")');
    expect(source).toContain('$t("Branches.applied_before_failure"');
  });

  test("isolates whole-database replacement behind explicit confirmation", () => {
    expect(source).toContain('$t("Branches.replace_database")');
    expect(source).toContain("replace_database");
    expect(source).toContain("REPLACE ");
    expect(source).toContain("replacementRecoveryRequired");
    expect(source).toContain("disabled={replacementRecoveryRequired || replaceDatabaseMut.isPending}");
    expect(source).toContain('$t("Branches.backup_evidence_missing")');
  });
});
