import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTEXT_KEYS = new Set([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
]);

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function cleanEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !CONTEXT_KEYS.has(key)) env[key] = value;
    }
    return { ...env, ...overrides };
}

async function runProjectCli(
    args: string[],
    overrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const processHandle = Bun.spawn([process.execPath, "src/index.ts", ...args], {
        cwd: PACKAGE_ROOT,
        env: cleanEnvironment(overrides),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

describe("supacloud-cli process contract", () => {
    test("shows branch action flags even before project context is configured", async () => {
        const result = await runProjectCli(["branch", "promotion_plan", "--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("--branch_ref");
        expect(result.stderr).toContain("--ref");
    });

    test("shows and dry-runs the bundled AI skill without project credentials", async () => {
        const targetRoot = mkdtempSync(join(tmpdir(), "supacloud-cli-ai-target-"));
        temporaryDirectories.push(targetRoot);

        const shown = await runProjectCli(["ai", "show_skill"]);
        const dryRun = await runProjectCli([
            "ai", "install_skill", "--target", targetRoot, "--dry_run",
        ]);
        const shownSkill = JSON.parse(shown.stdout);
        const dryRunSummary = JSON.parse(dryRun.stdout);

        expect(shown.exitCode).toBe(0);
        expect(shownSkill.name).toBe("supacloud-cli");
        expect(shownSkill.sourceDirectory).toEndWith(join("packages", "cli", "skills", "supacloud-cli"));
        expect(dryRun.exitCode).toBe(0);
        expect(dryRunSummary.action).toBe("create");
        expect(dryRunSummary.mode).toBe("dry-run");
        expect(existsSync(join(targetRoot, "supacloud-cli"))).toBe(false);
    }, 15_000);

    test("returns a non-zero exit code when a project command has no context", async () => {
        const result = await runProjectCli(["project", "get"]);

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain("project-scoped API context");
    });

    test.each([
        ["separate flag value", ["--log_type", "database"]],
        ["equals flag value", ["--log_type=database"]],
    ])("accepts %s syntax", async (_label, flagArgs) => {
        let requestedUrl = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedUrl = request.url;
                return Response.json([]);
            },
        });
        servers.push(server);

        const result = await runProjectCli(
            ["project", "logs", ...flagArgs],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(result.exitCode).toBe(0);
        expect(requestedUrl).toContain("/v1/projects/abc123/logs?");
        expect(requestedUrl).toContain("service=database");
    });

    test("status reports missing configuration and exits non-zero", async () => {
        const result = await runProjectCli(["status"]);
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.checks.configuration.ok).toBe(false);
        expect(status.checks.configuration.missing).toContain("apiUrl");
        expect(status.checks.connectivity.ok).toBeNull();
        expect(status.checks.authentication.ok).toBeNull();
    });

    test.each([
        ["valid credentials", 200, true, 0],
        ["rejected credentials", 401, false, 1],
    ])("status distinguishes connectivity and authentication for %s", async (_label, authStatus, authenticated, exitCode) => {
        const requestedPaths: string[] = [];
        const authorizationHeaders: Array<string | null> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requestedPaths.push(path);
                authorizationHeaders.push(request.headers.get("authorization"));
                if (path === "/health") return Response.json({ status: "ok" });
                return Response.json(
                    authStatus === 200 ? { status: "healthy" } : { error: "Invalid token" },
                    { status: authStatus },
                );
            },
        });
        servers.push(server);

        const result = await runProjectCli(["status"], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(exitCode);
        expect(status.checks.configuration.ok).toBe(true);
        expect(status.checks.connectivity.ok).toBe(true);
        expect(status.checks.authentication.ok).toBe(authenticated);
        expect(requestedPaths).toEqual(["/health", "/v1/projects/abc123/health"]);
        expect(authorizationHeaders).toEqual([null, "Bearer test-token"]);
    });

    test("status reports an unreachable Management API without attempting authentication", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json({ status: "ok" }),
        });
        const port = server.port;
        server.stop(true);

        const result = await runProjectCli(["status"], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.checks.connectivity.reachable).toBe(false);
        expect(status.checks.connectivity.error).toBe("unreachable");
        expect(status.checks.authentication.ok).toBeNull();
    });
});
