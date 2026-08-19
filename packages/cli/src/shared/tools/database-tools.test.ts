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
    const releaseMutationHttp = {
        ...http,
        postReleaseMutation: http.postReleaseMutation ?? http.post,
    };
    let callback: ((args: Record<string, unknown>) => Promise<CapturedDatabaseToolResponse>) | undefined;
    registerDatabaseTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name !== "database") return;
            callback = toolCallback;
        },
    }, releaseMutationHttp as any, { projectRef });

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

function migrationMutationReceipt(name: string, sql: string, version = "20260425123000") {
    const statements = [sql.trim()];
    const normalizedStatements = [sql.replace(/\r\n?/g, "\n").trim()];
    return {
        version,
        name,
        statements,
        checksum: createHash("sha256").update(JSON.stringify({ version, name, statements: normalizedStatements })).digest("hex"),
    };
}

function baselineMutationReceipt(migrations: Array<{ version: string; name: string }>) {
    return {
        marked: migrations.length,
        already_applied: 0,
        migrations: migrations.map(({ version, name }) => {
            const statements = [`baseline:${name}`];
            return {
                version,
                name,
                checksum: createHash("sha256").update(JSON.stringify({ version, name, statements })).digest("hex"),
            };
        }),
    };
}

function baselineInventory(migrations: Array<{ version: string; name: string }>) {
    return migrations.map(({ version, name }) => migrationInventoryFixture({
        version,
        name,
        statements: [`baseline:${name}`],
    }));
}

function sqlBatchReceipt(commands: string[]) {
    return {
        command: "BATCH",
        statements: commands.map((command, index) => ({ index: index + 1, command, rowCount: 0, durationMs: 1 })),
    };
}

