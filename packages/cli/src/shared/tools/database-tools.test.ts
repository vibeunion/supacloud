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
        expect(migrationVersionFromFilename("20260425123000_create_users.sql")).toBe("20260425123000");
    });

    test("preserves valid 19-digit migration versions without precision loss", () => {
        expect(migrationVersionFromFilename("9007199254740993001_create_users.sql")).toBe("9007199254740993001");
        expect(migrationVersionFromFilename("9223372036854775807_max_version.sql")).toBe("9223372036854775807");
    });

    test("rejects migration versions above the PostgreSQL BIGINT limit", () => {
        expect(() => migrationVersionFromFilename("20260425123000123456-create-users.sql"))
            .toThrow("expected 1..9223372036854775807");
        expect(() => migrationVersionFromFilename("8000000000000000001-collides-with-fallback.sql"))
            .toThrow("reserved for non-timestamp migrations");
    });

    test("uses a stable numeric version for non timestamp names", () => {
        const first = migrationVersionFromFilename("create_users.sql");
        const second = migrationVersionFromFilename("create_users.sql");

        expect(second).toBe(first);
        expect(first).toMatch(/^\d+$/);
        expect(BigInt(first)).toBeGreaterThanOrEqual(8_000_000_000_000_000_000n);
        expect(BigInt(first)).toBeLessThan(9_000_000_000_000_000_000n);
    });

    test("pushes non-timestamp migrations in stable fallback-version order", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: Array<{ name: string; version: string }> = [];
        try {
            writeFileSync(join(dir, "alpha.sql"), "CREATE TABLE alpha (id uuid);\n");
            writeFileSync(join(dir, "beta.sql"), "CREATE TABLE beta (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                post: async (_path: string, body: { name: string; version: string }) => {
                    posts.push({ name: body.name, version: body.version });
                    return { ok: true, status: 200, data: {} };
                },
            });

            await callback({ action: "push_migrations", ref: "proj", dir });

            expect(posts).toHaveLength(2);
            expect(BigInt(posts[0].version)).toBeLessThan(BigInt(posts[1].version));
            expect(posts.map(({ name }) => name)).toEqual(
                [...posts].sort((a, b) => BigInt(a.version) < BigInt(b.version) ? -1 : 1).map(({ name }) => name),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects distinct migration files with the same version", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_alpha.sql"), "CREATE TABLE alpha (id uuid);\n");
            writeFileSync(join(dir, "20260425123000_beta.sql"), "CREATE TABLE beta (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                post: async () => ({ ok: true, status: 200, data: {} }),
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("Migration version collision");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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

    test("skips only the exact already-applied migration response", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                post: async () => ({
                    ok: false,
                    status: 409,
                    data: { code: "409", message: "Migration already applied" },
                }),
            });

            const toolResult = await callback({ action: "push_migrations", ref: "proj", dir });
            expect(toolResult.content[0].text).toContain("Migration push completed");
            expect(toolResult.content[0].text).toContain("Applied: 0");
            expect(toolResult.content[0].text).toContain("Skipped: 1");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("fails migration pushes on checksum-conflict 409 responses", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                post: async () => ({
                    ok: false,
                    status: 409,
                    data: {
                        code: "migration_checksum_conflict",
                        message: "Migration conflicts with an existing checksum",
                    },
                }),
            });

            const toolResult = await callback({ action: "push_migrations", ref: "proj", dir });
            expect(toolResult.content[0].text).toContain("Failed to apply 20260425123000_create_users.sql (409)");
            expect(toolResult.content[0].text).toContain("migration_checksum_conflict");
            expect(toolResult.content[0].text).toContain("Skipped before failure: 0");
            expect(toolResult.content[0].text).not.toContain("Migration push completed");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("skips baseline markers before POST but still POSTs ordinary existing migrations", async () => {
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
                        {
                            version: "20260425123000",
                            name: "20260425123000_create_users",
                            statements: ["baseline:20260425123000_create_users"],
                        },
                        {
                            version: "20260425124000",
                            name: "20260425124000_create_tasks",
                            statements: ["CREATE TABLE tasks (id uuid);"],
                        },
                    ],
                }),
                post: async (path: string, body: unknown) => {
                    posts.push({ path, body });
                    return { ok: true, status: 200, data: {} };
                },
            });

            const toolResult = await callback({ action: "push_migrations", ref: "proj", dir });
            const text = toolResult.content[0].text;

            expect(text).toContain("Migration push completed");
            expect(text).toContain("Applied: 1");
            expect(text).toContain("Skipped: 1");
            expect(posts).toHaveLength(1);
            expect(posts[0].path).toBe("/v1/projects/proj/database/migrations");
            expect((posts[0].body as { name: string }).name).toBe("20260425124000_create_tasks");
            expect((posts[0].body as { version: string }).version).toBe("20260425124000");
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

  test("create_table_rls defaults to deny-all and removes the legacy permissive policy", async () => {
    const posts: Array<{ path: string; body: { sql?: string } }> = [];
    const callback = captureDatabaseTool({
      post: async (path: string, body: { sql?: string }) => {
        posts.push({ path, body });
        return { ok: true, status: 200, data: { rows: [] } };
      },
    });

    const result = await callback({
      action: "create_table_rls",
      ref: "proj",
      schema: "public",
      table: "todos",
      columns: "id uuid primary key, owner_id uuid not null",
    });

    expect(result.content[0]?.text).toContain("deny-all");
    expect(posts).toHaveLength(1);
    const sql = posts[0]?.body.sql || "";
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('DROP POLICY IF EXISTS "Enable ALL for authenticated"');
    expect(sql).not.toContain("USING (true)");
    expect(sql).not.toContain("WITH CHECK (true)");
  });

  test("create_table_rls owner mode creates idempotent auth.uid policies", async () => {
    const posts: Array<{ body: { sql?: string } }> = [];
    const callback = captureDatabaseTool({
      post: async (_path: string, body: { sql?: string }) => {
        posts.push({ body });
        return { ok: true, status: 200, data: { rows: [] } };
      },
    });

    const result = await callback({
      action: "create_table_rls",
      ref: "proj",
      schema: "public",
      table: "todos",
      columns: "id uuid primary key, owner_id uuid not null",
      policy_mode: "owner",
      owner_column: "owner_id",
    });

    expect(result.content[0]?.text).toContain("owner policy");
    const sql = posts[0]?.body.sql || "";
    expect(sql).toContain('DROP POLICY IF EXISTS "SupaCloud owner select"');
    expect(sql).toContain('FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND auth.uid() = "owner_id")');
    expect(sql).toContain('FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = "owner_id")');
    expect(sql).toContain('FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL AND auth.uid() = "owner_id") WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = "owner_id")');
    expect(sql).toContain('FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL AND auth.uid() = "owner_id")');
  });

  test("create_table_rls rejects unsafe identifiers and multi-statement column definitions", async () => {
    const callback = captureDatabaseTool({
      post: async () => ({ ok: true, status: 200, data: { rows: [] } }),
    });

    await expect(callback({
      action: "create_table_rls",
      ref: "proj",
      table: 'todos";drop',
      columns: "id uuid",
    })).rejects.toThrow("Invalid table identifier");

    await expect(callback({
      action: "create_table_rls",
      ref: "proj",
      table: "todos",
      columns: "id uuid); DROP TABLE secrets; --",
    })).rejects.toThrow("Unsafe column definitions");
  });
});
