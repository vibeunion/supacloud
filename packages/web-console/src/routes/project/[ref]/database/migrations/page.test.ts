import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("database migration history page", () => {
  test("uses the controlled migration ledger endpoint", () => {
    expect(source).toContain("/database/migrations");
    expect(source).not.toContain("MIGRATIONS_SQL");
  });

  test("shows migration checksums", () => {
    expect(source).toContain("checksum");
  });
});
