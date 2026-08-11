import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));
const CONTEXT_KEYS = new Set([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "SUPACLOUD_ENV",
    "SUPACLOUD_READ_ONLY",
]);
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

interface MigrationRow {
    version: string;
    name: string | null;
    statements: string[];
    statement_count: number;
    checksum: string;
    applied_at: string | null;
}

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

function cliEnvironment(overrides: Record<string, string>): Record<string, string> {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key, value]) => value !== undefined && !CONTEXT_KEYS.has(key)),
    ) as Record<string, string>;
    return { ...environment, ...overrides };
}

async function runCli(args: string[], environment: Record<string, string>) {
    const argv = [process.execPath, CLI_ENTRYPOINT, ...args];
    const child = Bun.spawn(argv, {
        cwd: PACKAGE_ROOT,
        env: cliEnvironment(environment),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { argv, exitCode, stdout, stderr };
}

function migrationRow(input: {
    version: string;
    name: string | null;
    statements: string[];
    appliedAt: string | null;
}): MigrationRow {
    const checksum = createHash("sha256").update(JSON.stringify({
        version: input.version,
        name: input.name,
        statements: input.statements,
    })).digest("hex");
    return {
        version: input.version,
        name: input.name,
        statements: input.statements,
        statement_count: input.statements.length,
        checksum,
        applied_at: input.appliedAt,
    };
}

function projectEnvironment(port: number | undefined, token: string): Record<string, string> {
    if (port === undefined) throw new Error("Test server did not bind a port");
    return {
        SUPACLOUD_API_URL: `http://127.0.0.1:${port}`,
        SUPACLOUD_API_TOKEN: token,
        SUPACLOUD_PROJECT_REF: "project-a",
    };
}

describe("migration inventory CLI process contract", () => {
    test("prints only sorted inventory JSON and keeps the token out of argv and output", async () => {
        const token = "migration-inventory-token-sentinel";
        const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
        const later = {
            ...migrationRow({ version: "9007199254740993001", name: "later", statements: ["SELECT 2;"], appliedAt: null }),
            reflected_token: token,
        };
        const earlier = migrationRow({
            version: "2",
            name: null,
            statements: ["SELECT 1;"],
            appliedAt: "2026-08-11 09:00:00+00",
        });
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requests.push({
                    method: request.method,
                    path: new URL(request.url).pathname,
                    authorization: request.headers.get("authorization"),
                });
                return Response.json([later, earlier]);
            },
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory", "--ref", "project-a"],
            projectEnvironment(server.port, token),
        );
        const inventory = JSON.parse(response.stdout);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toBe("");
        expect(inventory.map((entry: MigrationRow) => entry.version)).toEqual(["2", "9007199254740993001"]);
        expect(inventory[1]).not.toHaveProperty("reflected_token");
        expect(requests).toEqual([{
            method: "GET",
            path: "/v1/projects/project-a/database/migrations",
            authorization: `Bearer ${token}`,
        }]);
        expect(response.argv.join(" ")).not.toContain(token);
        expect(response.stdout + response.stderr).not.toContain(token);
    });

    test("prints an empty JSON array for a valid empty ledger", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json([]),
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory"],
            projectEnvironment(server.port, "empty-ledger-token"),
        );

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toEqual([]);
        expect(response.stderr).toBe("");
    });

    test("keeps the migration ledger endpoint readable in read-only mode", async () => {
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requests.push(`${request.method} ${new URL(request.url).pathname}`);
                return Response.json([]);
            },
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory"],
            { ...projectEnvironment(server.port, "read-only-token"), SUPACLOUD_READ_ONLY: "true" },
        );

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toEqual([]);
        expect(requests).toEqual(["GET /v1/projects/project-a/database/migrations"]);
    });

    test.each([".", "..", "project.name", "project/other", "project?other", "project#other", "%2e"])("rejects unsafe ref %s without dispatching or reflecting secrets", async (ref) => {
        const token = "unsafe-ref-token-sentinel";
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json([]);
            },
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory", "--ref", ref],
            projectEnvironment(server.port, token),
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stdout + response.stderr).toContain("invalid for migration_inventory");
        expect(response.stdout + response.stderr).not.toContain(token);
        expect(response.stdout + response.stderr).not.toContain(ref);
    });

    test.each([409, 503])("exits non-zero for HTTP %d without reflecting the response", async (status) => {
        const token = `http-${status}-token-sentinel`;
        const responseSecret = `http-${status}-response-sentinel`;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json({ message: responseSecret }, { status }),
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory"],
            projectEnvironment(server.port, token),
        );

        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout).error).toEqual({ code: "HTTP_ERROR", http_status: status });
        expect(response.stdout + response.stderr).not.toContain(token);
        expect(response.stdout + response.stderr).not.toContain(responseSecret);
    });

    test.each([
        ["non-array", { rows: [] }],
        ["count mismatch", [{ ...migrationRow({
            version: "1",
            name: "one",
            statements: ["SELECT 1;"],
            appliedAt: null,
        }), statement_count: 2 }]],
        ["duplicate canonical version", (() => {
            const row = migrationRow({ version: "1", name: "one", statements: ["SELECT 1;"], appliedAt: null });
            return [row, migrationRow({ version: "1", name: "one-renamed", statements: ["SELECT 2;"], appliedAt: null })];
        })()],
    ])("exits non-zero for a %s success payload", async (_label, payload) => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json(payload),
        });
        servers.push(server);

        const response = await runCli(
            ["database", "migration_inventory"],
            projectEnvironment(server.port, "invalid-shape-token"),
        );

        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout).error).toEqual({ code: "INVALID_RESPONSE", http_status: 200 });
    });

    test("lists the new read-only action in command help", async () => {
        const response = await runCli(
            ["database", "--help"],
            projectEnvironment(1, "help-token"),
        );

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("migration_inventory");
        expect(response.stdout + response.stderr).not.toContain("help-token");
    });
});
