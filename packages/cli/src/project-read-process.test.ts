import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRYPOINT = join(PACKAGE_ROOT, "src/index.ts");
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
const PROJECT_DETAILS = {
    id: "11111111-1111-4111-8111-111111111111",
    ref: PROJECT_REF,
    organization_id: "22222222-2222-4222-8222-222222222222",
    organization_slug: "example-organization",
    name: "Example project",
    region: "local",
    created_at: "2026-08-12T00:00:00.000Z",
    status: "ACTIVE_HEALTHY",
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

async function runUserProjectGet(response: Response): Promise<{ exitCode: number; output: string }> {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => response.clone(),
    });
    servers.push(server);
    const apiToken = "user-process-api-token-sentinel";
    const processHandle = Bun.spawn([process.execPath, CLI_ENTRYPOINT, "project", "get"], {
        cwd: PACKAGE_ROOT,
        env: cleanEnvironment({
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: apiToken,
            SUPACLOUD_PROJECT_REF: PROJECT_REF,
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

describe("supacloud-cli project get process contract", () => {
    test("prints only the fixed projection for the current Management response", async () => {
        const remoteSecret = "user-known-private-sentinel";
        const execution = await runUserProjectGet(Response.json({
            ...PROJECT_DETAILS,
            config: { private_runtime_value: remoteSecret },
            anon_key: remoteSecret,
            services: [{ token: remoteSecret }],
        }));

        expect(execution.exitCode).toBe(0);
        expect(JSON.parse(execution.output)).toEqual(PROJECT_DETAILS);
        expect(execution.output).not.toContain(remoteSecret);
    });

    test.each([
        [
            "HTTP failure",
            Response.json({ error: "user-http-private-sentinel" }, { status: 404 }),
            "Project get request failed (404)",
            "user-http-private-sentinel",
        ],
        [
            "unknown nested credential",
            Response.json({
                ...PROJECT_DETAILS,
                studio: { ...PROJECT_DETAILS.studio, token: "user-studio-private-sentinel" },
            }),
            "Invalid project response",
            "user-studio-private-sentinel",
        ],
        [
            "cross-project response",
            Response.json({
                ...PROJECT_DETAILS,
                ref: "different-project",
                config: { private_value: "user-cross-project-private-sentinel" },
            }),
            "Invalid project response",
            "user-cross-project-private-sentinel",
        ],
        [
            "oversized known field",
            Response.json({
                ...PROJECT_DETAILS,
                config: { private_value: "user-oversized-private-sentinel".repeat(50_000) },
            }),
            "Invalid project response",
            "user-oversized-private-sentinel",
        ],
    ] as const)("exits non-zero for %s without reflecting the response", async (
        _label,
        response,
        expectedMessage,
        sentinel,
    ) => {
        const execution = await runUserProjectGet(response);

        expect(execution.exitCode).toBe(1);
        expect(execution.output).toContain(expectedMessage);
        expect(execution.output).not.toContain(sentinel);
    });
});
