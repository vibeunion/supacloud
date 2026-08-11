import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    "SUPACLOUD_READ_ONLY",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
    "SUPACLOUD_ENV",
    "SUPACLOUD_READ_ONLY",
]);

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const temporaryDirectories: string[] = [];
const LARGE_FUNCTION_SOURCE = "export const payload = "
    + JSON.stringify("x".repeat(80 * 1024))
    + ";\n";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000001";
const PATH_ESCAPE_INPUTS = [
    ".", "..", "%2e", "%2e%2e", ".%2e", "%2e.", "%252e%252e", "a/b", "a?b", "a#b",
];

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
    workingDirectory = PACKAGE_ROOT,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const processHandle = Bun.spawn([process.execPath, join(PACKAGE_ROOT, "src/index.ts"), ...args], {
        cwd: workingDirectory,
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
    test("documents global environment and production safety flags", async () => {
        const response = await runProjectCli(["--help"]);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--env <name>");
        expect(response.stderr).toContain("--env-file <path>");
        expect(response.stderr).toContain("--confirm-production <ref>");
        expect(response.stderr).toContain("SUPACLOUD_READ_ONLY=true");
    });

    test("loads named environments with global flags after the command and keeps status secret-free", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-named-env-"));
        temporaryDirectories.push(workspace);
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json({ status: "healthy" }),
        });
        servers.push(server);
        const environmentPath = join(workspace, ".env.supacloud.test");
        writeFileSync(environmentPath, [
            "SUPACLOUD_ENV=test",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=named-secret-token",
            "SUPACLOUD_PROJECT_REF=test-ref",
        ].join("\n") + "\n");

        const response = await runProjectCli(["status", "--env=test"], {}, workspace);
        const status = JSON.parse(response.stdout);

        expect(response.exitCode).toBe(0);
        expect(status).toMatchObject({
            environment: "test",
            source: { kind: "named_env_file", path: realpathSync(environmentPath) },
            apiUrl: `http://127.0.0.1:${server.port}`,
            projectRef: "test-ref",
            readOnly: false,
            production: false,
            hasApiToken: true,
        });
        expect(response.stdout).not.toContain("named-secret-token");
    });

    test("requires exact production confirmation and rejects cross-ref writes", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-production-env-"));
        temporaryDirectories.push(workspace);
        const requestedPaths: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                return Response.json({ status: "cancelled" });
            },
        });
        servers.push(server);
        writeFileSync(join(workspace, ".env.supacloud.prod"), [
            "SUPACLOUD_ENV=production",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=prod-secret-token",
            "SUPACLOUD_PROJECT_REF=prod-ref",
        ].join("\n") + "\n");

        const unconfirmed = await runProjectCli([
            "--env", "prod", "project", "task_cancel", "--task_id", "task-1",
        ], {}, workspace);
        const confirmed = await runProjectCli([
            "project", "task_cancel", "--task_id", "task-1",
            "--env=prod", "--confirm-production=prod-ref",
        ], {}, workspace);
        const crossRef = await runProjectCli([
            "project", "task_cancel", "--task_id", "task-1", "--ref", "other-ref",
            "--env", "prod", "--confirm-production", "other-ref",
        ], {}, workspace);

        expect(unconfirmed.exitCode).toBe(1);
        expect(unconfirmed.stderr).toContain("--confirm-production prod-ref");
        expect(confirmed.exitCode).toBe(0);
        expect(crossRef.exitCode).toBe(1);
        expect(crossRef.stderr).toContain("cannot target a different project");
        expect(requestedPaths).toEqual(["/v1/projects/prod-ref/tasks/task-1/cancel"]);
    });

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

    test("activates a Function version through a secret-safe process contract", async () => {
        const apiToken = "activation-api-token-sentinel";
        const requested: Array<{ method: string; path: string; authorization: string | null }> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requested.push({
                    method: request.method,
                    path: new URL(request.url).pathname,
                    authorization: request.headers.get("authorization"),
                });
                return Response.json({
                    success: true,
                    version: "6",
                    config: { version: "6", verify_jwt: false },
                });
            },
        });
        servers.push(server);
        const commandArguments = [
            "edge_functions", "activate", "--ref", "abc123",
            "--slug", "public-hook", "--version", "6",
        ];

        const response = await runProjectCli(commandArguments, {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: apiToken,
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const receipt = JSON.parse(response.stdout);

        expect(response.exitCode).toBe(0);
        expect(receipt).toMatchObject({
            ok: true,
            operation: "edge_functions.activate",
            slug: "public-hook",
            version: "6",
            verify_jwt: false,
        });
        expect(requested).toEqual([{
            method: "POST",
            path: "/v1/projects/abc123/functions/public-hook/versions/6/activate",
            authorization: `Bearer ${apiToken}`,
        }]);
        expect(commandArguments.join("\0")).not.toContain(apiToken);
        expect(response.stdout + response.stderr).not.toContain(apiToken);
    });

    test("returns structured non-zero Function activation failures without server text", async () => {
        const responseBodySentinel = "private-activation-response-sentinel";
        let activationCommitted = false;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => {
                activationCommitted = true;
                return Response.json({ error: responseBodySentinel }, { status: 503 });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );
        const receipt = JSON.parse(response.stdout);

        expect(activationCommitted).toBe(true);
        expect(response.exitCode).toBe(1);
        expect(receipt.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 503 });
        expect(response.stdout + response.stderr).not.toContain(responseBodySentinel);
    });

    test("reports an unknown Function activation outcome after malformed success", async () => {
        let activationCommitted = false;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                activationCommitted = true;
                return Response.json({ success: true });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(activationCommitted).toBe(true);
        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("rejects Function activation cross-action flags before HTTP dispatch", async () => {
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
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2",
                "--verify_jwt", "false",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("not supported for 'activate'");
    });

    test("rejects Function activation path before touching the file system or HTTP", async () => {
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
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2",
                "--path", "/definitely/not/exist/private-source.ts",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("'path' is not supported for 'activate'");
        expect(response.stdout + response.stderr).not.toContain("ENOENT");
        expect(response.stdout + response.stderr).not.toContain("Failed to bundle/read path");
    });

    test("blocks scheduled writes and Function activation in read-only mode before local reads or HTTP dispatch", async () => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestCount += 1;
                if (request.method === "GET") {
                    return Response.json({ project_ref: "abc123", schedules: [] });
                }
                return Response.json({});
            },
        });
        servers.push(server);
        const missingBodyFile = "/definitely/not/exist/schedule-body.json";
        const missingSourceFile = "/definitely/not/exist/function-source.ts";
        const commands = [
            [
                "scheduled_functions", "create", "--ref", "abc123", "--name", "Nightly",
                "--slug", "worker", "--cron", "0 2 * * *", "--method", "POST",
                "--body_file", missingBodyFile,
            ],
            [
                "scheduled_functions", "update", "--ref", "abc123", "--schedule_id", SCHEDULE_ID,
                "--body_file", missingBodyFile,
            ],
            ["scheduled_functions", "delete", "--ref", "abc123", "--schedule_id", SCHEDULE_ID],
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "worker", "--version", "1",
                "--path", missingSourceFile,
            ],
        ];

        for (const command of commands) {
            const response = await runProjectCli(command, {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                SUPACLOUD_READ_ONLY: "true",
            });

            expect(response.exitCode).toBe(1);
            expect(response.stdout + response.stderr).toContain("read-only");
            expect(response.stdout + response.stderr).not.toContain("ENOENT");
        }

        expect(requestCount).toBe(0);
        const listResponse = await runProjectCli(["scheduled_functions", "list", "--ref", "abc123"], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPACLOUD_READ_ONLY: "true",
        });

        expect(listResponse.exitCode).toBe(0);
        expect(JSON.parse(listResponse.stdout).schedules).toEqual([]);
        expect(requestCount).toBe(1);
    });

    test("creates a schedule with body-file and environment-backed headers outside argv and output", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-cli-schedule-"));
        temporaryDirectories.push(directory);
        const bodyPath = join(directory, "body.json");
        const bodySentinel = "private-schedule-body-sentinel";
        const headerSentinel = "private-schedule-header-sentinel";
        writeFileSync(bodyPath, JSON.stringify({ private: bodySentinel }));
        let requestBody: Record<string, unknown> | null = null;
        let requestId = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.json() as Record<string, unknown>;
                requestId = String(requestBody.request_id);
                const body = requestBody.body as Record<string, unknown>;
                const headers = requestBody.headers as Record<string, string>;
                return Response.json({
                    created: true,
                    project_ref: "abc123",
                    request_id: requestBody.request_id,
                    schedule: {
                        id: SCHEDULE_ID,
                        name: requestBody.name,
                        slug: requestBody.slug,
                        cron: requestBody.cron,
                        method: requestBody.method,
                        enabled: true,
                        body_empty: Object.keys(body).length === 0,
                        header_names: Object.keys(headers).sort(),
                        created_at: "2026-08-11T00:00:00.000Z",
                        updated_at: "2026-08-11T00:00:00.000Z",
                    },
                });
            },
        });
        servers.push(server);
        const commandArguments = [
            "scheduled_functions", "create", "--ref", "abc123",
            "--name", "Nightly", "--slug", "worker", "--cron", "0 2 * * *",
            "--method", "POST", "--body_file", bodyPath,
            "--header_env", '{"X-Schedule-Token":"SCHEDULE_TOKEN"}',
        ];

        const response = await runProjectCli(commandArguments, {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SCHEDULE_TOKEN: headerSentinel,
        });
        const receipt = JSON.parse(response.stdout);

        expect(response.exitCode).toBe(0);
        expect(requestBody).toMatchObject({
            body: { private: bodySentinel },
            headers: { "x-schedule-token": headerSentinel },
        });
        expect(requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(receipt.schedule).toMatchObject({ body_empty: false, header_names: ["x-schedule-token"] });
        expect(commandArguments.join("\0")).not.toContain(headerSentinel);
        expect(commandArguments.join("\0")).not.toContain(bodySentinel);
        expect(response.stdout + response.stderr).not.toContain(headerSentinel);
        expect(response.stdout + response.stderr).not.toContain(bodySentinel);
    });

    test.each(PATH_ESCAPE_INPUTS)("rejects schedule path escape '%s' before any HTTP request", async (scheduleId) => {
        let requestCount = 0;
        let projectMutationCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestCount += 1;
                if (new URL(request.url).pathname === "/v1/projects/abc123") projectMutationCount += 1;
                return Response.json({});
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };

        const updateResponse = await runProjectCli([
            "scheduled_functions", "update", "--ref", "abc123",
            "--schedule_id", scheduleId, "--name", "Safe Name",
        ], environment);
        const deleteResponse = await runProjectCli([
            "scheduled_functions", "delete", "--ref", "abc123", "--schedule_id", scheduleId,
        ], environment);

        expect(updateResponse.exitCode).toBe(1);
        expect(deleteResponse.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(projectMutationCount).toBe(0);
    });

    test("rejects a schedule dot-segment project ref before HTTP dispatch", async () => {
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
            ["scheduled_functions", "list", "--ref", ".."],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
    });

    test("reports an unknown schedule deletion outcome after malformed success", async () => {
        let deletionCommitted = false;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                deletionCommitted = true;
                return Response.json({ deleted: true });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["scheduled_functions", "delete", "--ref", "abc123", "--schedule_id", SCHEDULE_ID],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(deletionCommitted).toBe(true);
        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("reports an unknown schedule mutation outcome after commit followed by HTTP 503", async () => {
        let scheduleCommitted = false;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                await request.json();
                scheduleCommitted = true;
                return Response.json({ error: "private-post-commit-sentinel" }, { status: 503 });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            [
                "scheduled_functions", "create", "--ref", "abc123", "--name", "Nightly",
                "--slug", "worker", "--cron", "0 2 * * *", "--method", "POST",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(scheduleCommitted).toBe(true);
        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 503,
        });
        expect(response.stdout + response.stderr).not.toContain("private-post-commit-sentinel");
    });

    test("rejects an adversarial schedule cron before HTTP dispatch", async () => {
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
            [
                "scheduled_functions", "create", "--ref", "abc123", "--name", "Unsafe",
                "--slug", "worker", "--cron", "0-999999999 * * * *", "--method", "POST",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("'cron' is invalid");
    });

    test("rejects invalid environment-backed schedule headers without exposing values", async () => {
        const headerSentinel = "private-invalid-process-header-sentinel\n";
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
            [
                "scheduled_functions", "create", "--ref", "abc123", "--name", "Unsafe",
                "--slug", "worker", "--cron", "* * * * *", "--method", "POST",
                "--header_env", '{"x-schedule-token":"SCHEDULE_TOKEN"}',
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                SCHEDULE_TOKEN: headerSentinel,
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("SCHEDULE_HEADER_INVALID");
        expect(response.stdout + response.stderr).not.toContain(headerSentinel.trim());
    });

    test("rejects platform schedule headers before HTTP dispatch", async () => {
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
            [
                "scheduled_functions", "create", "--ref", "abc123", "--name", "Unsafe",
                "--slug", "worker", "--cron", "* * * * *", "--method", "POST",
                "--header_env", '{"X-Project-Ref":"SCHEDULE_TOKEN"}',
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                SCHEDULE_TOKEN: "private-platform-header-sentinel",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("SCHEDULE_HEADER_MAPPING_INVALID");
        expect(response.stdout + response.stderr).not.toContain("private-platform-header-sentinel");
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
