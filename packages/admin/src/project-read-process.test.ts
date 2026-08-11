import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADMIN_ENTRYPOINT = join(PACKAGE_ROOT, "src/index.ts");
const CONTEXT_KEYS = new Set([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_ENV",
]);

const PROJECT_REF = "abcdefghijklmnopqrst";
const PROJECT_SUMMARY = {
    id: "11111111-1111-4111-8111-111111111111",
    ref: PROJECT_REF,
    organization_id: "22222222-2222-4222-8222-222222222222",
    organization_slug: "example-organization",
    name: "Example project",
    region: "local",
    created_at: "2026-08-12T00:00:00.000Z",
    status: "ACTIVE_HEALTHY",
};
const PROJECT_DETAILS = {
    ...PROJECT_SUMMARY,
    database: {
        host: "db.example.test",
        version: "17.5",
        postgres_engine: "17",
        release_channel: "stable",
    },
    api: { url: "https://api.example.test" },
    studio: { url: "https://studio.example.test" },
};

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});
function cleanEnvironment(overrides: Record<string, string>): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !CONTEXT_KEYS.has(key)) environment[key] = value;
    }
    return { ...environment, ...overrides };
}

async function runAdminProjectRead(
    args: string[],
    response: Response,
): Promise<{ exitCode: number; output: string }> {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => response.clone(),
    });
    servers.push(server);
    const apiToken = "admin-process-api-token-sentinel";
    const processHandle = Bun.spawn([process.execPath, ADMIN_ENTRYPOINT, ...args], {
        cwd: PACKAGE_ROOT,
        env: cleanEnvironment({
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: apiToken,
        }),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
    ]);
    const output = stdout + stderr;
    expect(output).not.toContain(apiToken);
    return { exitCode, output };
}

describe("supacloud-admin project read process contract", () => {
    test("prints only the fixed list and get projections for current Management responses", async () => {
        const remoteSecret = "admin-known-private-sentinel";
        const listRead = await runAdminProjectRead(
            ["project", "list"],
            Response.json([PROJECT_SUMMARY]),
        );
        const getRead = await runAdminProjectRead(
            ["project", "get", "--ref", PROJECT_REF],
            Response.json({
                ...PROJECT_DETAILS,
                config: { private_runtime_value: remoteSecret },
                anon_key: remoteSecret,
                services: [{ token: remoteSecret }],
            }),
        );

        expect(listRead.exitCode).toBe(0);
        expect(JSON.parse(listRead.output)).toEqual([PROJECT_SUMMARY]);
        expect(getRead.exitCode).toBe(0);
        expect(JSON.parse(getRead.output)).toEqual(PROJECT_DETAILS);
        expect(listRead.output + getRead.output).not.toContain(remoteSecret);
    });

    test.each([
        [
            "HTTP failure",
            ["project", "list"],
            Response.json({ error: "admin-http-private-sentinel" }, { status: 404 }),
            "Project list request failed (404)",
            "admin-http-private-sentinel",
        ],
        [
            "unknown list field",
            ["project", "list"],
            Response.json([{ ...PROJECT_SUMMARY, service_role_key: "admin-list-private-sentinel" }]),
            "Invalid project list response",
            "admin-list-private-sentinel",
        ],
        [
            "nested database credential",
            ["project", "get", "--ref", PROJECT_REF],
            Response.json({
                ...PROJECT_DETAILS,
                database: { ...PROJECT_DETAILS.database, password: "admin-database-private-sentinel" },
            }),
            "Invalid project response",
            "admin-database-private-sentinel",
        ],
        [
            "oversized known field",
            ["project", "get", "--ref", PROJECT_REF],
            Response.json({
                ...PROJECT_DETAILS,
                config: { private_value: "admin-oversized-private-sentinel".repeat(50_000) },
            }),
            "Invalid project response",
            "admin-oversized-private-sentinel",
        ],
    ] as const)("exits non-zero for %s without reflecting the response", async (
        _label,
        args,
        response,
        expectedMessage,
        sentinel,
    ) => {
        const execution = await runAdminProjectRead([...args], response);

        expect(execution.exitCode).toBe(1);
        expect(execution.output).toContain(expectedMessage);
        expect(execution.output).not.toContain(sentinel);
    });
});