describe("database migration helpers", () => {
    test.each([
        ["apply_migration", { action: "apply_migration", ref: "proj", name: "safe_name", sql: "SELECT 1;" }],
        ["create_table_rls", {
            action: "create_table_rls",
            ref: "proj",
            table: "safe_table",
            columns: "id uuid primary key",
        }],
    ])("returns a secret-free release-control failure for %s", async (operation, arguments_) => {
        const responseSecret = `${operation}-response-secret`;
        const callback = captureDatabaseTool({
            post: async () => {
                throw new Error("database mutation used the ordinary POST reader");
            },
            postReleaseMutation: async () => ({
                ok: false,
                status: 503,
                data: { message: responseSecret },
            }),
        });

        const response = await callback(arguments_);

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: `database.${operation}`,
            error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
        });
        expect(response.content[0].text).not.toContain(responseSecret);
    });

    test.each([
        ["apply_migration", { action: "apply_migration", ref: "proj", name: "safe_name", sql: "SELECT 1;" }],
        ["create_table_rls", {
            action: "create_table_rls",
            ref: "proj",
            table: "safe_table",
            columns: "id uuid primary key",
        }],
    ])("treats an unreadable %s response as outcome unknown", async (operation, arguments_) => {
        const responseSecret = `${operation}-unreadable-response-secret`;
        const callback = captureDatabaseTool({
            post: async () => {
                throw new Error("database mutation used the ordinary POST reader");
            },
            postReleaseMutation: async () => ({
                ok: false,
                status: 409,
                data: { message: responseSecret },
                responseReadError: true,
            }),
        });

        const response = await callback(arguments_);

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: `database.${operation}`,
            error: { code: "OUTCOME_UNKNOWN", http_status: 409 },
        });
        expect(response.content[0].text).not.toContain(responseSecret);
    });

    test("accepts only a migration receipt bound to the direct-apply request", async () => {
        const callback = captureDatabaseTool({
            postReleaseMutation: async () => ({
                ok: true,
                status: 200,
                data: migrationMutationReceipt("safe_name", "SELECT 1;", "1770000000"),
            }),
        });

        const response = await callback({ action: "apply_migration", ref: "proj", name: "safe_name", sql: "SELECT 1;" });

        expect(response.isError).toBeUndefined();
        expect(response.content[0].text).toContain("Migration 'safe_name' applied");
    });

    test("accepts a direct-apply receipt normalized from CRLF input", async () => {
        const sql = "CREATE TABLE safe_table (\r\n  id uuid\r\n);\r\n";
        const callback = captureDatabaseTool({
            postReleaseMutation: async () => ({
                ok: true,
                status: 200,
                data: migrationMutationReceipt("safe_name", sql, "1770000000"),
            }),
        });

        const response = await callback({ action: "apply_migration", ref: "proj", name: "safe_name", sql });

        expect(response.isError).toBeUndefined();
        expect(response.content[0].text).toContain("Migration 'safe_name' applied");
    });

    test.each([null, {}, { version: "1770000000", name: "other", statements: ["SELECT 1;"] }])(
        "fails a malformed direct-apply success closed",
        async (receiptPayload) => {
            const callback = captureDatabaseTool({
                postReleaseMutation: async () => ({ ok: true, status: 200, data: receiptPayload }),
            });

            const response = await callback({ action: "apply_migration", ref: "proj", name: "safe_name", sql: "SELECT 1;" });
            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
        },
    );

    test.each([201, 202, 204])("does not treat HTTP %d as a completed direct apply", async (status) => {
        const callback = captureDatabaseTool({
            postReleaseMutation: async () => ({
                ok: true,
                status,
                data: migrationMutationReceipt("safe_name", "SELECT 1;", "1770000000"),
            }),
        });

        const response = await callback({ action: "apply_migration", ref: "proj", name: "safe_name", sql: "SELECT 1;" });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
    });

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

    test.each([".", "..", "project.name", "project/other", "project?other", "project#other", "%2e"])("rejects migration inventory ref %s before HTTP dispatch", async (ref) => {
        let requestCount = 0;
        const callback = captureDatabaseTool({
            get: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: [] };
            },
        });

        await expect(callback({ action: "migration_inventory", ref })).rejects.toThrow("invalid for migration_inventory");
        expect(requestCount).toBe(0);
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
        ["duplicate canonical version", (() => {
            const entry = migrationInventoryFixture();
            return [entry, migrationInventoryFixture({ version: entry.version, name: "same-version-different-name" })];
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
                postReleaseMutation: async (_path: string, body: { name: string; version: string; sql: string }) => {
                    posts.push({ name: body.name, version: body.version });
                    return {
                        ok: true,
                        status: 200,
                        data: migrationMutationReceipt(body.name, body.sql, body.version),
                    };
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

    test("rejects an exact remote identity without content evidence", async () => {
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

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Migration identity conflicts");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects migration identity conflicts before dry-run or apply", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const postedNames: string[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        { version: "1785220280", name: "20260425123000_create_users" },
                        { version: "20260425124000", name: "20260425124000_renamed_tasks" },
                    ],
                }),
                post: async (_path: string, body: { name: string }) => {
                    postedNames.push(body.name);
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Migration identity conflicts");
            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("20260425123000_create_users.sql (20260425123000) conflicts with remote");
            expect(postedNames).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("accepts only content-bound legacy versions and skips them without a write", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const migrationName = "20260425123000_create_users";
        const migrationSql = "CREATE TABLE users (id uuid);\n";
        const postedNames: string[] = [];
        try {
            writeFileSync(join(dir, `${migrationName}.sql`), migrationSql);
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{
                        version: "1785220280",
                        name: migrationName,
                        statements: [`\n${migrationSql.trim()}\n`],
                    }],
                }),
                post: async (_path: string, body: { name: string }) => {
                    postedNames.push(body.name);
                    return { ok: true, status: 200, data: {} };
                },
            });

            const dryRun = await callback({ action: "push_migrations", ref: "proj", dir, dry_run: true });
            expect(dryRun.content[0].text).toContain(`Already applied:\n  - ${migrationName}.sql`);

            const apply = await callback({ action: "push_migrations", ref: "proj", dir });
            expect(apply.content[0].text).toContain("Applied: 0");
            expect(apply.content[0].text).toContain("Skipped: 1");
            expect(postedNames).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([
        ["non-string name", { version: "1785220280", name: {}, statements: ["CREATE TABLE users (id uuid);"] }],
        ["non-string version", { version: {}, name: "20260425123000_create_users", statements: ["CREATE TABLE users (id uuid);"] }],
    ])("rejects a %s before dry-run or apply without writing", async (_case, remoteMigration) => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: unknown[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [remoteMigration] }),
                post: async (_path: string, body: unknown) => {
                    posts.push(body);
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Invalid remote migration identity");
            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("Invalid remote migration identity");
            expect(posts).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects same-version SQL drift before dry-run or apply without writing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const secret = "remote-secret-must-not-be-reflected";
        const posts: unknown[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{
                        version: "20260425123000",
                        name: "20260425123000_create_users",
                        statements: [`CREATE TABLE users (id text); -- ${secret}`],
                    }],
                }),
                post: async (_path: string, body: unknown) => {
                    posts.push(body);
                    return { ok: false, status: 409, data: { code: "migration_checksum_conflict" } };
                },
            });

            for (const dryRun of [true, false]) {
                let message = "";
                try {
                    await callback({ action: "push_migrations", ref: "proj", dir, dry_run: dryRun });
                } catch (error) {
                    message = error instanceof Error ? error.message : String(error);
                }
                expect(message).toContain("Migration identity conflicts");
                expect(message).not.toContain(secret);
            }
            expect(posts).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not reflect a remote migration name in identity conflicts", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const remoteName = "sentinel_remote_name_secret";
        const posts: unknown[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{ version: "20260425123000", name: remoteName, statements: ["SELECT 1;"] }],
                }),
                post: async (_path: string, body: unknown) => {
                    posts.push(body);
                    return { ok: true, status: 200, data: {} };
                },
            });

            for (const dryRun of [true, false]) {
                let message = "";
                try {
                    await callback({ action: "push_migrations", ref: "proj", dir, dry_run: dryRun });
                } catch (error) {
                    message = error instanceof Error ? error.message : String(error);
                }
                expect(message).toContain("Migration identity conflicts");
                expect(message).not.toContain(remoteName);
            }
            expect(posts).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([
        [
            "version",
            [
                { version: "1785220280", name: "remote_alpha", statements: ["SELECT 1;"] },
                { version: "1785220280", name: "remote_beta", statements: ["SELECT 2;"] },
            ],
        ],
        [
            "name",
            [
                { version: "1785220280", name: "remote_duplicate", statements: ["SELECT 1;"] },
                { version: "1785220281", name: "remote_duplicate", statements: ["SELECT 2;"] },
            ],
        ],
    ])("rejects a duplicate remote %s before dry-run or apply without writing", async (_case, remoteMigrations) => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: unknown[] = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: remoteMigrations }),
                post: async (_path: string, body: unknown) => {
                    posts.push(body);
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Invalid remote migration inventory");
            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("Invalid remote migration inventory");
            expect(posts).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([
        ["changed content", ["CREATE TABLE users (id text);"]],
        ["multiple statements", ["CREATE TABLE users (id uuid);", "SELECT 1;"]],
        ["missing statements", undefined],
    ])("rejects a legacy migration name with %s", async (_case, statements) => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{
                        version: "1785220280",
                        name: "20260425123000_create_users",
                        statements,
                    }],
                }),
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Migration identity conflicts");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("keeps same-version renamed migrations conflicting even when SQL matches", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{
                        version: "20260425123000",
                        name: "20260425123000_renamed_users",
                        statements: ["CREATE TABLE users (id uuid);"],
                    }],
                }),
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Migration identity conflicts");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects ambiguous duplicate legacy names even when both contents match", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const migrationName = "20260425123000_create_users";
        const migrationSql = "CREATE TABLE users (id uuid);";
        try {
            writeFileSync(join(dir, `${migrationName}.sql`), `${migrationSql}\n`);
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        { version: "1785220280", name: migrationName, statements: [migrationSql] },
                        { version: "1785220281", name: migrationName, statements: [migrationSql] },
                    ],
                }),
            });

            await expect(callback({ action: "push_migrations", ref: "proj", dir, dry_run: true }))
                .rejects.toThrow("Invalid remote migration inventory");
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
                postReleaseMutation: async () => ({
                    ok: false,
                    status: 409,
                    data: {
                        code: "409",
                        message: "Migration already applied",
                        ...migrationMutationReceipt(
                            "20260425123000_create_users",
                            "CREATE TABLE users (id uuid);",
                        ),
                        statements: undefined,
                    },
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

    test("does not skip an unreadable already-applied migration response", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const responseSecret = "already-applied-private-response";
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => ({
                    ok: false,
                    status: 409,
                    data: {
                        code: "409",
                        message: "Migration already applied",
                        ...migrationMutationReceipt(
                            "20260425123000_create_users",
                            "CREATE TABLE users (id uuid);",
                        ),
                        private: responseSecret,
                    },
                    responseReadError: true,
                }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text)).toMatchObject({
                applied_before_failure: [],
                skipped_before_failure: [],
                failed_file: "20260425123000_create_users.sql",
                error: { code: "OUTCOME_UNKNOWN", http_status: 409 },
            });
            expect(response.content[0].text).not.toContain(responseSecret);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not skip a contradictory successful already-applied response", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => ({
                    ok: true,
                    status: 409,
                    data: {
                        code: "409",
                        message: "Migration already applied",
                        ...migrationMutationReceipt(
                            "20260425123000_create_users",
                            "CREATE TABLE users (id uuid);",
                        ),
                    },
                }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text)).toMatchObject({
                applied_before_failure: [],
                skipped_before_failure: [],
                failed_file: "20260425123000_create_users.sql",
                error: { code: "OUTCOME_UNKNOWN", http_status: 409 },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("returns a secret-free explicit rejection for a checksum-conflict response", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => ({
                    ok: false,
                    status: 409,
                    data: {
                        code: "migration_checksum_conflict",
                        message: "Migration conflicts with an existing checksum",
                    },
                }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text)).toEqual({
                schema: "supacloud.cli.release-control.v1",
                ok: false,
                operation: "database.push_migrations",
                applied_before_failure: [],
                skipped_before_failure: [],
                failed_file: "20260425123000_create_users.sql",
                error: { code: "HTTP_ERROR", http_status: 409 },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([
        ["inventory", "get", "HTTP_ERROR", 503],
        ["mutation", "postReleaseMutation", "OUTCOME_UNKNOWN", 503],
    ])("returns a secret-free push %s failure", async (_stage, failedMethod, code, status) => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const responseSecret = `push-${failedMethod}-response-secret`;
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => failedMethod === "get"
                    ? { ok: false, status, data: { token: responseSecret } }
                    : { ok: true, status: 200, data: [] },
                postReleaseMutation: async () => ({
                    ok: false,
                    status,
                    data: { token: responseSecret },
                }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text)).toEqual({
                schema: "supacloud.cli.release-control.v1",
                ok: false,
                operation: "database.push_migrations",
                ...(failedMethod === "postReleaseMutation" ? {
                    applied_before_failure: [],
                    skipped_before_failure: [],
                    failed_file: "20260425123000_create_users.sql",
                } : {}),
                error: { code, http_status: status },
            });
            expect(response.content[0].text).not.toContain(responseSecret);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("uses the bounded release-mutation response path for migration pushes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        let ordinaryPostCount = 0;
        let releaseMutationCount = 0;
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                post: async () => {
                    ordinaryPostCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
                postReleaseMutation: async () => {
                    releaseMutationCount += 1;
                    return {
                        ok: true,
                        status: 200,
                        data: migrationMutationReceipt(
                            "20260425123000_create_users",
                            "CREATE TABLE users (id uuid);",
                        ),
                    };
                },
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).not.toBe(true);
            expect(ordinaryPostCount).toBe(0);
            expect(releaseMutationCount).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reports files committed before a later migration rejection", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            let postCount = 0;
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => {
                    postCount += 1;
                    return postCount === 1
                        ? {
                            ok: true,
                            status: 200,
                            data: migrationMutationReceipt(
                                "20260425123000_create_users",
                                "CREATE TABLE users (id uuid);",
                            ),
                        }
                        : { ok: false, status: 409, data: { message: "private-response" } };
                },
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });
            const payload = JSON.parse(response.content[0].text);

            expect(response.isError).toBe(true);
            expect(payload).toMatchObject({
                applied_before_failure: ["20260425123000_create_users.sql"],
                skipped_before_failure: [],
                failed_file: "20260425124000_create_tasks.sql",
                error: { code: "HTTP_ERROR", http_status: 409 },
            });
            expect(response.content[0].text).not.toContain("private-response");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reports only files encountered before the failed migration", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            writeFileSync(join(dir, "20260425125000_create_reports.sql"), "CREATE TABLE reports (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [
                        {
                            version: "20260425123000",
                            name: "20260425123000_create_users",
                            statements: ["CREATE TABLE users (id uuid);"],
                        },
                        {
                            version: "20260425125000",
                            name: "20260425125000_create_reports",
                            statements: ["CREATE TABLE reports (id uuid);"],
                        },
                    ],
                }),
                postReleaseMutation: async () => ({ ok: false, status: 409, data: {} }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(JSON.parse(response.content[0].text)).toMatchObject({
                applied_before_failure: [],
                skipped_before_failure: ["20260425123000_create_users.sql"],
                failed_file: "20260425124000_create_tasks.sql",
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reports a malformed migration push success as outcome unknown", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => ({ ok: true, status: 200, data: {} }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });
            const payload = JSON.parse(response.content[0].text);

            expect(response.isError).toBe(true);
            expect(payload).toMatchObject({
                applied_before_failure: [],
                skipped_before_failure: [],
                failed_file: "20260425123000_create_users.sql",
                error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.each([201, 202, 204])("does not treat HTTP %d as a completed migration push", async (status) => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({ ok: true, status: 200, data: [] }),
                postReleaseMutation: async () => ({
                    ok: true,
                    status,
                    data: migrationMutationReceipt(
                        "20260425123000_create_users",
                        "CREATE TABLE users (id uuid);",
                    ),
                }),
            });

            const response = await callback({ action: "push_migrations", ref: "proj", dir });

            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("skips exact same-identity SQL without any POST", async () => {
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
                postReleaseMutation: async (path: string, body: unknown) => {
                    posts.push({ path, body });
                    return { ok: true, status: 200, data: {} };
                },
            });

            const result = await callback({ action: "push_migrations", ref: "proj", dir });
            expect(result.content[0].text).toContain("Applied: 0");
            expect(result.content[0].text).toContain("Skipped: 2");
            expect(posts).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects malformed historical direct-apply markers before POST", async () => {
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
                            version: "20260425125099",
                            name: "20260425125099_renamed_reports",
                            statements: ["direct-apply:20260425125099_renamed_reports"],
                        },
                        {
                            version: "20260425126000",
                            name: "20260425126000_create_audits",
                            statements: ["direct-apply:20260425126000_create_audits", "extra"],
                        },
                        {
                            version: "20260425127001",
                            name: "20260425127001_renamed_metrics",
                            statements: ["direct-apply:20260425127001_renamed_metrics"],
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

            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("Migration identity conflicts");
            expect(postedNames).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rejects a mismatched historical sha256 marker before POST", async () => {
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

            await expect(callback({ action: "push_migrations", ref: "proj", dir }))
                .rejects.toThrow("Migration identity conflicts");
            expect(posts).toEqual([]);
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
                        {
                            version: "20260425123000",
                            name: "20260425123000_create_users",
                            statements: ["baseline:20260425123000_create_users"],
                        },
                    ],
                }),
                postReleaseMutation: async (path: string, body: unknown) => {
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

    test("rejects a baseline identity without content evidence before mutation", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        let mutationCount = 0;
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            const callback = captureDatabaseTool({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: [{ version: "20260425123000", name: "20260425123000_create_users" }],
                }),
                postReleaseMutation: async () => {
                    mutationCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({ action: "baseline_migrations", ref: "proj", dir }))
                .rejects.toThrow("Migration identity conflicts");
            expect(mutationCount).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("baselines missing migrations through the dedicated ledger endpoint", async () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
        const posts: Array<{ path: string; body: unknown }> = [];
        try {
            writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
            writeFileSync(join(dir, "20260425124000_create_tasks.sql"), "CREATE TABLE tasks (id uuid);\n");
            const baselines = [
                { name: "20260425123000_create_users", version: "20260425123000" },
                { name: "20260425124000_create_tasks", version: "20260425124000" },
            ];
            let inventoryReadCount = 0;

            const callback = captureDatabaseTool({
                get: async (path: string) => {
                    expect(path).toBe("/v1/projects/proj/database/migrations");
                    inventoryReadCount += 1;
                    return {
                        ok: true,
                        status: 200,
                        data: inventoryReadCount === 1 ? [] : baselineInventory(baselines),
                    };
                },
                postReleaseMutation: async (path: string, body: unknown) => {
                    posts.push({ path, body });
                    return {
                        ok: true,
                        status: 200,
                        data: baselineMutationReceipt(baselines),
                    };
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

  test("accepts a baseline receipt completed concurrently by another caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
    try {
      writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
      let inventoryReadCount = 0;
      const callback = captureDatabaseTool({
        get: async () => {
          inventoryReadCount += 1;
          return {
            ok: true,
            status: 200,
            data: inventoryReadCount === 1
              ? []
              : baselineInventory([{ name: "20260425123000_create_users", version: "20260425123000" }]),
          };
        },
        postReleaseMutation: async () => ({
          ok: true,
          status: 200,
          data: { marked: 0, already_applied: 1, migrations: [] },
        }),
      });

      const response = await callback({ action: "baseline_migrations", ref: "proj", dir });

      expect(response.isError).toBeUndefined();
      expect(response.content[0].text).toContain("Migration baseline completed");
      expect(response.content[0].text).toContain("Marked applied: 0");
      expect(response.content[0].text).toContain("Already applied: 1");
      expect(response.content[0].text).not.toContain("Marked files:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { marked: 1 },
    { marked: 0, already_applied: 0, migrations: [] },
    { marked: 0, already_applied: 2, migrations: [] },
    { marked: 1, already_applied: 0, migrations: [] },
  ])("fails a malformed successful migration baseline closed", async (receiptPayload) => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
    try {
      writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
        postReleaseMutation: async () => ({ ok: true, status: 200, data: receiptPayload }),
      });

      const response = await callback({ action: "baseline_migrations", ref: "proj", dir });
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([201, 202, 204])("does not treat HTTP %d as a completed baseline", async (status) => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
    try {
      writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
        postReleaseMutation: async () => ({
          ok: true,
          status,
          data: baselineMutationReceipt([
            { name: "20260425123000_create_users", version: "20260425123000" },
          ]),
        }),
      });

      const response = await callback({ action: "baseline_migrations", ref: "proj", dir });

      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["HTTP failure", { ok: false, status: 503, data: { private: "inventory-secret" } }],
    ["identity mismatch", {
      ok: true,
      status: 200,
      data: baselineInventory([{ name: "wrong_name", version: "20260425123000" }]),
    }],
  ])("fails a successful baseline closed when readback has %s", async (_case, readbackResponse) => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
    try {
      writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
      let inventoryReadCount = 0;
      const callback = captureDatabaseTool({
        get: async () => {
          inventoryReadCount += 1;
          return inventoryReadCount === 1
            ? { ok: true, status: 200, data: [] }
            : readbackResponse;
        },
        postReleaseMutation: async () => ({
          ok: true,
          status: 200,
          data: baselineMutationReceipt([
            { name: "20260425123000_create_users", version: "20260425123000" },
          ]),
        }),
      });

      const response = await callback({ action: "baseline_migrations", ref: "proj", dir });

      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text).error.code).toBe("OUTCOME_UNKNOWN");
      expect(response.content[0].text).not.toContain("inventory-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["inventory", "get", "HTTP_ERROR", 409],
    ["mutation", "postReleaseMutation", "OUTCOME_UNKNOWN", 503],
  ])("returns a secret-free baseline %s failure", async (_stage, failedMethod, code, status) => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-migrations-"));
    const responseSecret = `baseline-${failedMethod}-response-secret`;
    try {
      writeFileSync(join(dir, "20260425123000_create_users.sql"), "CREATE TABLE users (id uuid);\n");
      const callback = captureDatabaseTool({
        get: async () => failedMethod === "get"
          ? { ok: false, status, data: { message: responseSecret } }
          : { ok: true, status: 200, data: [] },
        postReleaseMutation: async () => ({ ok: false, status, data: { message: responseSecret } }),
      });

      const response = await callback({ action: "baseline_migrations", ref: "proj", dir });

      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        schema: "supacloud.cli.release-control.v1",
        ok: false,
        operation: "database.baseline_migrations",
        error: { code, http_status: status },
      });
      expect(response.content[0].text).not.toContain(responseSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create_table_rls defaults to deny-all and removes the legacy permissive policy", async () => {
    const posts: Array<{ path: string; body: { sql?: string; mode?: string } }> = [];
    const callback = captureDatabaseTool({
      postReleaseMutation: async (path: string, body: { sql?: string; mode?: string }) => {
        posts.push({ path, body });
        return { ok: true, status: 200, data: sqlBatchReceipt(["CREATE", "ALTER", ...Array(5).fill("DROP")]) };
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
    expect(posts[0]?.body.mode).toBe("migration");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('DROP POLICY IF EXISTS "Enable ALL for authenticated"');
    expect(sql).not.toContain("USING (true)");
    expect(sql).not.toContain("WITH CHECK (true)");
  });

  test("create_table_rls owner mode creates idempotent auth.uid policies", async () => {
    const posts: Array<{ body: { sql?: string } }> = [];
    const callback = captureDatabaseTool({
      postReleaseMutation: async (_path: string, body: { sql?: string }) => {
        posts.push({ body });
        return {
          ok: true,
          status: 200,
          data: sqlBatchReceipt(["CREATE", "ALTER", ...Array(5).fill("DROP"), ...Array(4).fill("CREATE")]),
        };
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

  test("fails a malformed successful table and RLS mutation closed", async () => {
    const callback = captureDatabaseTool({
      postReleaseMutation: async () => ({ ok: true, status: 200, data: { rows: [] } }),
    });

    const response = await callback({
      action: "create_table_rls",
      ref: "proj",
      table: "todos",
      columns: "id uuid primary key",
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
  });

  test.each([201, 202, 204])("does not treat HTTP %d as a completed table and RLS mutation", async (status) => {
    const callback = captureDatabaseTool({
      postReleaseMutation: async () => ({
        ok: true,
        status,
        data: sqlBatchReceipt(["CREATE", "ALTER", ...Array(5).fill("DROP")]),
      }),
    });

    const response = await callback({
      action: "create_table_rls",
      ref: "proj",
      table: "todos",
      columns: "id uuid primary key",
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
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
  test("lint_migrations action inspects SQL files and reports risks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-lint-test-"));
    try {
      writeFileSync(join(dir, "20260819000001_safe.sql"), "CREATE TABLE public.items (id bigint PRIMARY KEY);");
      writeFileSync(join(dir, "20260819000002_lock.sql"), "CREATE INDEX idx_items_id ON public.items (id);");
      writeFileSync(join(dir, "20260819000003_drop.sql"), "DROP TABLE public.legacy_items;");

      const callback = captureDatabaseTool({});
      const result = await callback({
        action: "lint_migrations",
        dir,
      });

      const text = result.content[0].text;
      expect(text).toContain("🔴 Migration Risk Level: HIGH");
      expect(text).toContain("20260819000002_lock.sql");
      expect(text).toContain("20260819000003_drop.sql");
      expect(text).toContain("CREATE INDEX CONCURRENTLY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("push_migrations dry_run includes Risk Assessment section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-dryrun-risk-test-"));
    try {
      writeFileSync(join(dir, "20260819000001_add_index.sql"), "CREATE INDEX idx_users_name ON public.users (name);");

      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
      });

      const result = await callback({
        action: "push_migrations",
        ref: "proj",
        dir,
        dry_run: true,
      });

      const text = result.content[0].text;
      expect(text).toContain("Migration dry run for");
      expect(text).toContain("Risk Assessment:");
      expect(text).toContain("Migration Risk Level: MEDIUM");
      expect(text).toContain("CREATE INDEX CONCURRENTLY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("lint_migrations returns isError in strict mode when high risk detected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-lint-strict-test-"));
    try {
      writeFileSync(join(dir, "20260819000001_drop.sql"), "DROP TABLE public.legacy_users;");

      const callback = captureDatabaseTool({});
      const normalResult = await callback({
        action: "lint_migrations",
        dir,
      });
      expect(normalResult.isError).toBeFalsy();

      const strictResult = await callback({
        action: "lint_migrations",
        dir,
        strict: true,
      });
      expect(strictResult.isError).toBe(true);
      expect(strictResult.content[0].text).toContain("🔴 Migration Risk Level: HIGH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("lint_migrations action supports inline sql and json output", async () => {
    const callback = captureDatabaseTool({});
    const result = await callback({
      action: "lint_migrations",
      sql: "DROP TABLE public.temp_users;",
      json: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.overallRisk).toBe("HIGH");
    expect(parsed.highRiskCount).toBe(1);
    expect(parsed.files[0].file).toBe("inline.sql");
  });

  test("lint_migrations action supports single file and fail_on_medium", async () => {
    const filePath = join(tmpdir(), `supacloud-single-lint-${Date.now()}.sql`);
    try {
      writeFileSync(filePath, "CREATE INDEX idx_items ON public.items (id);");
      const callback = captureDatabaseTool({});

      const normalResult = await callback({
        action: "lint_migrations",
        file: filePath,
      });
      expect(normalResult.isError).toBeFalsy();
      expect(normalResult.content[0].text).toContain("Migration Risk Level: MEDIUM");
      expect(normalResult.content[0].text).toContain(filePath);

      const failResult = await callback({
        action: "lint_migrations",
        file: filePath,
        fail_on_medium: true,
      });
      expect(failResult.isError).toBe(true);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("push_migrations with strict flag aborts when high-risk migrations exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-push-strict-"));
    try {
      writeFileSync(join(dir, "20260819000001_drop.sql"), "DROP TABLE public.critical_data;");
      let postCalled = false;

      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
        postReleaseMutation: async () => {
          postCalled = true;
          return { ok: true, status: 200, data: { name: "drop", version: "1", checksum: "abc" } };
        },
      });

      const result = await callback({
        action: "push_migrations",
        ref: "proj",
        dir,
        strict: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Migration push aborted due to strict risk policy");
      expect(result.content[0].text).toContain("DROP TABLE public.critical_data");
      expect(postCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("push_migrations dry_run returns an error under strict risk policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-push-dryrun-strict-"));
    try {
      writeFileSync(join(dir, "20260819000001_drop.sql"), "DROP TABLE public.critical_data;");
      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
      });

      const result = await callback({
        action: "push_migrations",
        ref: "proj",
        dir,
        dry_run: true,
        strict: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Migration dry run for");
      expect(result.content[0].text).toContain("Migration Risk Level: HIGH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("push_migrations blocks non-transactional SQL before the first mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-push-non-transactional-"));
    let postCalls = 0;
    try {
      writeFileSync(
        join(dir, "20260819000001_concurrent_index.sql"),
        "CREATE INDEX CONCURRENTLY idx_users_email ON public.users(email);",
      );
      const callback = captureDatabaseTool({
        get: async () => ({ ok: true, status: 200, data: [] }),
        postReleaseMutation: async () => {
          postCalls += 1;
          return { ok: true, status: 200, data: {} };
        },
      });

      const result = await callback({ action: "push_migrations", ref: "proj", dir });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("transactional executor cannot run");
      expect(result.content[0].text).toContain("CREATE INDEX CONCURRENTLY");
      expect(postCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lint_migrations rejects ambiguous input sources", async () => {
    const callback = captureDatabaseTool({});

    await expect(callback({
      action: "lint_migrations",
      sql: "SELECT 1;",
      file: "migration.sql",
    })).rejects.toThrow("Use only one of --sql, --file, or --dir");
  });
});
