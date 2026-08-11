import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliToolResultIsError } from "./shared/cli";

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
const LARGE_FUNCTION_SOURCE = "export const payload = "
    + JSON.stringify("x".repeat(80 * 1024))
    + ";\n";

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

function serveFunctionSource(sourceCode: string): string {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({ code: sourceCode }),
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
}

describe("supacloud-cli process contract", () => {
    test("flushes a Function source response larger than 64 KiB to stdout", async () => {
        const apiUrl = serveFunctionSource(LARGE_FUNCTION_SOURCE);

        const response = await runProjectCli(
            ["edge_functions", "source", "--ref", "abc123", "--slug", "large-function"],
            {
                SUPACLOUD_API_URL: apiUrl,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(response.stdout.length).toBeGreaterThan(64 * 1024);
        expect(JSON.parse(response.stdout)).toEqual({ code: LARGE_FUNCTION_SOURCE });
    });

    test("writes a Function source response larger than 64 KiB without stdout truncation", async () => {
        const outputDirectory = mkdtempSync(join(tmpdir(), "supacloud-cli-source-"));
        temporaryDirectories.push(outputDirectory);
        const outputPath = join(outputDirectory, "large-function.ts");
        const apiUrl = serveFunctionSource(LARGE_FUNCTION_SOURCE);

        const response = await runProjectCli(
            [
                "edge_functions", "source",
                "--ref", "abc123",
                "--slug", "large-function",
                "--output", outputPath,
            ],
            {
                SUPACLOUD_API_URL: apiUrl,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(response.stdout).toContain("source written");
        expect(response.stdout.length).toBeLessThan(1024);
        expect(readFileSync(outputPath, "utf8")).toBe(LARGE_FUNCTION_SOURCE);
    });

    test("does not overwrite an existing Function source output", async () => {
        const outputDirectory = mkdtempSync(join(tmpdir(), "supacloud-cli-source-existing-"));
        temporaryDirectories.push(outputDirectory);
        const outputPath = join(outputDirectory, "existing-function.ts");
        writeFileSync(outputPath, "preserve-existing-source\n");
        const apiUrl = serveFunctionSource(LARGE_FUNCTION_SOURCE);

        const response = await runProjectCli(
            [
                "edge_functions", "source",
                "--ref", "abc123",
                "--slug", "large-function",
                "--output", outputPath,
            ],
            {
                SUPACLOUD_API_URL: apiUrl,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("EEXIST");
        expect(readFileSync(outputPath, "utf8")).toBe("preserve-existing-source\n");
    });

    test("treats failure text as an error even when isError is false", () => {
        expect(cliToolResultIsError({
            isError: false,
            content: [{ type: "text", text: "❌ Failed (400)" }],
        })).toBe(true);
    });

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

    test("does not expose admin project creation through the project CLI", async () => {
        const response = await runProjectCli(
            ["project", "create", "--name", "unauthorized-project", "--domain", "example.com"],
            {
                SUPACLOUD_API_URL: "http://127.0.0.1:1",
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("Invalid arguments");
        expect(response.stderr).toContain("action");
        expect(response.stdout).toBe("");
    });

    test("loads secret values from its environment while argv and output contain names only", async () => {
        const secretName = "FA_CLI_FROM_ENV_PRIMARY";
        const secondSecretName = "FA_CLI_FROM_ENV_SECONDARY";
        const primarySecret = "process-primary-secret-sentinel";
        const secondarySecret = "process-secondary-secret-sentinel";
        let requestBody: unknown;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.json();
                return Response.json({});
            },
        });
        servers.push(server);
        const commandArguments = [
            "secrets", "upsert", "--ref", "abc123",
            "--from-env", `${secretName},${secondSecretName}`,
        ];

        const response = await runProjectCli(commandArguments, {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            [secretName]: primarySecret,
            [secondSecretName]: secondarySecret,
        });

        expect(response.exitCode).toBe(0);
        expect(commandArguments.join("\0")).not.toContain(primarySecret);
        expect(commandArguments.join("\0")).not.toContain(secondarySecret);
        expect(requestBody).toEqual([
            { name: secretName, value: primarySecret },
            { name: secondSecretName, value: secondarySecret },
        ]);
        expect(response.stdout).toContain("Updated 2 secrets");
        expect(response.stdout + response.stderr).not.toContain(primarySecret);
        expect(response.stdout + response.stderr).not.toContain(secondarySecret);
    });

    test.each([
        ["missing value", "FA_CLI_FROM_ENV_MISSING", {}],
        ["empty value", "FA_CLI_FROM_ENV_EMPTY", { FA_CLI_FROM_ENV_EMPTY: "" }],
        ["invalid name", "FA-CLI-INVALID", {}],
        ["duplicate name", "FA_CLI_DUPLICATE,FA_CLI_DUPLICATE", { FA_CLI_DUPLICATE: "never-printed-secret" }],
    ])("rejects from-env %s before HTTP", async (_label, names, secretEnvironment) => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({});
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["secrets", "upsert", "--ref", "abc123", "--from-env", names],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                ...secretEnvironment,
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stdout + response.stderr).not.toContain("never-printed-secret");
    });

    test("rejects mixed secret inputs before HTTP without echoing the inline value", async () => {
        let requestCount = 0;
        const inlineSecret = "mixed-inline-secret-sentinel";
        const environmentSecret = "mixed-environment-secret-sentinel";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({});
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            [
                "secrets", "upsert", "--ref", "abc123",
                "--from-env", "FA_CLI_MIXED_ENV",
                "--secrets", `INLINE_KEY=${inlineSecret}`,
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                FA_CLI_MIXED_ENV: environmentSecret,
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("cannot be combined");
        expect(response.stdout + response.stderr).not.toContain(inlineSecret);
        expect(response.stdout + response.stderr).not.toContain(environmentSecret);
    });

    test("documents the exact kebab-case from-env flag in action help", async () => {
        const response = await runProjectCli(
            ["secrets", "upsert", "--help"],
            {
                SUPACLOUD_API_URL: "http://127.0.0.1:1",
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--from-env");
        expect(response.stderr).not.toContain("--from_env");
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

    test("returns non-zero when an HTTP tool result reports an explicit failure", async () => {
        const migrationRoot = mkdtempSync(join(tmpdir(), "supacloud-cli-baseline-"));
        temporaryDirectories.push(migrationRoot);
        writeFileSync(join(migrationRoot, "20260729090000_create_orders.sql"), "CREATE TABLE orders (id uuid);\n");
        const requestedPaths: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requestedPaths.push(path);
                if (request.method === "GET") return Response.json([]);
                return Response.json({ code: "migration_baseline_rejected" }, { status: 400 });
            },
        });
        servers.push(server);

        const result = await runProjectCli(
            ["database", "baseline_migrations", "--dir", migrationRoot],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("❌ Failed (400)");
        expect(requestedPaths).toEqual([
            "/v1/projects/abc123/database/migrations",
            "/v1/projects/abc123/database/migrations/baseline",
        ]);
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
