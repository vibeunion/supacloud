import { describe, expect, test } from "bun:test";
import { migrationVersionFromFilename } from "./database-tools";

describe("database migration helpers", () => {
    test("uses Supabase timestamp prefix as migration version", () => {
        expect(migrationVersionFromFilename("20260425123000_create_users.sql")).toBe(20260425123000);
        expect(migrationVersionFromFilename("20260425123000123456-create-users.sql")).toBe(20260425123000123456);
    });

    test("falls back to a generated numeric version for non timestamp names", () => {
        const version = migrationVersionFromFilename("create_users.sql", 2);
        expect(Number.isFinite(version)).toBe(true);
        expect(version).toBeGreaterThan(Date.now() * 1000 - 60_000_000);
    });
});
