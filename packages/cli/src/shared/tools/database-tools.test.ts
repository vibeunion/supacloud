import { describe, expect, test } from "bun:test";
import { migrationVersionFromFilename, vectorWarningsForPendingMigrations } from "./database-tools";

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

    test("warns when pending migrations use pgvector without enabled extension", () => {
        const warnings = vectorWarningsForPendingMigrations([
            {
                file: "20260425124000_add_vector_index.sql",
                sql: "CREATE TABLE documents (embedding vector(1536));",
            },
        ], false);

        expect(warnings[0]).toContain("vector extension is not enabled");
        expect(warnings[0]).toContain("20260425124000_add_vector_index.sql");
    });

    test("reports when pending migrations enable pgvector", () => {
        const warnings = vectorWarningsForPendingMigrations([
            {
                file: "20260425123000_enable_vector.sql",
                sql: "CREATE EXTENSION IF NOT EXISTS vector;",
            },
        ], false);

        expect(warnings[0]).toContain("will enable pgvector");
    });
});
