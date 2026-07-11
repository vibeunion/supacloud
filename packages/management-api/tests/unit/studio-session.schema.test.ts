import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const initSource = readFileSync(new URL("../../src/db/init.ts", import.meta.url), "utf8");

describe("Studio session schema", () => {
  test("creates an additive hashed-token session table and cleanup indexes", () => {
    expect(initSource).toContain("CREATE TABLE IF NOT EXISTS studio_sessions");
    expect(initSource).toContain("token_hash TEXT UNIQUE NOT NULL");
    expect(initSource).toContain("CREATE INDEX IF NOT EXISTS idx_studio_sessions_expires_at");
    expect(initSource).toContain("CREATE INDEX IF NOT EXISTS idx_studio_sessions_active");

    const tableStart = initSource.indexOf("CREATE TABLE IF NOT EXISTS studio_sessions");
    const tableEnd = initSource.indexOf(");", tableStart);
    const tableSql = initSource.slice(tableStart, tableEnd);
    expect(tableSql).not.toMatch(/\btoken\s+TEXT\b/i);
  });
});
