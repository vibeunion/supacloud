import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTEXT_KEYS = new Set([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "SUPACLOUD_READ_ONLY",
    "SUPACLOUD_SUPABASE_CLI_BIN",
    "SUPABASE_CLI_VERSION",
    "DATABASE_URL",
    "PGPASSWORD",
]);

function cleanEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !CONTEXT_KEYS.has(key)) environment[key] = value;
    }
    return { ...environment, ...overrides };
}

async function runCli(args: string[], environment: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, "src/index.ts", ...args], {
        cwd: PACKAGE_ROOT,
        env: cleanEnvironment(environment),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

describe("supacloud-cli official Supabase CLI surface", () => {
    test("shows action help when the command group is invoked without an action", async () => {
        const result = await runCli(["supabase"]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Available actions");
        expect(result.stderr).toContain("migration_new");
        expect(result.stderr).toContain("db_dump");
    });

    test("preserves existing context guidance for other command groups", async () => {
        const result = await runCli(["database"]);

        expect(result.stdout + result.stderr).toContain("Management API context");
        expect(result.stdout + result.stderr).not.toContain("Available actions");
    });

    test("runs local official CLI actions without SupaCloud project credentials", async () => {
        const result = await runCli(["supabase", "version"], {
            SUPACLOUD_SUPABASE_CLI_BIN: process.execPath,
            SUPABASE_SERVICE_ROLE_KEY: "must-not-reach-child",
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(Bun.version);
        expect(result.stdout + result.stderr).not.toContain("must-not-reach-child");
    });

    test("requires Management API context for remote migration push", async () => {
        const result = await runCli(["supabase", "push", "--dry_run"]);

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain("Management API");
        expect(result.stdout + result.stderr).toContain("SUPACLOUD_API_TOKEN");
        expect(result.stdout + result.stderr).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    });

    test("uses the Management token only on the SupaCloud migration API path", async () => {
        const migrationDir = mkdtempSync(join(tmpdir(), "supacloud-cli-migrations-"));
        const migrationFile = "20260718090000_create_adapter_test.sql";
        writeFileSync(join(migrationDir, migrationFile), "create table adapter_test(id bigint primary key);\n");

        let authorization: string | null = null;
        let requestedPath = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                authorization = request.headers.get("authorization");
                requestedPath = new URL(request.url).pathname;
                return Response.json([]);
            },
        });

        try {
            const result = await runCli(
                ["supabase", "push", "--dir", migrationDir, "--dry_run"],
                {
                    SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                    SUPACLOUD_API_TOKEN: "management-api-token",
                    SUPACLOUD_PROJECT_REF: "project-a",
                    SUPACLOUD_SUPABASE_CLI_BIN: "/must/not/run",
                },
            );

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(migrationFile);
            expect(requestedPath).toBe("/v1/projects/project-a/database/migrations");
            expect(authorization as string | null).toBe("Bearer management-api-token");
            expect(result.stdout + result.stderr).not.toContain("management-api-token");
        } finally {
            server.stop(true);
            rmSync(migrationDir, { recursive: true, force: true });
        }
    });

    test("does not call the migration API when project context is read-only", async () => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json([]);
            },
        });

        try {
            const result = await runCli(["supabase", "push"], {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "management-api-token",
                SUPACLOUD_PROJECT_REF: "project-a",
                SUPACLOUD_READ_ONLY: "true",
            });

            expect(result.exitCode).toBe(1);
            expect(result.stdout + result.stderr).toContain("read-only");
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
        }
    });

    test("fails before API dispatch when a custom project context has no project ref", async () => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json([]);
            },
        });

        try {
            const result = await runCli(["supabase", "push"], {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "management-api-token",
            });

            expect(result.exitCode).toBe(1);
            expect(result.stdout + result.stderr).toContain("project ref");
            expect(result.stdout + result.stderr).toContain("--ref");
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
        }
    });
});
