import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationVersionFromFilename, registerDatabaseTools, vectorWarningsForPendingMigrations } from "./database-tools";

interface CapturedDatabaseToolResponse {
    content: Array<{ text: string }>;
    isError?: boolean;
}

function captureDatabaseTool(http: Record<string, unknown>, projectRef?: string) {
    let callback: ((args: Record<string, unknown>) => Promise<CapturedDatabaseToolResponse>) | undefined;
    registerDatabaseTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name !== "database") return;
            callback = toolCallback;
        },
    }, http as any, { projectRef });

    if (!callback) throw new Error("database tool was not registered");
    return callback;
}

function migrationInventoryFixture(overrides: Record<string, unknown> = {}) {
    const version = typeof overrides.version === "string" ? overrides.version : "20260811090000";
    const name = overrides.name === undefined ? "20260811090000_create_inventory" : overrides.name;
    const statements = Array.isArray(overrides.statements) ? overrides.statements : ["SELECT 1;"];
    const checksum = createHash("sha256").update(JSON.stringify({ version, name, statements })).digest("hex");
    return {
        version,
        name,
        statements,
        statement_count: statements.length,
        checksum,
        applied_at: "2026-08-11 09:00:00+00",
        ...overrides,
    };
}

describe("database migration helpers", () => {
    test("prefers an explicit ref over the auto-linked project", async () => {
        const calls: string[] = [];
        const callback = captureDatabaseTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: {} };
            },
        }, "default-ref");

        await callback({ action: "project_url", ref: "override-ref" });

        expect(calls).toEqual(["/v1/projects/override-ref"]);
    });

    test("returns a validated, projected, numerically sorted migration inventory", async () => {
        const requests: Array<{ path: string; maxResponseBytes?: number }> = [];
        const later = migrationInventoryFixture({
            version: "9007199254740993001",
            name: "later",
            applied_at: null,
            response_secret: "must-not-be-projected",
        });
        const earlier = migrationInventoryFixture({ version: "10", name: null });
        const callback = captureDatabaseTool({
            get: async (path: string, options: { maxResponseBytes?: number }) => {
                requests.push({ path, maxResponseBytes: options.maxResponseBytes });
                return { ok: true, status: 200, data: [later, earlier] };
            },
        });

        const response = await callback({ action: "migration_inventory", ref: "proj" });
        const inventory = JSON.parse(response.content[0].text);

        expect(response.isError).toBeUndefined();
        expect(requests).toEqual([{
            path: "/v1/projects/proj/database/migrations",
            maxResponseBytes: 64 * 1024 * 1024,
        }]);
        expect(inventory.map((entry: { version: string }) => entry.version)).toEqual(["10", "9007199254740993001"]);
        expect(inventory[1]).not.toHaveProperty("response_secret");
        expect(Object.keys(inventory[0])).toEqual([
            "version", "name", "statements", "statement_count", "checksum", "applied_at",
        ]);
    });

    test("represents a valid empty migration ledger as a JSON array", async () => {
        const callback = captureDatabaseTool({
            get: async () => ({ ok: true, status: 200, data: [] }),
        });

        const response = await callback({ action: "migration_inventory", ref: "proj" });

        expect(response.isError).toBeUndefined();
        expect(response.content[0].text).toBe("[]");
    });

    test.each([409, 503])("returns a secret-free error for HTTP %d", async (status) => {
        const responseSecret = `migration-inventory-response-${status}`;
        const callback = captureDatabaseTool({
            get: async () => ({
                ok: false,
                status,
                data: { message: responseSecret },
            }),
        });

        const response = await callback({ action: "migration_inventory", ref: "proj" });
        const failure = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(failure).toEqual({
            ok: false,
            operation: "database.migration_inventory",
            error: { code: "HTTP_ERROR", http_status: status },
        });
        expect(response.content[0].text).not.toContain(responseSecret);
    });

    test.each([
        ["non-array top level", { rows: [] }],
        ["non-canonical version", [migrationInventoryFixture({ version: "01" })]],
        ["missing name", [(() => {
            const entry = migrationInventoryFixture();
            delete (entry as Record<string, unknown>).name;
            return entry;
        })()]],
        ["empty name", [migrationInventoryFixture({ name: "" })]],
        ["non-array statements", [{ ...migrationInventoryFixture(), statements: "SELECT 1;" }]],
        ["non-string statement", [{ ...migrationInventoryFixture(), statements: [1], statement_count: 1 }]],
        ["statement count mismatch", [{ ...migrationInventoryFixture(), statement_count: 2 }]],
        ["invalid checksum", [{ ...migrationInventoryFixture(), checksum: "invalid" }]],
        ["semantic checksum mismatch", [{ ...migrationInventoryFixture(), checksum: "0".repeat(64) }]],
        ["invalid applied timestamp", [{ ...migrationInventoryFixture(), applied_at: "not-a-timestamp" }]],
        ["duplicate identity", (() => {
            const entry = migrationInventoryFixture();
            return [entry, { ...entry }];
        })()],
    ])("rejects %s instead of reporting an empty ledger", async (_label, payload) => {
        const callback = captureDatabaseTool({
            get: async () => ({ ok: true, status: 200, data: payload }),
        });

        const response = await callback({ action: "migration_inventory", ref: "proj" });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual({
            ok: false,
            operation: "database.migration_inventory",
            error: { code: "INVALID_RESPONSE", http_status: 200 },
        });
    });

    test("preserves the SQL-backed, human-readable list_migrations behavior", async () => {
        const posts: Array<{ path: string; body: { sql: string } }> = [];
        const callback = captureDatabaseTool({
            get: async () => { throw new Error("list_migrations must not use the inventory endpoint"); },
            post: async (path: string, body: { sql: string }) => {
                posts.push({ path, body });
                return {
                    ok: true,
                    status: 200,
                    data: { rows: [{ version: "20260811090000", applied_at: "2026-08-11" }] },
                };
            },
        });

        const response = await callback({ action: "list_migrations", ref: "proj" });

        expect(posts).toHaveLength(1);
        expect(posts[0].path).toBe("/v1/projects/proj/database/sql");
        expect(posts[0].body.sql).toContain("FROM schema_migrations");
        expect(response.content[0].text).toContain("📝 Migrations:");
    });

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

    test("skips only exact historical direct-apply markers before POST", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const postedNames: string[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            writeFileSync(join(dir, "20260425125000_create_reports.sql"), "CREATE TABLE reports (id uuid);\n");
            writeFileSync(join(dir, "20260425126000_create_audits.sql"), "CREATE TABLE audits (id uuid);\n");
            writeFileSync(join(dir, "20260425127000_create_metrics.sql"), "CREATE TABLE metrics (id uuid);\n");
            writeFileSync(join(dir, "20260425128000_create_events.sql"), "CREATE TABLE events (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        {
                            version: "20260425123000",
                            name: "20260425123000_create_users",
                            statements: ["direct-apply:20260425123000_create_users"],
                        },
                        {
                            version: "20260425124000",
                            name: "20260425124000_create_tasks",
                            statements: ["direct-apply:20260425123000_create_users"],
                        },
                        {
                            version: "20260425125000",
                            name: "20260425125000_renamed_reports",
                            statements: ["direct-apply:20260425125000_renamed_reports"],
                        },
                        {
                            version: "20260425126000",
                            name: "20260425126000_create_audits",
                            statements: ["direct-apply:20260425126000_create_audits", "extra"],
                        },
                        {
                            version: "20260425127001",
                            name: "20260425127000_create_metrics",
                            statements: ["direct-apply:20260425127000_create_metrics"],
                        },
                        {
                            version: "20260425128000",
                            name: "20260425128000_create_events",
                            statements: ["direct-apply:20260425128000_create_events "],
                        },
                    ],
                }),
                post: async (_path: string, body: { name: string }) => {
                    postedNames.push(body.name);
                    return { ok: true, status: 200, data: {} };
                },
            });

            const toolResult = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(toolResult.content[0].text).toContain("Applied: 5");
            expect(toolResult.content[0].text).toContain("Skipped: 1");
            expect(postedNames).toEqual([
                "20260425124000_create_tasks",
                "20260425125000_create_reports",
                "20260425126000_create_audits",
                "20260425127000_create_metrics",
                "20260425128000_create_events",
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("skips only matching historical sha256 markers before POST", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: Array<{ name: string }> = [];
        try {
            const sql = "CREATE TABLE users (id uuid);\n";
            const rawLegacyBytes = new Uint8Array([...new TextEncoder().encode("-- legacy bytes\r\n"), 0xff, 0x0a]);
            writeFileSync(join(dir, "20260425123000_create_users.sql"), sql);
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            writeFileSync(join(dir, "20260425125000_legacy_bytes.sql"), rawLegacyBytes);
            const checksum = createHash("sha256").update(sql).digest("hex");
            const rawChecksum = createHash("sha256").update(rawLegacyBytes).digest("hex");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        {
                            version: "20260425123000",
                            name: "20260425123000_create_users",
                            statements: [`sha256:${checksum}`],
                        },
                        {
                            version: "20260425124000",
                            name: "20260425124000_create_tasks",
                            statements: ["sha256:0000000000000000000000000000000000000000000000000000000000000000"],
                        },
                        {
                            version: "20260425125000",
                            name: "20260425125000_legacy_bytes",
                            statements: [`sha256:${rawChecksum}`],
                        },
                    ],
                }),
                post: async (_path: string, body: { name: string }) => {
                    posts.push({ name: body.name });
                    return { ok: true, status: 200, data: {} };
                },
            });

            const toolResult = await callback({ action: "push_migrations", ref: "proj", dir });
            const text = toolResult.content[0].text;

            expect(text).toContain("Applied: 1");
            expect(text).toContain("Skipped: 2");
            expect(posts).toEqual([{ name: "20260425124000_create_tasks" }]);
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

  test("baselines missing migrations through the dedicated ledger endpoint", async () => {
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
                    return { ok: true, status: 200, data: { marked: 2, already_applied: 0 } };
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
            expect(posts[0].path).toBe("/v1/projects/proj/database/migrations/baseline");
            expect(posts[0].body).toEqual({
                migrations: [
                    { name: "20260425123000_create_users", version: "20260425123000" },
                    { name: "20260425124000_create_tasks", version: "20260425124000" },
                ],
            });
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
