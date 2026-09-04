import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliToolResultIsError } from "./shared/cli";
import packageMetadata from "../package.json" with { type: "json" };

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
const SCHEDULE_UPDATED_AT = "2026-08-11T00:00:00.000Z";
const EXPECTED_ACTIVATION_ID = "a1111111-1111-4111-8111-111111111111";
const COMMITTED_ACTIVATION_ID = "b2222222-2222-4222-8222-222222222222";
const RECREATED_ACTIVATION_ID = "c3333333-3333-4333-8333-333333333333";
const LOGICAL_BACKUP_ID = "logical-full_abc123_0123456789abcdef0123456789abcdef";
const LOGICAL_BACKUP_SHA256 = "a".repeat(64);
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

async function runProjectCliPath(
    entryPath: string,
    args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const processHandle = Bun.spawn([entryPath, ...args], {
        cwd: PACKAGE_ROOT,
        env: cleanEnvironment(),
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

function chunkedJsonResponse(body: string): Response {
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.byteLength) return controller.close();
            const nextOffset = Math.min(offset + 256 * 1024, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, nextOffset));
            offset = nextOffset;
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
}

function logicalBackup(overrides: Record<string, unknown> = {}) {
    return {
        backup_id: LOGICAL_BACKUP_ID,
        project_ref: "abc123",
        database: "postgres",
        kind: "logical-full",
        created_at: "2026-08-17T12:00:00.000Z",
        completed_at: "2026-08-17T12:01:00.000Z",
        bytes: 128,
        sha256: LOGICAL_BACKUP_SHA256,
        ...overrides,
    };
}

function logicalBackupRestoreArguments(overrides: Record<string, string> = {}): string[] {
    const confirmation = `RESTORE_PROJECT:abc123:${LOGICAL_BACKUP_ID}:${LOGICAL_BACKUP_SHA256}`;
    return [
        "release", "logical_backup_restore", "--ref", "abc123",
        "--backup_id", overrides.backup_id ?? LOGICAL_BACKUP_ID,
        "--expected_sha256", overrides.expected_sha256 ?? LOGICAL_BACKUP_SHA256,
        "--restore_confirmation", overrides.restore_confirmation ?? confirmation,
    ];
}

function releaseBasePath(projectRef: string, deploymentId: string): string {
    return `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/releases`;
}

describe("supacloud-cli process contract", () => {
    test("prints the installed package version without project context", async () => {
        const response = await runProjectCli(["--version"]);

        expect(response.exitCode).toBe(0);
        expect(response.stdout.trim()).toBe(packageMetadata.version);
        expect(response.stderr).toBe("");
    });

    test("prints the installed package version through the npm-style bin", async () => {
        const sandbox = mkdtempSync(join(tmpdir(), "supacloud-cli-bin-"));
        temporaryDirectories.push(sandbox);
        const buildDirectory = join(sandbox, "dist");
        const build = Bun.spawnSync([
            process.execPath, "build", "src/index.ts", "--outdir", buildDirectory, "--target", "node",
        ], { cwd: PACKAGE_ROOT });
        expect(build.exitCode).toBe(0);
        const builtEntry = join(buildDirectory, "index.js");
        expect(readFileSync(builtEntry, "utf8").split("\n", 1)[0]).toBe("#!/usr/bin/env node");

        const bunPath = join(sandbox, "bun-bin");
        mkdirSync(bunPath);
        const bunProcess = Bun.spawn([process.execPath, builtEntry, "--version"], {
            cwd: PACKAGE_ROOT,
            env: cleanEnvironment({ PATH: bunPath }),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [bunExitCode, bunStdout, bunStderr] = await Promise.all([
            bunProcess.exited,
            new Response(bunProcess.stdout).text(),
            new Response(bunProcess.stderr).text(),
        ]);
        expect(bunExitCode).toBe(0);
        expect(bunStdout.trim()).toBe(packageMetadata.version);
        expect(bunStderr).toBe("");

        const binDirectory = join(sandbox, "node_modules/.bin");
        mkdirSync(binDirectory, { recursive: true });
        const linkedEntry = join(binDirectory, "supacloud-cli");
        symlinkSync(builtEntry, linkedEntry);

        const response = await runProjectCliPath(linkedEntry, ["--version"]);

        expect(response.exitCode).toBe(0);
        expect(response.stdout.trim()).toBe(packageMetadata.version);
        expect(response.stderr).toBe("");
    });

    test("documents global environment and production safety flags", async () => {
        const response = await runProjectCli(["--help"]);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--env <name>");
        expect(response.stderr).toContain("--env-file <path>");
        expect(response.stderr).toContain("--confirm-production <ref>");
        expect(response.stderr).toContain("SUPACLOUD_READ_ONLY=true");
    });

    test("keeps complete Storage help without project configuration", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-storage-help-"));
        temporaryDirectories.push(workspace);

        const response = await runProjectCli(["storage", "--help"], {}, workspace);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("list_buckets");
        expect(response.stderr).toContain("get_bucket");
        expect(response.stderr).toContain("create_bucket");
        expect(response.stderr).toContain("update_bucket");
        expect(response.stderr).toContain("delete_bucket");
        expect(response.stderr).toContain("--file_size_limit");
        expect(response.stderr).toContain("--allowed_mime_types");
    });

    test("keeps immutable frontend release help without project configuration", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-frontend-help-"));
        temporaryDirectories.push(workspace);

        const response = await runProjectCli(["frontend", "--help"], {}, workspace);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("list_releases");
        expect(response.stderr).toContain("get_release");
        expect(response.stderr).toContain("upload_release");
        expect(response.stderr).toContain("activate_release");
        expect(response.stderr).toContain("--zip_path");
        expect(response.stderr).toContain("--expected_active_release_id");
        expect(response.stderr).toContain("--expected_activation_id");
        expect(response.stderr).toContain("--mutation_id");
    });

    test("runs migration lint locally without project credentials", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-local-lint-"));
        temporaryDirectories.push(workspace);
        const migrationPath = join(workspace, "safe.sql");
        writeFileSync(migrationPath, "CREATE TABLE public.items (id bigint PRIMARY KEY);");

        const response = await runProjectCli([
            "database", "lint_migrations", "--file", migrationPath,
        ], {}, workspace);

        expect(response.exitCode).toBe(0);
        expect(response.stdout).toContain("Migration Risk Level: LOW");
        expect(response.stdout).not.toContain("requires Management API context");
    });

    test("returns a non-zero process exit for strict local migration lint", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-local-lint-strict-"));
        temporaryDirectories.push(workspace);
        const migrationPath = join(workspace, "destructive.sql");
        writeFileSync(migrationPath, "DROP TABLE public.legacy_items;");

        const response = await runProjectCli([
            "database", "lint_migrations", "--file", migrationPath, "--strict",
        ], {}, workspace);

        expect(response.exitCode).toBe(1);
        expect(response.stdout).toContain("Migration Risk Level: HIGH");
    });

    test("documents all local lint inputs without unrelated schema flags", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-local-lint-help-"));
        temporaryDirectories.push(workspace);

        const response = await runProjectCli(["database", "lint", "--help"], {}, workspace);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--sql");
        expect(response.stderr).toContain("--file");
        expect(response.stderr).toContain("--dir");
        expect(response.stderr).toContain("--strict");
        expect(response.stderr).toContain("--fail_on_medium");
        expect(response.stderr).toContain("--json");
        expect(response.stderr).not.toContain("--schema");
    });

    test("keeps the release-canary OAuth client command discoverable without project configuration", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-oauth-client-help-"));
        temporaryDirectories.push(workspace);

        const response = await runProjectCli(["oauth_clients", "--help"], {}, workspace);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("oauth_clients <action>");
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
            "--env", "prod", "project", "pause",
        ], {}, workspace);
        const confirmed = await runProjectCli([
            "project", "pause",
            "--env=prod", "--confirm-production=prod-ref",
        ], {}, workspace);
        const crossRef = await runProjectCli([
            "project", "restore", "--ref", "other-ref",
            "--env", "prod", "--confirm-production", "other-ref",
        ], {}, workspace);

        expect(unconfirmed.exitCode).toBe(1);
        expect(unconfirmed.stderr).toContain("--confirm-production prod-ref");
        expect(confirmed.exitCode).toBe(0);
        expect(crossRef.exitCode).toBe(1);
        expect(crossRef.stderr).toContain("cannot target a different project");
        expect(requestedPaths).toEqual(["/v1/projects/prod-ref/pause"]);
    });

    test("blocks production frontend release upload before file or HTTP without exact confirmation", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-production-frontend-"));
        temporaryDirectories.push(workspace);
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
        writeFileSync(join(workspace, ".env.supacloud.production"), [
            "SUPACLOUD_ENV=production",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=frontend-production-token",
            "SUPACLOUD_PROJECT_REF=prod-ref",
        ].join("\n") + "\n");

        const response = await runProjectCli([
            "frontend", "upload_release", "--ref", "prod-ref", "--id", "web",
            "--zip_path", join(workspace, "missing.zip"), "--env", "production",
        ], {}, workspace);

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("--confirm-production prod-ref");
        expect(response.stdout + response.stderr).not.toContain("frontend-production-token");
        expect(requestCount).toBe(0);
    });

    test("runs authoritative immutable frontend release list, upload, and activation flows", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-frontend-release-"));
        temporaryDirectories.push(workspace);
        const archivePath = join(workspace, "site.zip");
        writeFileSync(archivePath, "zip");
        const projectRef = "abc123";
        const deploymentId = "web";
        const releaseId = createHash("sha256").update("zip").digest("hex");
        const treeSha256 = "b".repeat(64);
        const mutationId = SCHEDULE_ID;
        const requested: Array<{ method: string; path: string; body?: unknown; sha256?: string }> = [];
        const release = {
            schema: "supacloud.frontend-release.v1",
            project_ref: projectRef,
            deployment_id: deploymentId,
            release_id: releaseId,
            sha256: releaseId,
            tree_sha256: treeSha256,
            size_bytes: 3,
            file_count: 1,
            created_at: "2026-08-20T00:00:00.000Z",
            kind: "prebuilt_static",
        };
        const inventory = (active: boolean) => ({
            project_ref: projectRef,
            deployment_id: deploymentId,
            active_release_id: active ? releaseId : null,
            active_activation_id: active ? mutationId : null,
            releases: [release],
            next_cursor: null,
        });
        let active = false;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                const entry: { method: string; path: string; body?: unknown; sha256?: string } = {
                    method: request.method,
                    path: `${url.pathname}${url.search}`,
                };
                requested.push(entry);
                const releaseBase = `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}/releases`;
                if (request.method === "GET" && url.pathname === releaseBase) {
                    return Response.json(inventory(active));
                }
                if (request.method === "POST" && url.pathname === releaseBase) {
                    entry.sha256 = request.headers.get("x-supacloud-content-sha256") || undefined;
                    expect(new TextDecoder().decode(await request.arrayBuffer())).toBe("zip");
                    return Response.json({ project_ref: projectRef, deployment_id: deploymentId, release }, {
                        status: 201,
                    });
                }
                if (request.method === "GET" && url.pathname === `${releaseBase}/${releaseId}`) {
                    return Response.json({ project_ref: projectRef, deployment_id: deploymentId, release });
                }
                if (request.method === "POST" && url.pathname === `${releaseBase}/${releaseId}/activate`) {
                    entry.body = await request.json();
                    active = true;
                    return Response.json({
                        project_ref: projectRef,
                        deployment_id: deploymentId,
                        active_release_id: releaseId,
                        activation_id: mutationId,
                        release,
                        mutation: { mutation_id: mutationId, status: "succeeded", replayed: false },
                    });
                }
                return Response.json({}, { status: 404 });
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "frontend-test-token",
            SUPACLOUD_PROJECT_REF: projectRef,
        };

        const listed = await runProjectCli([
            "frontend", "list_releases", "--ref", projectRef, "--id", deploymentId,
        ], environment, workspace);
        const uploaded = await runProjectCli([
            "frontend", "upload_release", "--ref", projectRef, "--id", deploymentId,
            "--zip_path", archivePath,
        ], environment, workspace);
        const activated = await runProjectCli([
            "frontend", "activate_release", "--ref", projectRef, "--id", deploymentId,
            "--release_id", releaseId,
            "--expected_active_release_id", "absent",
            "--expected_activation_id", "absent",
            "--mutation_id", mutationId,
        ], environment, workspace);

        expect(listed.exitCode).toBe(0);
        expect(JSON.parse(listed.stdout).releases).toHaveLength(1);
        expect(uploaded.exitCode).toBe(0);
        expect(JSON.parse(uploaded.stdout).release.release_id).toBe(releaseId);
        expect(activated.exitCode).toBe(0);
        expect(JSON.parse(activated.stdout)).toMatchObject({
            active_release_id: releaseId,
            activation_id: mutationId,
        });
        expect(requested).toEqual([
            { method: "GET", path: `${releaseBasePath(projectRef, deploymentId)}?limit=50` },
            {
                method: "POST",
                path: releaseBasePath(projectRef, deploymentId),
                sha256: releaseId,
            },
            { method: "GET", path: `${releaseBasePath(projectRef, deploymentId)}/${releaseId}` },
            {
                method: "POST",
                path: `${releaseBasePath(projectRef, deploymentId)}/${releaseId}/activate`,
                body: {
                    expected_active_release_id: "absent",
                    expected_activation_id: "absent",
                    mutation_id: mutationId,
                },
            },
            { method: "GET", path: `${releaseBasePath(projectRef, deploymentId)}?limit=100` },
            { method: "GET", path: `${releaseBasePath(projectRef, deploymentId)}/${releaseId}` },
        ]);
        expect(listed.stdout + uploaded.stdout + activated.stdout).not.toContain("frontend-test-token");
    });

    test("protects a release-canary OAuth client create and keeps upstream secrets out of the process receipt", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-oauth-client-production-env-"));
        temporaryDirectories.push(workspace);
        const responseSecret = "oauth-client-secret-must-not-leak";
        const requestedPaths: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                requestedPaths.push(path);
                if (request.method === "GET" && path.endsWith("/oauth-clients")) {
                    return Response.json({ clients: [] });
                }
                if (request.method === "POST" && path.endsWith("/oauth-clients")) {
                    return Response.json({ client_id: "release-canary.client-1", client_secret: responseSecret });
                }
                if (request.method === "GET" && path.endsWith("/oauth-clients/release-canary.client-1")) {
                    return Response.json({
                        client_id: "release-canary.client-1",
                        client_name: "supacloud-release-canary",
                        client_type: "public",
                        token_endpoint_auth_method: "none",
                        redirect_uris: ["https://release-canary.example.test/callback"],
                        grant_types: ["authorization_code"],
                        response_types: ["code"],
                        client_secret: responseSecret,
                    });
                }
                return Response.json({}, { status: 404 });
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
            "--env", "prod", "oauth_clients", "create",
            "--ref", "prod-ref",
            "--redirect_uri", "https://release-canary.example.test/callback",
        ], {}, workspace);
        const confirmed = await runProjectCli([
            "oauth_clients", "create",
            "--ref", "prod-ref",
            "--redirect_uri", "https://release-canary.example.test/callback",
            "--env", "prod", "--confirm-production", "prod-ref",
        ], {}, workspace);

        expect(unconfirmed.exitCode).toBe(1);
        expect(unconfirmed.stderr).toContain("--confirm-production prod-ref");
        expect(confirmed.exitCode).toBe(0);
        expect(requestedPaths).toEqual([
            "/v1/projects/prod-ref/auth/oauth-clients",
            "/v1/projects/prod-ref/auth/oauth-clients",
            "/v1/projects/prod-ref/auth/oauth-clients/release-canary.client-1",
        ]);
        expect(confirmed.stdout).not.toContain(responseSecret);
        expect(JSON.parse(confirmed.stdout)).toMatchObject({
            ok: true,
            operation: "oauth_clients.create",
            project_ref: "prod-ref",
            reused: false,
        });
    });

    test("blocks a release-canary OAuth client mutation in read-only mode before HTTP dispatch", async () => {
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

        const response = await runProjectCli([
            "oauth_clients", "create",
            "--ref", "abc123",
            "--redirect_uri", "https://release-canary.example.test/callback",
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "read-only-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPACLOUD_READ_ONLY: "true",
        });

        expect(response.exitCode).toBe(1);
        expect(response.stdout + response.stderr).toContain("read-only");
        expect(requestCount).toBe(0);
    });

    test("blocks project recovery actions in read-only mode before HTTP dispatch", async () => {
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

        for (const action of ["pause", "restore"]) {
            const response = await runProjectCli(["project", action], {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                SUPACLOUD_READ_ONLY: "true",
            });

            expect(response.exitCode).toBe(1);
            expect(response.stdout + response.stderr).toContain("read-only");
        }

        expect(requestCount).toBe(0);
    });

    test("blocks project recovery actions for application-only profiles before HTTP dispatch", async () => {
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

        for (const action of ["pause", "restore"]) {
            const response = await runProjectCli(["project", action], {
                SUPABASE_URL: `http://127.0.0.1:${server.port}`,
                SUPABASE_SERVICE_ROLE_KEY: "application-service-role-key",
            });

            expect(response.exitCode).toBe(1);
            expect(response.stdout + response.stderr).toContain("Management API context");
        }

        expect(requestCount).toBe(0);
    });

    test("requires production confirmation for secrets from environment before HTTP", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-production-secrets-"));
        temporaryDirectories.push(workspace);
        const productionSecretName = "FA_CLI_PRODUCTION_SECRET";
        const productionSecret = "production-secret-sentinel";
        const requestedPaths: string[] = [];
        const requestedBodies: unknown[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                requestedBodies.push(await request.json());
                return Response.json({});
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
            "secrets", "upsert", "--ref", "prod-ref", "--from-env", productionSecretName, "--env", "prod",
        ], { [productionSecretName]: productionSecret }, workspace);
        const crossRef = await runProjectCli([
            "secrets", "upsert", "--ref", "other-ref", "--from-env", productionSecretName,
            "--env", "prod", "--confirm-production", "other-ref",
        ], { [productionSecretName]: productionSecret }, workspace);
        const confirmed = await runProjectCli([
            "secrets", "upsert", "--ref", "prod-ref", "--from-env", productionSecretName,
            "--env", "prod", "--confirm-production", "prod-ref",
        ], { [productionSecretName]: productionSecret }, workspace);

        expect(unconfirmed.exitCode).toBe(1);
        expect(unconfirmed.stderr).toContain("--confirm-production prod-ref");
        expect(crossRef.exitCode).toBe(1);
        expect(crossRef.stderr).toContain("cannot target a different project");
        expect(confirmed.exitCode).toBe(0);
        expect(requestedPaths).toEqual(["/v1/projects/prod-ref/secrets"]);
        expect(requestedBodies).toEqual([[
            { name: productionSecretName, value: productionSecret },
        ]]);
        for (const response of [unconfirmed, crossRef, confirmed]) {
            expect(response.stdout + response.stderr).not.toContain(productionSecret);
        }
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

    test("reads an immutable Function version to stdout or an exclusive output file", async () => {
        const requestedPaths: string[] = [];
        const immutableSource = "export const release = 40;\n";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                return Response.json({
                    source_code: null,
                    bundle_code: immutableSource,
                    has_source: false,
                    has_bundle: true,
                    private: "immutable-source-sentinel",
                });
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };
        const outputDirectory = mkdtempSync(join(tmpdir(), "supacloud-cli-version-source-"));
        temporaryDirectories.push(outputDirectory);
        const outputPath = join(outputDirectory, "fa-api-v40.ts");

        const stdoutResponse = await runProjectCli([
            "edge_functions", "source", "--ref", "abc123", "--slug", "fa-api", "--version", "40",
        ], environment);
        const fileResponse = await runProjectCli([
            "edge_functions", "source", "--ref", "abc123", "--slug", "fa-api", "--version", "40",
            "--output", outputPath,
        ], environment);
        const overwriteResponse = await runProjectCli([
            "edge_functions", "source", "--ref", "abc123", "--slug", "fa-api", "--version", "40",
            "--output", outputPath,
        ], environment);

        expect(stdoutResponse.exitCode).toBe(0);
        expect(JSON.parse(stdoutResponse.stdout)).toEqual({ code: immutableSource });
        expect(stdoutResponse.stdout).not.toContain("sentinel");
        expect(fileResponse.exitCode).toBe(0);
        expect(readFileSync(outputPath, "utf8")).toBe(immutableSource);
        expect(overwriteResponse.exitCode).toBe(1);
        expect(overwriteResponse.stderr).toContain("EEXIST");
        expect(readFileSync(outputPath, "utf8")).toBe(immutableSource);
        expect(requestedPaths).toEqual(Array(3).fill("/v1/projects/abc123/functions/fa-api/versions/40"));
    });

    test("prints a Function list with numeric active versions for release readback", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json([
                { slug: "legacy-hook", version: 0, activation_id: "legacy", verify_jwt: true },
                { slug: "fa-api", version: 40, activation_id: EXPECTED_ACTIVATION_ID, verify_jwt: true },
            ]),
        });
        servers.push(server);

        const response = await runProjectCli(["edge_functions", "list", "--ref", "abc123"], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const functions = JSON.parse(response.stdout);

        expect(response.exitCode).toBe(0);
        expect(Array.isArray(functions)).toBe(true);
        expect(functions).toEqual([
            { slug: "legacy-hook", version: 0, activation_id: "legacy", verify_jwt: true },
            { slug: "fa-api", version: 40, activation_id: EXPECTED_ACTIVATION_ID, verify_jwt: true },
        ]);
    });

    test("rejects malformed Function readbacks without reflecting server fields", async () => {
        const responseSentinel = "private-function-readback-sentinel";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                return path.endsWith("/source")
                    ? Response.json({ code: 7, private: responseSentinel })
                    : Response.json([{ slug: "fa-api", version: "40", private: responseSentinel }]);
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };

        const listResponse = await runProjectCli(["edge_functions", "list", "--ref", "abc123"], environment);
        const sourceResponse = await runProjectCli([
            "edge_functions", "source", "--ref", "abc123", "--slug", "fa-api",
        ], environment);

        for (const response of [listResponse, sourceResponse]) {
            expect(response.exitCode).toBe(1);
            expect(response.stdout + response.stderr).not.toContain(responseSentinel);
        }
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
        expect(result.stdout + result.stderr).toContain("Management API context");
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

    test("returns non-zero without echoing the response body when listing secrets fails", async () => {
        const responseBodySentinel = "server-secret-shaped-error-sentinel";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json({ error: responseBodySentinel }, { status: 503 });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["secrets", "list", "--ref", "abc123"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(response.stdout).toContain("❌ Failed (503)");
        expect(response.stdout + response.stderr).not.toContain(responseBodySentinel);
    });

    test.each([
        ["masked projection", [
            { name: "API_KEY", value: "********", internal: "projection-secret-sentinel" },
        ], [{ name: "API_KEY", value: "********" }]],
        ["empty list", [], []],
    ])("prints only the local %s for a valid secret list", async (_label, payload, expected) => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json(payload),
        });
        servers.push(server);

        const response = await runProjectCli(
            ["secrets", "list", "--ref", "abc123"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toEqual(expected);
        expect(response.stdout + response.stderr).not.toContain("projection-secret-sentinel");
    });

    test.each([
        ["free text", "list-free-text-secret-sentinel"],
        ["object", { error: "list-object-secret-sentinel" }],
        ["plaintext value", [{ name: "API_KEY", value: "plaintext-secret-sentinel" }]],
        ["non-string name", [{ name: 7, value: "********", leak: "non-string-name-sentinel" }]],
        ["dangerous name", [{ name: "API-KEY", value: "********", leak: "dangerous-name-sentinel" }]],
        ["duplicate name", [
            { name: "API_KEY", value: "********" },
            { name: "API_KEY", value: "********", leak: "duplicate-name-sentinel" },
        ]],
        ["too many entries", Array.from({ length: 1025 }, (_, index) => ({
            name: `KEY_${index}`,
            value: "********",
            leak: index === 0 ? "too-many-entries-sentinel" : undefined,
        }))],
        ["oversized response", [{
            name: "API_KEY",
            value: "********",
            leak: `oversized-list-sentinel-${"x".repeat(1024 * 1024)}`,
        }]],
    ])("rejects a 200 %s secret list without reflection", async (_label, payload) => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json(payload),
        });
        servers.push(server);

        const response = await runProjectCli(
            ["secrets", "list", "--ref", "abc123"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(response.stdout.trim()).toBe("❌ Project secret list response is invalid");
        expect(response.stdout + response.stderr).not.toContain("sentinel");
    });

    test("rejects a valid JSON secret list whose raw chunked body exceeds 1 MiB", async () => {
        const oversizedBody = `${" ".repeat(1024 * 1024 + 1)}[]`;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => chunkedJsonResponse(oversizedBody),
        });
        servers.push(server);

        const response = await runProjectCli(
            ["secrets", "list", "--ref", "abc123"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(Buffer.byteLength(oversizedBody)).toBe(1_048_579);
        expect(response.exitCode).toBe(1);
        expect(response.stdout.trim()).toBe("❌ Project secret list response is invalid");
        expect(response.stderr).toBe("");
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

    test("rejects a repeated from-env flag before HTTP without reading its value", async () => {
        let requestCount = 0;
        const secretSentinel = "duplicate-flag-secret-sentinel";
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
                "--from-env", "API_KEY", "--from-env=API_KEY",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                API_KEY: secretSentinel,
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("Duplicate CLI flag is not allowed");
        expect(response.stdout + response.stderr).not.toContain(secretSentinel);
    });

    test("preserves string-shaped from-env names before generic CLI coercion", async () => {
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

        const response = await runProjectCli(
            ["secrets", "upsert", "--ref", "abc123", "--from-env", "true,false,Infinity"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
                true: "true-secret-sentinel",
                false: "false-secret-sentinel",
                Infinity: "infinity-secret-sentinel",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(requestBody).toEqual([
            { name: "true", value: "true-secret-sentinel" },
            { name: "false", value: "false-secret-sentinel" },
            { name: "Infinity", value: "infinity-secret-sentinel" },
        ]);
        expect(response.stdout + response.stderr).not.toContain("secret-sentinel");
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

    test("documents exact activation concurrency flags for Function mutations", async () => {
        for (const action of ["deploy", "deploy_bundle", "activate"]) {
            const response = await runProjectCli(["edge_functions", action, "--help"], {
                SUPACLOUD_API_URL: "http://127.0.0.1:1",
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            });

            expect(response.exitCode).toBe(0);
            expect(response.stderr).toContain("--expected-active-version");
            expect(response.stderr).not.toContain("--expected_active_version");
            expect(response.stderr).toContain("--expected-activation-id");
            expect(response.stderr).not.toContain("--expected_activation_id");
        }
        for (const action of ["config", "delete"]) {
            const response = await runProjectCli(["edge_functions", action, "--help"], {
                SUPACLOUD_API_URL: "http://127.0.0.1:1",
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            });

            expect(response.exitCode).toBe(0);
            expect(response.stderr).toContain("--expected-activation-id");
            expect(response.stderr).not.toContain("--expected-active-version");
        }
    });

    test("documents current single-Function release controls", async () => {
        const response = await runProjectCli(["edge_functions", "--help"], {
            SUPACLOUD_API_URL: "http://127.0.0.1:1",
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("get_config");
        expect(response.stderr).not.toContain("deploy_manifest");
    });

    test("marks the atomic Function manifest as a proposed contract", () => {
        const spec = readFileSync(
            join(PACKAGE_ROOT, "../../docs/release-control-automation-spec.md"),
            "utf8",
        );

        expect(spec).toContain("> **Status: Proposed architecture.");
        expect(spec).toContain("`edge_functions deploy_manifest --atomic` is not");
        expect(spec).toContain("Proposed `edge_functions deploy_manifest --atomic`");
    });

    test("reads an allowlisted tombstone identity through get_config", async () => {
        const privateSentinel = "private-get-config-process-sentinel";
        const requestedPaths: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                return Response.json({
                    project_ref: "abc123",
                    slug: "deleted-hook",
                    active_version: "absent",
                    activation_id: COMMITTED_ACTIVATION_ID,
                    verify_jwt: true,
                    background_routes: [],
                    private: privateSentinel,
                });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            ["edge_functions", "get_config", "--ref", "abc123", "--slug", "deleted-hook"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(0);
        expect(requestedPaths).toEqual(["/v1/projects/abc123/functions/deleted-hook/config"]);
        expect(JSON.parse(response.stdout)).toEqual({
            project_ref: "abc123",
            slug: "deleted-hook",
            active_version: "absent",
            verify_jwt: true,
            background_routes: [],
            activation_id: COMMITTED_ACTIVATION_ID,
        });
        expect(response.stdout + response.stderr).not.toContain(privateSentinel);
    });

    test("fails config and delete closed after a possible HTTP 503 commit", async () => {
        const privateSentinel = "private-function-mutation-process-sentinel";
        const observedMethods: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                observedMethods.push(request.method);
                return Response.json({ error: privateSentinel }, { status: 503 });
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };

        const configResponse = await runProjectCli([
            "edge_functions", "config", "--ref", "abc123", "--slug", "hook",
            "--verify_jwt", "false", "--expected-activation-id", EXPECTED_ACTIVATION_ID,
        ], environment);
        const deleteResponse = await runProjectCli([
            "edge_functions", "delete", "--ref", "abc123", "--slug", "hook",
            "--expected-activation-id", EXPECTED_ACTIVATION_ID,
        ], environment);

        expect(observedMethods).toEqual(["PATCH", "DELETE"]);
        for (const response of [configResponse, deleteResponse]) {
            expect(response.exitCode).toBe(1);
            expect(JSON.parse(response.stdout).error).toEqual({
                code: "OUTCOME_UNKNOWN",
                http_status: 503,
            });
            expect(response.stdout + response.stderr).not.toContain(privateSentinel);
        }
    });

    test("recreates a deleted Function with the tombstone activation identity", async () => {
        const observedRequests: Array<{ method: string; path: string; body?: unknown }> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const body = request.method === "GET" ? undefined : await request.json();
                observedRequests.push({ method: request.method, path, body });
                if (request.method === "DELETE") {
                    return Response.json({
                        success: true,
                        project_ref: "abc123",
                        slug: "hook",
                        expected_activation_id: EXPECTED_ACTIVATION_ID,
                        activation_id: COMMITTED_ACTIVATION_ID,
                        previous_active_version: "7",
                        active_version: "absent",
                        config: {
                            verify_jwt: true,
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
                    });
                }
                if (request.method === "GET") {
                    return Response.json({
                        project_ref: "abc123",
                        slug: "hook",
                        active_version: "absent",
                        activation_id: COMMITTED_ACTIVATION_ID,
                        verify_jwt: true,
                        background_routes: [],
                    });
                }
                return Response.json({
                    success: true,
                    project_ref: "abc123",
                    slug: "hook",
                    previous_active_version: "absent",
                    expected_activation_id: COMMITTED_ACTIVATION_ID,
                    activation_id: RECREATED_ACTIVATION_ID,
                    active_version: "1",
                    version: "1",
                    config: {
                        version: "1",
                        verify_jwt: true,
                        activation_id: RECREATED_ACTIVATION_ID,
                    },
                });
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };

        const deleted = await runProjectCli([
            "edge_functions", "delete", "--ref", "abc123", "--slug", "hook",
            "--expected-activation-id", EXPECTED_ACTIVATION_ID,
        ], environment);
        const tombstone = await runProjectCli(
            ["edge_functions", "get_config", "--ref", "abc123", "--slug", "hook"],
            environment,
        );
        const recreated = await runProjectCli([
            "edge_functions", "deploy", "--ref", "abc123", "--slug", "hook",
            "--code", "export default { fetch: () => new Response('recreated') }",
            "--expected-active-version", "absent",
            "--expected-activation-id", COMMITTED_ACTIVATION_ID,
        ], environment);

        expect([deleted.exitCode, tombstone.exitCode, recreated.exitCode]).toEqual([0, 0, 0]);
        expect(JSON.parse(deleted.stdout)).toMatchObject({
            operation: "edge_functions.delete",
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "absent",
        });
        expect(JSON.parse(tombstone.stdout)).toMatchObject({
            active_version: "absent",
            activation_id: COMMITTED_ACTIVATION_ID,
        });
        expect(JSON.parse(recreated.stdout)).toMatchObject({
            operation: "edge_functions.deploy",
            previous_active_version: "absent",
            activation_id: RECREATED_ACTIVATION_ID,
            active_version: "1",
        });
        expect(observedRequests.map(({ method, path }) => ({ method, path }))).toEqual([
            { method: "DELETE", path: "/v1/projects/abc123/functions/hook" },
            { method: "GET", path: "/v1/projects/abc123/functions/hook/config" },
            { method: "POST", path: "/v1/projects/abc123/functions/hook" },
        ]);
        expect(observedRequests[2]?.body).toMatchObject({
            expected_active_version: "absent",
            expected_activation_id: COMMITTED_ACTIVATION_ID,
        });
    });

    test("documents exact prebundled Function deployment flags", async () => {
        const response = await runProjectCli(["edge_functions", "deploy", "--help"], {
            SUPACLOUD_API_URL: "http://127.0.0.1:1",
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--prebundled-path");
        expect(response.stderr).toContain("--expected-sha256");
        expect(response.stderr).not.toContain("--prebundled_path");
        expect(response.stderr).not.toContain("--expected_sha256");
    });

    test("documents the self-contained multi-file bundle directory flag", async () => {
        const response = await runProjectCli(["edge_functions", "deploy_bundle", "--help"], {
            SUPACLOUD_API_URL: "http://127.0.0.1:1",
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toContain("--bundle-dir");
        expect(response.stderr).toContain("node_modules");
        expect(response.stderr).not.toContain("--bundle_dir");
    });

    test("deploys exact verified prebundled Function bytes through the process CLI", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-cli-prebundled-"));
        temporaryDirectories.push(directory);
        const bundlePath = join(directory, "fa-api.js");
        const code = "export default { fetch: () => new Response('exact-process-bytes') };\r\n";
        const expectedSha256 = createHash("sha256").update(code).digest("hex");
        writeFileSync(bundlePath, code);
        let requestBody: Record<string, unknown> | undefined;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.json() as Record<string, unknown>;
                return Response.json({
                    success: true,
                    project_ref: "abc123",
                    slug: "fa-api",
                    previous_active_version: "7",
                    expected_activation_id: EXPECTED_ACTIVATION_ID,
                    activation_id: COMMITTED_ACTIVATION_ID,
                    active_version: "8",
                    version: "8",
                    config: {
                        version: "8",
                        verify_jwt: true,
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                });
            },
        });
        servers.push(server);

        const response = await runProjectCli([
            "edge_functions", "deploy", "--ref", "abc123", "--slug", "fa-api",
            "--prebundled-path", bundlePath,
            "--expected-sha256", expectedSha256,
            "--expected-active-version", "7",
            "--expected-activation-id", EXPECTED_ACTIVATION_ID,
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            PATH: "",
        });

        expect(response.exitCode).toBe(0);
        expect(requestBody).toEqual({
            code,
            prebundled: true,
            expected_sha256: expectedSha256,
            expected_active_version: "7",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
        });
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            operation: "edge_functions.deploy",
            active_version: "8",
        });
    });

    test("rejects a prebundled hash mismatch before the process CLI sends HTTP", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-cli-prebundled-mismatch-"));
        temporaryDirectories.push(directory);
        const bundlePath = join(directory, "fa-api.js");
        writeFileSync(bundlePath, "export default { fetch: () => new Response('replaced') };\n");
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

        const response = await runProjectCli([
            "edge_functions", "deploy", "--ref", "abc123", "--slug", "fa-api",
            "--prebundled-path", bundlePath,
            "--expected-sha256", createHash("sha256").update("approved-bytes").digest("hex"),
            "--expected-active-version", "absent",
            "--expected-activation-id", "legacy",
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("SHA-256 does not match");
        expect(requestCount).toBe(0);
    });

    test("deploys over legacy Function v0 with an identity-bound CAS receipt", async () => {
        let requestBody: Record<string, unknown> | null = null;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.json() as Record<string, unknown>;
                return Response.json({
                    success: true,
                    project_ref: "abc123",
                    slug: "worker",
                    previous_active_version: "0",
                    expected_activation_id: "legacy",
                    activation_id: COMMITTED_ACTIVATION_ID,
                    active_version: "1",
                    version: "1",
                    config: {
                        version: "1",
                        verify_jwt: true,
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                });
            },
        });
        servers.push(server);

        const response = await runProjectCli([
            "edge_functions", "deploy_bundle", "--ref", "abc123", "--slug", "worker",
            "--files", JSON.stringify({ "index.ts": "export default {}" }),
            "--expected-active-version", "0",
            "--expected-activation-id", "legacy",
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            operation: "edge_functions.deploy_bundle",
            project_ref: "abc123",
            slug: "worker",
            previous_active_version: "0",
            active_version: "1",
        });
        expect(requestBody).toMatchObject({
            expected_active_version: "0",
            expected_activation_id: "legacy",
        });
    });

    test("rejects Function mutations without expected-active-version before HTTP", async () => {
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
        const commands = [
            [
                "edge_functions", "deploy", "--ref", "abc123", "--slug", "worker",
                "--path", "/definitely/missing.ts",
            ],
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "worker",
                "--version", "2",
            ],
        ];

        for (const command of commands) {
            const response = await runProjectCli(command, {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            });
            expect(response.exitCode).toBe(1);
            expect(response.stderr).toContain("--expected-active-version");
            expect(response.stderr).not.toContain("ENOENT");
        }
        expect(requestCount).toBe(0);
    });

    test("rejects Function mutations without expected-activation-id before HTTP", async () => {
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
        const commands = [
            [
                "edge_functions", "deploy", "--ref", "abc123", "--slug", "worker",
                "--path", "/definitely/missing.ts", "--expected-active-version", "1",
            ],
            [
                "edge_functions", "deploy_bundle", "--ref", "abc123", "--slug", "worker",
                "--files", JSON.stringify({ "index.ts": "export default {}" }),
                "--expected-active-version", "1",
            ],
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "worker",
                "--version", "2", "--expected-active-version", "1",
            ],
        ];

        for (const command of commands) {
            const response = await runProjectCli(command, {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            });
            expect(response.exitCode).toBe(1);
            expect(response.stderr).toContain("--expected-activation-id");
            expect(response.stderr).not.toContain("ENOENT");
        }
        expect(requestCount).toBe(0);
    });

    test("rejects a non-canonical expected activation ID before HTTP", async () => {
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

        const response = await runProjectCli([
            "edge_functions", "activate", "--ref", "abc123", "--slug", "worker",
            "--version", "2", "--expected-active-version", "1",
            "--expected-activation-id", EXPECTED_ACTIVATION_ID.toUpperCase(),
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("Invalid arguments");
        expect(requestCount).toBe(0);
    });

    test("activates a positive Function version from legacy v0 through a secret-safe process contract", async () => {
        const apiToken = "activation-api-token-sentinel";
        const requested: Array<{
            method: string;
            path: string;
            authorization: string | null;
            body: unknown;
        }> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requested.push({
                    method: request.method,
                    path: new URL(request.url).pathname,
                    authorization: request.headers.get("authorization"),
                    body: await request.json(),
                });
                return Response.json({
                    success: true,
                    project_ref: "abc123",
                    slug: "public-hook",
                    previous_active_version: "0",
                    expected_activation_id: "legacy",
                    activation_id: COMMITTED_ACTIVATION_ID,
                    active_version: "6",
                    version: "6",
                    config: {
                        version: "6",
                        verify_jwt: false,
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                });
            },
        });
        servers.push(server);
        const commandArguments = [
            "edge_functions", "activate", "--ref", "abc123",
            "--slug", "public-hook", "--version", "6",
            "--expected-active-version", "0",
            "--expected-activation-id", "legacy",
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
            project_ref: "abc123",
            slug: "public-hook",
            previous_active_version: "0",
            active_version: "6",
            version: "6",
            verify_jwt: false,
            expected_activation_id: "legacy",
            activation_id: COMMITTED_ACTIVATION_ID,
        });
        expect(requested).toEqual([{
            method: "POST",
            path: "/v1/projects/abc123/functions/public-hook/versions/6/activate",
            authorization: `Bearer ${apiToken}`,
            body: {
                expected_active_version: "0",
                expected_activation_id: "legacy",
            },
        }]);
        expect(commandArguments.join("\0")).not.toContain(apiToken);
        expect(response.stdout + response.stderr).not.toContain(apiToken);
    });

    test("rejects public Function version zero before any HTTP request", async () => {
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
                "edge_functions", "activate", "--ref", "abc123", "--slug", "legacy-hook",
                "--version", "0", "--expected-active-version", "2",
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(response.stderr).toContain("Invalid arguments");
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
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2",
                "--expected-active-version", "1",
                "--expected-activation-id", EXPECTED_ACTIVATION_ID,
            ],
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
            [
                "edge_functions", "activate", "--ref", "abc123", "--slug", "hook", "--version", "2",
                "--expected-active-version", "1",
                "--expected-activation-id", EXPECTED_ACTIVATION_ID,
            ],
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
                "--expected-active-version", "1",
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
                "--expected-active-version", "1",
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

    test("gets, updates, and deletes a schedule with revision-bound receipts", async () => {
        const nextUpdatedAt = "2026-08-11T00:00:00.001Z";
        const requestedMethods: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestedMethods.push(request.method);
                const requestUrl = new URL(request.url);
                const schedule = {
                    id: SCHEDULE_ID,
                    name: "Nightly",
                    slug: "worker",
                    cron: "0 2 * * *",
                    method: "POST",
                    enabled: request.method === "PATCH" ? false : true,
                    body_empty: true,
                    header_names: [],
                    created_at: SCHEDULE_UPDATED_AT,
                    updated_at: request.method === "PATCH" ? nextUpdatedAt : SCHEDULE_UPDATED_AT,
                };
                if (request.method === "GET") {
                    return Response.json({ project_ref: "abc123", schedule });
                }
                if (request.method === "PATCH") {
                    const body = await request.json() as Record<string, unknown>;
                    return Response.json({
                        updated: true,
                        project_ref: "abc123",
                        request_id: body.request_id,
                        previous_updated_at: body.expected_updated_at,
                        schedule,
                    });
                }
                return Response.json({
                    deleted: true,
                    project_ref: "abc123",
                    schedule_id: SCHEDULE_ID,
                    deleted_updated_at: requestUrl.searchParams.get("expected_updated_at"),
                });
            },
        });
        servers.push(server);
        const environment = {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        };

        const getResponse = await runProjectCli([
            "scheduled_functions", "get", "--ref", "abc123", "--schedule_id", SCHEDULE_ID,
        ], environment);
        const updateResponse = await runProjectCli([
            "scheduled_functions", "update", "--ref", "abc123", "--schedule_id", SCHEDULE_ID,
            "--expected_updated_at", SCHEDULE_UPDATED_AT, "--enabled", "false",
        ], environment);
        const deleteResponse = await runProjectCli([
            "scheduled_functions", "delete", "--ref", "abc123", "--schedule_id", SCHEDULE_ID,
            "--expected_updated_at", nextUpdatedAt,
        ], environment);

        expect([getResponse.exitCode, updateResponse.exitCode, deleteResponse.exitCode]).toEqual([0, 0, 0]);
        expect(JSON.parse(getResponse.stdout).schedule.updated_at).toBe(SCHEDULE_UPDATED_AT);
        expect(JSON.parse(updateResponse.stdout)).toMatchObject({
            previous_updated_at: SCHEDULE_UPDATED_AT,
            schedule: { updated_at: nextUpdatedAt, enabled: false },
        });
        expect(JSON.parse(deleteResponse.stdout)).toMatchObject({
            deleted: true,
            deleted_updated_at: nextUpdatedAt,
        });
        expect(requestedMethods).toEqual(["GET", "PATCH", "DELETE"]);
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
            [
                "scheduled_functions", "delete", "--ref", "abc123", "--schedule_id", SCHEDULE_ID,
                "--expected_updated_at", SCHEDULE_UPDATED_AT,
            ],
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
                return Response.json({ code: "migration_baseline_rejected", secret: "baseline-response-secret" }, { status: 400 });
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
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "database.baseline_migrations",
            error: { code: "HTTP_ERROR", http_status: 400 },
        });
        expect(result.stdout + result.stderr).not.toContain("baseline-response-secret");
        expect(requestedPaths).toEqual([
            "/v1/projects/abc123/database/migrations",
            "/v1/projects/abc123/database/migrations/baseline",
        ]);
    });

    test("returns a non-zero secret-free direct migration failure", async () => {
        const responseSecret = "direct-migration-response-secret";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json({ message: responseSecret }, { status: 503 });
            },
        });
        servers.push(server);

        const result = await runProjectCli(
            ["database", "apply_migration", "--name", "safe_name", "--sql", "SELECT 1;"],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "database.apply_migration",
            error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
        });
        expect(result.stdout + result.stderr).not.toContain(responseSecret);
    });

    test("returns a non-zero secret-free migration push failure", async () => {
        const migrationRoot = mkdtempSync(join(tmpdir(), "supacloud-cli-push-"));
        temporaryDirectories.push(migrationRoot);
        writeFileSync(join(migrationRoot, "20260729090000_create_orders.sql"), "CREATE TABLE orders (id uuid);\n");
        const responseSecret = "migration-push-response-secret";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "GET") return Response.json([]);
                return Response.json({ message: responseSecret }, { status: 503 });
            },
        });
        servers.push(server);

        const result = await runProjectCli(
            ["database", "push_migrations", "--dir", migrationRoot],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "database.push_migrations",
            applied_before_failure: [],
            skipped_before_failure: [],
            failed_file: "20260729090000_create_orders.sql",
            error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
        });
        expect(result.stdout + result.stderr).not.toContain(responseSecret);
    });

    test("returns a non-zero machine-readable Auth failure without echoing config secrets", async () => {
        const configSecret = "auth-config-must-not-be-printed";
        let requestedBody = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestedBody = await request.text();
                return Response.json({
                    code: "AUTH_RUNTIME_APPLY_FAILED",
                    message: `runtime rejected ${configSecret}`,
                    persisted: true,
                    runtime_applied: false,
                    runtime_mode: "local",
                    echoed_config: configSecret,
                }, { status: 503 });
            },
        });
        servers.push(server);

        const response = await runProjectCli(
            [
                "auth", "update_config",
                "--ref", "abc123",
                "--config", JSON.stringify({ private_key: configSecret }),
            ],
            {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            },
        );

        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout)).toEqual({
            ok: false,
            http_status: 503,
            code: "AUTH_RUNTIME_APPLY_FAILED",
            persisted: true,
            runtime_applied: false,
            runtime_mode: "local",
        });
        expect(requestedBody).toContain(configSecret);
        expect(response.stdout + response.stderr).not.toContain(configSecret);
    });

    test("restores only the exact inventory-bound logical backup through the release CLI", async () => {
        const requests: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                requests.push({
                    method: request.method,
                    path: url.pathname,
                    body: request.method === "POST" ? await request.json() : null,
                    authorization: request.headers.get("authorization"),
                });
                if (request.method === "GET") return Response.json({ backups: [logicalBackup()] });
                return Response.json({ restored_backup: logicalBackup(), server_only: "do-not-echo" });
            },
        });
        servers.push(server);
        const apiToken = "release-management-token";

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: apiToken,
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "release.logical_backup.restore",
            project_ref: "abc123",
            backup: {
                backup_id: LOGICAL_BACKUP_ID,
                project_ref: "abc123",
                kind: "logical-full",
                created_at: "2026-08-17T12:00:00.000Z",
                completed_at: "2026-08-17T12:01:00.000Z",
                bytes: 128,
                sha256: LOGICAL_BACKUP_SHA256,
            },
        });
        expect(requests).toEqual([
            { method: "GET", path: "/v1/projects/abc123/database/backups/logical", body: null, authorization: `Bearer ${apiToken}` },
            {
                method: "POST",
                path: "/v1/projects/abc123/database/backups/logical/restore",
                body: {
                    backup_id: LOGICAL_BACKUP_ID,
                    expected_sha256: LOGICAL_BACKUP_SHA256,
                    confirmation: `RESTORE_PROJECT:abc123:${LOGICAL_BACKUP_ID}:${LOGICAL_BACKUP_SHA256}`,
                },
                authorization: `Bearer ${apiToken}`,
            },
            { method: "GET", path: "/v1/projects/abc123/database/backups/logical", body: null, authorization: `Bearer ${apiToken}` },
        ]);
        expect(result.stdout + result.stderr).not.toContain(apiToken);
        expect(result.stdout + result.stderr).not.toContain("do-not-echo");
    });

    test.each([
        ["missing backup ID", [
            "release", "logical_backup_restore", "--ref", "abc123",
            "--expected_sha256", LOGICAL_BACKUP_SHA256,
            "--restore_confirmation", `RESTORE_PROJECT:abc123:${LOGICAL_BACKUP_ID}:${LOGICAL_BACKUP_SHA256}`,
        ]],
        ["wrong-project backup ID", logicalBackupRestoreArguments({
            backup_id: "logical-full_other_0123456789abcdef0123456789abcdef",
        })],
        ["malformed SHA-256", logicalBackupRestoreArguments({ expected_sha256: "private-invalid-digest" })],
        ["mismatched restore confirmation", logicalBackupRestoreArguments({
            restore_confirmation: "private-invalid-confirmation",
        })],
    ])("rejects logical restore %s before inventory or mutation HTTP", async (_label, args) => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({ unexpected: true });
            },
        });
        servers.push(server);

        const result = await runProjectCli(args, {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(result.stdout + result.stderr).not.toContain("release-management-token");
        expect(result.stdout + result.stderr).not.toContain("private-invalid-digest");
        expect(result.stdout + result.stderr).not.toContain("private-invalid-confirmation");
    });

    test("rejects a valid-looking logical backup that is absent from the selected project inventory", async () => {
        let postCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "POST") postCount += 1;
                return Response.json({ backups: [logicalBackup({ sha256: "b".repeat(64) })] });
            },
        });
        servers.push(server);

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "release.logical_backup.restore",
            error: { code: "MUTATION_NOT_SUCCEEDED", http_status: null },
        });
        expect(postCount).toBe(0);
    });

    test("rejects malformed or cross-project logical inventory before restore HTTP", async () => {
        let postCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "POST") postCount += 1;
                return Response.json({
                    backups: [logicalBackup({
                        backup_id: "logical-full_other_0123456789abcdef0123456789abcdef",
                    })],
                });
            },
        });
        servers.push(server);

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "release.logical_backup.restore",
            error: { code: "INVALID_RESPONSE", http_status: 200 },
        });
        expect(postCount).toBe(0);
    });

    test.each([
        ["a response identity mismatch", logicalBackup({ sha256: "b".repeat(64) }), logicalBackup()],
        ["a post-restore inventory identity drift", logicalBackup(), logicalBackup({ sha256: "b".repeat(64) })],
    ])("reports OUTCOME_UNKNOWN for logical restore with %s", async (_label, restoredBackup, postRestoreBackup) => {
        let inventoryReads = 0;
        let postCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "POST") {
                    postCount += 1;
                    return Response.json({ restored_backup: restoredBackup, private_server_body: "do-not-echo" });
                }
                inventoryReads += 1;
                return Response.json({ backups: [inventoryReads === 1 ? logicalBackup() : postRestoreBackup] });
            },
        });
        servers.push(server);

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "release.logical_backup.restore",
            error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
        });
        expect([inventoryReads, postCount]).toEqual([2, 1]);
        expect(result.stdout + result.stderr).not.toContain("do-not-echo");
    });

    test.each([
        [409, "HTTP_ERROR"],
        [503, "OUTCOME_UNKNOWN"],
    ] as const)("returns the safe logical restore result for a mutation HTTP %d", async (status, code) => {
        let inventoryReads = 0;
        let postCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "POST") {
                    postCount += 1;
                    return Response.json({ private_server_body: "do-not-echo" }, { status });
                }
                inventoryReads += 1;
                return Response.json({ backups: [logicalBackup()] });
            },
        });
        servers.push(server);

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "release.logical_backup.restore",
            error: { code, http_status: status },
        });
        expect([inventoryReads, postCount]).toEqual([1, 1]);
        expect(result.stdout + result.stderr).not.toContain("do-not-echo");
    });

    test("treats an unreadable logical restore response as unknown without retrying", async () => {
        let inventoryReads = 0;
        let postCount = 0;
        const responseSecret = "private-unreadable-restore-response";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method === "POST") {
                    postCount += 1;
                    return new Response(`{\"private_server_body\":\"${responseSecret}`, {
                        headers: { "Content-Type": "application/json" },
                    });
                }
                inventoryReads += 1;
                return Response.json({ backups: [logicalBackup()] });
            },
        });
        servers.push(server);

        const result = await runProjectCli(logicalBackupRestoreArguments(), {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPACLOUD_API_TOKEN: "release-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "release.logical_backup.restore",
            error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
        });
        expect([inventoryReads, postCount]).toEqual([1, 1]);
        expect(result.stdout + result.stderr).not.toContain(responseSecret);
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

    test("status probes an application profile through the project data API without exposing its key", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-application-status-"));
        temporaryDirectories.push(workspace);
        const requestedPaths: string[] = [];
        const authorizationHeaders: Array<string | null> = [];
        const apiKeyHeaders: Array<string | null> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                authorizationHeaders.push(request.headers.get("authorization"));
                apiKeyHeaders.push(request.headers.get("apikey"));
                return request.headers.get("apikey") === "application-service-role"
                    ? Response.json({ openapi: "3.0.0" })
                    : Response.json({ error: "API key required" }, { status: 401 });
            },
        });
        servers.push(server);
        const environmentPath = join(workspace, "application.env");
        writeFileSync(environmentPath, [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_PROJECT_REF=abc123",
            `SUPABASE_URL=http://127.0.0.1:${server.port}`,
            "SUPABASE_SERVICE_ROLE_KEY=application-service-role",
        ].join("\n") + "\n");

        const result = await runProjectCli(["status", "--env-file=application.env"], {}, workspace);
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(status).toMatchObject({
            credentialScope: "project_application",
            apiUrl: `http://127.0.0.1:${server.port}`,
            hasApiToken: true,
            checks: {
                configuration: { ok: true, missing: [] },
                connectivity: { ok: true, reachable: true, httpStatus: 401 },
                authentication: { ok: true, httpStatus: 200 },
                project: { ok: true },
            },
        });
        expect(requestedPaths).toEqual(["/rest/v1/", "/rest/v1/"]);
        expect(authorizationHeaders).toEqual([null, "Bearer application-service-role"]);
        expect(apiKeyHeaders).toEqual([null, "application-service-role"]);
        expect(result.stdout + result.stderr).not.toContain("application-service-role");
    });

    test("release-canary stage replay uses the dual-bound service role and strict safe receipt", async () => {
        const serviceRoleKey = "application-service-role-private";
        const rpcRequests: Array<{
            path: string;
            authorization: string | null;
            apiKey: string | null;
            body: unknown;
        }> = [];
        const applicationServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                rpcRequests.push({
                    path: new URL(request.url).pathname,
                    authorization: request.headers.get("authorization"),
                    apiKey: request.headers.get("apikey"),
                    body: await request.json(),
                });
                return Response.json({
                    fixtureId: "11111111-1111-4111-8111-111111111111",
                    tenantKey: "release-canary-22222222-2222-4222-8222-222222222222",
                    state: "staged",
                    idempotent: true,
                });
            },
        });
        servers.push(applicationServer);
        const applicationOrigin = `http://127.0.0.1:${applicationServer.port}`;
        const managementRequests: string[] = [];
        const managementServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                managementRequests.push(new URL(request.url).pathname);
                return Response.json({
                    schema: "supacloud.project-endpoints.v1",
                    project_ref: "abc123",
                    endpoints: {
                        api: {
                            origin: applicationOrigin,
                            host: `127.0.0.1:${applicationServer.port}`,
                            scheme: "http",
                            source: "explicit_api_domain",
                            aliases: [],
                        },
                        auth: { origin: "https://auth.example.test", host: "auth.example.test", scheme: "https", source: "explicit_auth_domain", aliases: [] },
                        studio: { origin: "https://studio.example.test", host: "studio.example.test", scheme: "https", source: "explicit_studio_domain", aliases: [] },
                    },
                });
            },
        });
        servers.push(managementServer);
        const privateSubject = "33333333-3333-4333-8333-333333333333";
        const requestId = "44444444-4444-4444-8444-444444444444";
        const environment = {
            SUPACLOUD_ENV: "production",
            SUPACLOUD_API_URL: `http://127.0.0.1:${managementServer.port}`,
            SUPACLOUD_API_TOKEN: "management-private-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPABASE_URL: applicationOrigin,
            SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        };

        const blocked = await runProjectCli([
            "release", "release_canary_fixture_stage_replay", "--ref", "abc123",
            "--subject", privateSubject, "--request_id", requestId,
        ], environment);
        expect(blocked.exitCode).toBe(1);
        expect(rpcRequests).toHaveLength(0);

        const result = await runProjectCli([
            "release", "release_canary_fixture_stage_replay", "--ref", "abc123",
            "--subject", privateSubject, "--request_id", requestId,
            "--confirm-production", "abc123",
        ], environment);
        const receipt = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(receipt).toMatchObject({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "release.release_canary.fixture_stage_replay",
            project_ref: "abc123",
            receipt: { state: "staged", idempotent: true },
        });
        expect(rpcRequests).toEqual([{
            path: "/rest/v1/rpc/fa_release_canary_fixture_stage",
            authorization: `Bearer ${serviceRoleKey}`,
            apiKey: serviceRoleKey,
            body: { p_subject: privateSubject, p_request_id: requestId },
        }]);
        expect(managementRequests).toEqual([
            "/v1/projects/abc123/endpoint/projection",
            "/v1/projects/abc123/endpoint/projection",
        ]);
        expect(result.stdout + result.stderr).not.toContain(serviceRoleKey);
        expect(result.stdout + result.stderr).not.toContain("management-private-token");
        expect(result.stdout + result.stderr).not.toContain(privateSubject);
    });

    test("release-canary disable replay uses the dual-bound service role and pending readback", async () => {
        const serviceRoleKey = "application-service-role-disable-private";
        const fixtureId = "11111111-1111-4111-8111-111111111111";
        const disableRequestId = "55555555-5555-4555-8555-555555555555";
        const subject = "33333333-3333-4333-8333-333333333333";
        const issuer = "https://issuer.example.test/auth/v1";
        const applicationRequests: Array<{ path: string; method: string; authorization: string | null; apiKey: string | null; body: unknown }> = [];
        const applicationServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                applicationRequests.push({
                    path: `${url.pathname}${url.search}`,
                    method: request.method,
                    authorization: request.headers.get("authorization"),
                    apiKey: request.headers.get("apikey"),
                    body: request.method === "POST" ? await request.json() : null,
                });
                if (request.method === "POST") return Response.json({ fixtureId, state: "disabled", idempotent: false });
                return Response.json(false);
            },
        });
        servers.push(applicationServer);
        const applicationOrigin = `http://127.0.0.1:${applicationServer.port}`;
        const managementRequests: string[] = [];
        const managementServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                managementRequests.push(new URL(request.url).pathname);
                return Response.json({
                    schema: "supacloud.project-endpoints.v1",
                    project_ref: "abc123",
                    endpoints: {
                        api: { origin: applicationOrigin, host: `127.0.0.1:${applicationServer.port}`, scheme: "http", source: "explicit_api_domain", aliases: [] },
                        auth: { origin: "https://auth.example.test", host: "auth.example.test", scheme: "https", source: "explicit_auth_domain", aliases: [] },
                        studio: { origin: "https://studio.example.test", host: "studio.example.test", scheme: "https", source: "explicit_studio_domain", aliases: [] },
                    },
                });
            },
        });
        servers.push(managementServer);
        const environment = {
            SUPACLOUD_ENV: "production",
            SUPACLOUD_API_URL: `http://127.0.0.1:${managementServer.port}`,
            SUPACLOUD_API_TOKEN: "management-disable-private-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPABASE_URL: applicationOrigin,
            SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        };

        const blocked = await runProjectCli([
            "release", "release_canary_fixture_disable_replay", "--ref", "abc123",
            "--fixture_id", fixtureId, "--disable_request_id", disableRequestId,
            "--issuer", issuer, "--subject", subject,
        ], environment);
        expect(blocked.exitCode).toBe(1);
        expect(applicationRequests).toHaveLength(0);

        const result = await runProjectCli([
            "release", "release_canary_fixture_disable_replay", "--ref", "abc123",
            "--fixture_id", fixtureId, "--disable_request_id", disableRequestId,
            "--issuer", issuer, "--subject", subject, "--confirm-production", "abc123",
        ], environment);
        const receipt = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(receipt).toMatchObject({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "release.release_canary.fixture_disable_replay",
            project_ref: "abc123",
            receipt: { fixtureId, state: "disabled", idempotent: false },
            pending: false,
        });
        expect(applicationRequests).toEqual([
            {
                path: "/rest/v1/rpc/fa_release_canary_fixture_disable",
                method: "POST",
                authorization: `Bearer ${serviceRoleKey}`,
                apiKey: serviceRoleKey,
                body: { p_fixture_id: fixtureId, p_disable_request_id: disableRequestId, p_issuer: issuer, p_subject: subject },
            },
            {
                path: `/rest/v1/rpc/fa_release_canary_fixture_pending?p_issuer=https%3A%2F%2Fissuer.example.test%2Fauth%2Fv1&p_subject=${subject}`,
                method: "GET",
                authorization: `Bearer ${serviceRoleKey}`,
                apiKey: serviceRoleKey,
                body: null,
            },
        ]);
        expect(managementRequests).toEqual([
            "/v1/projects/abc123/endpoint/projection",
            "/v1/projects/abc123/endpoint/projection",
        ]);
        expect(result.stdout + result.stderr).not.toContain(serviceRoleKey);
        expect(result.stdout + result.stderr).not.toContain("management-disable-private-token");
        expect(result.stdout + result.stderr).not.toContain(issuer);
        expect(result.stdout + result.stderr).not.toContain(subject);
    });

    test.each([["401", 401], ["403", 403]] as const)(
        "status reports application credential rejection %s without reflecting the key",
        async (_statusLabel, rejectionStatus) => {
            const requestHeaders: Array<[string | null, string | null]> = [];
            const server = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request) {
                    requestHeaders.push([
                        request.headers.get("authorization"),
                        request.headers.get("apikey"),
                    ]);
                    return Response.json({ error: "Invalid API key" }, { status: rejectionStatus });
                },
            });
            servers.push(server);

            const result = await runProjectCli(["status"], {
                SUPABASE_URL: `http://127.0.0.1:${server.port}`,
                SUPABASE_SERVICE_ROLE_KEY: "rejected-service-role",
                SUPACLOUD_PROJECT_REF: "abc123",
            });
            const status = JSON.parse(result.stdout);

            expect(result.exitCode).toBe(1);
            expect(status.checks.connectivity).toMatchObject({ ok: true, httpStatus: rejectionStatus });
            expect(status.checks.authentication).toEqual({ ok: false, httpStatus: rejectionStatus });
            expect(requestHeaders).toEqual([
                [null, null],
                ["Bearer rejected-service-role", "rejected-service-role"],
            ]);
            expect(result.stdout + result.stderr).not.toContain("rejected-service-role");
        },
    );

    test("Management writes reject redirects without forwarding credentials or request bodies", async () => {
        const targetRequests: Array<{ authorization: string | null; body: string }> = [];
        const redirectTarget = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                targetRequests.push({
                    authorization: request.headers.get("authorization"),
                    body: await request.text(),
                });
                return Response.json({ configured: true });
            },
        });
        servers.push(redirectTarget);
        let sourceBody = "";
        const source = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                sourceBody = await request.text();
                return Response.redirect(`http://127.0.0.1:${redirectTarget.port}/captured`, 307);
            },
        });
        servers.push(source);

        const response = await runProjectCli([
            "auth", "configure_provider", "--ref", "abc123", "--provider", "github",
            "--client_id", "redirect-client-id", "--client_secret", "redirect-client-secret",
        ], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${source.port}`,
            SUPACLOUD_API_TOKEN: "redirect-management-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(response.exitCode).toBe(1);
        expect(sourceBody).toContain("redirect-client-secret");
        expect(targetRequests).toEqual([]);
        expect(response.stdout + response.stderr).not.toContain("redirect-client-id");
        expect(response.stdout + response.stderr).not.toContain("redirect-client-secret");
        expect(response.stdout + response.stderr).not.toContain("redirect-management-token");
    });

    test("status rejects a missing application data endpoint before sending credentials", async () => {
        const authorizationHeaders: Array<string | null> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                authorizationHeaders.push(request.headers.get("authorization"));
                return Response.json({ error: "Not found" }, { status: 404 });
            },
        });
        servers.push(server);

        const result = await runProjectCli(["status"], {
            SUPABASE_URL: `http://127.0.0.1:${server.port}`,
            SUPABASE_SERVICE_ROLE_KEY: "application-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.checks.connectivity).toMatchObject({ ok: false, reachable: true, httpStatus: 404 });
        expect(status.checks.authentication.ok).toBeNull();
        expect(authorizationHeaders).toEqual([null]);
        expect(result.stdout + result.stderr).not.toContain("application-service-role");
    });

    test("status refuses credential-bearing redirects from the application data origin", async () => {
        const redirectedHeaders: Array<[string | null, string | null]> = [];
        const redirectTarget = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                redirectedHeaders.push([
                    request.headers.get("authorization"),
                    request.headers.get("apikey"),
                ]);
                return Response.json({ openapi: "3.0.0" });
            },
        });
        servers.push(redirectTarget);
        const sourceHeaders: Array<[string | null, string | null]> = [];
        const source = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const headers: [string | null, string | null] = [
                    request.headers.get("authorization"),
                    request.headers.get("apikey"),
                ];
                sourceHeaders.push(headers);
                return headers[1]
                    ? Response.redirect(`http://127.0.0.1:${redirectTarget.port}/captured`, 302)
                    : Response.json({ error: "API key required" }, { status: 401 });
            },
        });
        servers.push(source);

        const result = await runProjectCli(["status"], {
            SUPABASE_URL: `http://127.0.0.1:${source.port}`,
            SUPABASE_SERVICE_ROLE_KEY: "redirect-private-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.checks.authentication).toEqual({ ok: false, httpStatus: null });
        expect(sourceHeaders).toEqual([
            [null, null],
            ["Bearer redirect-private-service-role", "redirect-private-service-role"],
        ]);
        expect(redirectedHeaders).toEqual([]);
        expect(result.stdout + result.stderr).not.toContain("redirect-private-service-role");
    });

    test("never substitutes an application key for a missing Management token", async () => {
        const authorizationHeaders: Array<string | null> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                authorizationHeaders.push(request.headers.get("authorization"));
                return Response.json({ healthy: true });
            },
        });
        servers.push(server);

        const result = await runProjectCli(["status"], {
            SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
            SUPABASE_SERVICE_ROLE_KEY: "application-only-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.credentialScope).toBe("management");
        expect(status.checks.configuration).toEqual({ ok: false, missing: ["apiToken"] });
        expect(status.checks.authentication.ok).toBeNull();
        expect(authorizationHeaders).toEqual([null]);
        expect(result.stdout + result.stderr).not.toContain("application-only-service-role");
    });

    test.each([
        ["project", "health"],
        ["release", "logical_backup_create"],
    ])("blocks %s %s for pure application profiles before HTTP", async (moduleName, action) => {
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({ unexpected: true });
            },
        });
        servers.push(server);

        const result = await runProjectCli([moduleName, action], {
            SUPABASE_URL: `http://127.0.0.1:${server.port}`,
            SUPABASE_SERVICE_ROLE_KEY: "application-only-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        });

        expect(result.exitCode).toBe(1);
        expect(requestCount).toBe(0);
        expect(result.stdout + result.stderr).toContain("Management API context");
        expect(result.stdout + result.stderr).not.toContain("application-only-service-role");
    });

    test.each([
        "http://management.example.test",
        "https://user:private-password@management.example.test",
        "https://management.example.test/private-path",
        "https://management.example.test/%2e",
        "https://management.example.test?token=private-query",
        "https://management.example.test#private-fragment",
        "https://management.example.test:443",
        "https://management.example.test:443/",
        "http://127.0.0.1:80",
        "http://127.0.0.1:80/",
    ])("status rejects unsafe Management origin %s without reflection", async (managementUrl) => {
        const result = await runProjectCli(["status"], {
            SUPACLOUD_API_URL: managementUrl,
            SUPACLOUD_API_TOKEN: "management-private-token",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.credentialScope).toBe("management");
        expect(status.apiUrl).toBeNull();
        expect(status.checks.configuration.missing).toEqual(["apiUrl"]);
        expect(status.checks.connectivity.ok).toBeNull();
        expect(status.checks.authentication.ok).toBeNull();
        expect(result.stdout + result.stderr).not.toContain("management-private-token");
        expect(result.stdout + result.stderr).not.toContain("private-password");
        expect(result.stdout + result.stderr).not.toContain("private-path");
        expect(result.stdout + result.stderr).not.toContain("private-query");
        expect(result.stdout + result.stderr).not.toContain("private-fragment");
    });

    test.each([
        "http://api.example.test",
        "https://api.example.test/untrusted-path",
        "https://api.example.test/%2e",
        "https://user:password@api.example.test",
        "https://api.example.test:443",
        "https://api.example.test:443/",
        "http://127.0.0.1:80",
        "http://127.0.0.1:80/",
    ])("status rejects unsafe application origin %s before sending credentials", async (supabaseUrl) => {
        const result = await runProjectCli(["status"], {
            SUPABASE_URL: supabaseUrl,
            SUPABASE_SERVICE_ROLE_KEY: "application-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        });
        const status = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(1);
        expect(status.apiUrl).toBeNull();
        expect(status.checks.configuration).toEqual({
            ok: false,
            missing: ["secureSupabaseUrl"],
        });
        expect(status.checks.connectivity.ok).toBeNull();
        expect(status.checks.authentication.ok).toBeNull();
        expect(result.stdout + result.stderr).not.toContain("application-service-role");
    });

    test.each(["pending", "outcome_unknown"] as const)(
        "mutation status exits non-zero for durable %s state",
        async (mutationStatus) => {
            const requestedPaths: string[] = [];
            const server = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request) {
                    requestedPaths.push(new URL(request.url).pathname);
                    return Response.json({
                        project_ref: "abc123",
                        mutation: {
                            project_ref: "abc123",
                            mutation_id: SCHEDULE_ID,
                            operation: "scheduled_functions.create",
                            resource_key: null,
                            request_fingerprint: "a".repeat(64),
                            principal: { type: "project", id: "project:abc123" },
                            status: mutationStatus,
                            checkpoint: {},
                            receipt: mutationStatus === "outcome_unknown" ? {} : null,
                            response_status: null,
                            failure_code: mutationStatus === "outcome_unknown"
                                ? "PROVIDER_OUTCOME_UNKNOWN"
                                : null,
                            lease: { owner: null, expires_at: null, fencing_epoch: 0 },
                            completed_at: mutationStatus === "outcome_unknown"
                                ? "2026-08-12T00:00:00.000Z"
                                : null,
                            created_at: "2026-08-12T00:00:00.000Z",
                            updated_at: "2026-08-12T00:00:00.000Z",
                        },
                    });
                },
            });
            servers.push(server);

            const response = await runProjectCli([
                "mutations", "status", "--ref", "abc123", "--mutation_id", SCHEDULE_ID,
            ], {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
                SUPACLOUD_PROJECT_REF: "abc123",
            });
            const payload = JSON.parse(response.stdout);

            expect(response.exitCode).toBe(1);
            expect(requestedPaths).toEqual([`/v1/projects/abc123/mutations/${SCHEDULE_ID}`]);
            expect(payload).toMatchObject({
                ok: false,
                operation: "mutations.status",
                mutation: { mutation_id: SCHEDULE_ID, status: mutationStatus },
                error: { code: "MUTATION_NOT_SUCCEEDED", http_status: null },
            });
            expect(response.stdout).not.toMatch(/"ok"\s*:\s*true/);
        },
    );
});
