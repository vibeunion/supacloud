import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationVersionFromFilename, registerDatabaseTools, vectorWarningsForPendingMigrations } from "./database-tools";

function captureDatabaseTool(http: Record<string, unknown>) {
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerDatabaseTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name !== "database") return;
            callback = toolCallback;
        },
    }, http as any);

    if (!callback) throw new Error("database tool was not registered");
    return callback;
}

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

    test("recognizes applied migrations when API returns a bare array", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");

            const callback = captureDatabaseTool({
                get: async (path: string) => {
                    expect(path).toBe("/v1/projects/proj/database/migrations");
                    return {
                        ok: true,
                        status: 200,
                        data: [
                            { version: "20260425123000", name: "20260425123000_create_users" },
                        ],
                    };
                },
            });

            const result = await callback({
                action: "push_migrations",
                ref: "proj",
                dir,
                dry_run: true,
            });
            const text = result.content[0].text;

            expect(text).toContain("Pending:\n  - 20260425124000_create_tasks.sql (20260425124000)");
            expect(text).toContain("Already applied:\n  - 20260425123000_create_users.sql (20260425123000)");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("previews baseline repair without executing SQL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: Array<{ path: string; body: unknown }> = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");

            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        { version: "20260425123000", name: "20260425123000_create_users" },
                    ],
                }),
                post: async (path: string, body: unknown) => {
                    posts.push({ path, body });
                    return { ok: true, status: 200, data: { rows: [] } };
                },
            });

            const result = await callback({
                action: "baseline_migrations",
                ref: "proj",
                dir,
                dry_run: true,
            });
            const text = result.content[0].text;

            expect(text).toContain("Migration baseline dry run");
            expect(text).toContain("Would mark as applied:\n  - 20260425124000_create_tasks.sql (20260425124000)");
            expect(text).toContain("Already applied:\n  - 20260425123000_create_users.sql (20260425123000)");
            expect(posts).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("baselines missing migrations through migration-mode SQL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: Array<{ path: string; body: any }> = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");

            const callback = captureDatabaseTool({
                get: async (path: string) => {
                    expect(path).toBe("/v1/projects/proj/database/migrations");
                    return { ok: true, status: 200, data: [] };
                },
                post: async (path: string, body: unknown) => {
                    posts.push({ path, body });
                    return { ok: true, status: 200, data: { rows: [] } };
                },
            });

            const result = await callback({
                action: "baseline_migrations",
                ref: "proj",
                dir,
            });
            const text = result.content[0].text;

            expect(text).toContain("Migration baseline completed");
            expect(text).toContain("Marked applied: 2");
            expect(posts).toHaveLength(1);
            expect(posts[0].path).toBe("/v1/projects/proj/database/sql");
            expect(posts[0].body.mode).toBe("migration");
            expect(posts[0].body.sql).toContain("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
            expect(posts[0].body.sql).toContain("CREATE TABLE IF NOT EXISTS public.schema_migrations");
            expect(posts[0].body.sql).toContain("20260425123000_create_users");
            expect(posts[0].body.sql).toContain("20260425124000_create_tasks");
            expect(posts[0].body.sql).toContain("ON CONFLICT (version) DO UPDATE");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
