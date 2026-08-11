import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdminTools } from "./index";
import { cliToolResultIsError, formatCliError } from "./shared/cli";
import { schemaEnumValues } from "./shared/schema";
import packageMetadata from "../package.json" with { type: "json" };

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADMIN_ENTRYPOINT = join(PACKAGE_ROOT, "src/index.ts");
const ADMIN_CONTEXT_KEYS = new Set([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
    "SUPACLOUD_SSH_KEY",
    "SUPACLOUD_SSH_PASS",
    "SUPACLOUD_SSH_HOST_FINGERPRINT",
    "SUPACLOUD_SSH_USER",
    "SUPACLOUD_SSH_PORT",
    "SUPACLOUD_ENV",
    "SUPACLOUD_READ_ONLY",
]);

const EXISTING_PHYSICAL_BACKUP = {
    id: "20260811-010000F",
    type: "full",
    timestamp: { start: 1_786_400_000, stop: 1_786_400_030 },
    size: 4096,
    database: "supa_fa_staging",
};

const COMPLETED_PHYSICAL_BACKUP = {
    id: "20260811-020000F",
    type: "full",
    timestamp: { start: 1_786_403_600, stop: 1_786_403_660 },
    size: 8192,
    database: "supa_fa_staging",
};

function cleanEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !ADMIN_CONTEXT_KEYS.has(key)) env[key] = value;
    }
    return { ...env, ...overrides };
}

async function runAdminCli(
    args: string[],
    overrides: Record<string, string> = {},
    workingDirectory: string = PACKAGE_ROOT,
): Promise<{ exitCode: number; output: string }> {
    const processHandle = Bun.spawn([process.execPath, ADMIN_ENTRYPOINT, ...args], {
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
    return { exitCode, output: stdout + stderr };
}

async function runAdminCliPath(entryPath: string, args: string[]): Promise<{ exitCode: number; output: string }> {
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
    return { exitCode, output: stdout + stderr };
}

async function runAggregateFailureCli(): Promise<{ exitCode: number; output: string }> {
    const source = [
        'import { Type } from "@sinclair/typebox";',
        'import { runCli } from "./src/shared/cli.ts";',
        'const tools = { fixture: {',
        '  schema: { action: Type.Literal("run") },',
        '  callback: async () => { throw new AggregateError([',
        '    new Error("Remote upgrade failed (exit 42): transaction failed DATABASE_URL=postgresql://admin:database-password@localhost/db"),',
        '    new Error("Failed to remove remote upgrade helper: permission denied"),',
        '  ], "Remote upgrade failed and helper cleanup did not complete"); },',
        '} };',
        'await runCli(tools, ["fixture", "run"], { commandName: "fixture-cli" });',
    ].join("\n");
    const processHandle = Bun.spawn([process.execPath, "-e", source], {
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
    return { exitCode, output: stdout + stderr };
}

function studioProcessInventory(): Array<Record<string, unknown>> {
    return [
        { id: "db", name: "db", status: "ACTIVE_HEALTHY", healthy: true, service_host_ids: ["project-ref-db"] },
        { id: "rest", name: "rest", status: "COMING_UP", healthy: false, service_host_ids: ["project-ref-rest"] },
        { id: "auth", name: "auth", status: "INACTIVE", healthy: false, service_host_ids: ["owner-ref-auth"] },
        { id: "realtime", name: "realtime", status: "UNHEALTHY", healthy: false, service_host_ids: ["project-ref-realtime"] },
        { id: "storage", name: "storage", status: "ACTIVE_HEALTHY", healthy: true, service_host_ids: ["project-ref-storage"] },
    ];
}

function inventoryWithField(fieldName: string, fieldValue: unknown): Array<Record<string, unknown>> {
    const inventory = studioProcessInventory();
    inventory[0] = { ...inventory[0], [fieldName]: fieldValue };
    return inventory;
}

function invalidProcessInventories(secretMarker: string, oversizedMarker: string): unknown[] {
    const duplicate = studioProcessInventory();
    duplicate[4] = { ...duplicate[0] };
    const badStatus = studioProcessInventory();
    badStatus[1] = { ...badStatus[1], status: "INACTIVE" };
    const healthyMismatch = studioProcessInventory();
    healthyMismatch[0] = { ...healthyMismatch[0], healthy: false };
    const multipleHostIds = studioProcessInventory();
    multipleHostIds[2] = { ...multipleHostIds[2], service_host_ids: ["owner-ref-auth", "project-ref-auth"] };
    const oversizedInventory = Array.from({ length: 256 }, () => ({
        id: oversizedMarker, name: oversizedMarker, status: oversizedMarker,
        healthy: false, service_host_ids: [oversizedMarker],
    }));
    return [
        inventoryWithField("id", secretMarker), inventoryWithField("name", secretMarker),
        inventoryWithField("status", secretMarker), inventoryWithField("service_host_ids", [secretMarker]),
        oversizedInventory, duplicate, studioProcessInventory().slice(0, 4),
        badStatus, healthyMismatch, multipleHostIds,
    ];
}

const baseContext = {
    host: "server.example.com",
    sshUser: "root",
    sshPort: 22,
    sshKey: "",
    sshPass: "secret-password",
    sshHostFingerprint: "",
    apiUrl: "https://studio.example.com",
    apiToken: "api-token",
    projectRef: "",
    readOnly: false,
    environment: "",
    production: false,
    inferredSupabaseUrl: "",
    inferredServiceRoleKey: "",
    source: "process_env" as const,
    sourcePath: null,
};

describe("admin SSH registration gate", () => {
    test("keeps the versions action in the disabled SSH schema", () => {
        const tools = createAdminTools(baseContext);

        expect(schemaEnumValues(tools.ssh.schema.action)).toContain("versions");
    });

    test("does not register executable SSH tools without a verified host fingerprint", () => {
        const tools = createAdminTools(baseContext);
        expect(tools.project.schema.name).toBeDefined();
        expect(tools.ssh.schema.command).toBeDefined();
        return tools.ssh.callback({ action: "ping" }).then((result) => {
            expect(result.content[0]?.text).toContain("SUPACLOUD_SSH_HOST_FINGERPRINT");
        });
    });

    test("registers SSH tools only when the fingerprint is configured", () => {
        const tools = createAdminTools({
            ...baseContext,
            sshHostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
        expect(tools.ssh.schema.command).toBeDefined();
    });
});

describe("supacloud-admin process contract", () => {
    test("classifies explicit tool errors without requiring content", () => {
        expect(cliToolResultIsError({ isError: true })).toBe(true);
        expect(cliToolResultIsError({})).toBe(false);
    });

    test("prints the exact package version", async () => {
        const execution = await runAdminCli(["--version"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output.trim()).toBe(packageMetadata.version);
    });

    test("documents environment selection and production confirmation", async () => {
        const execution = await runAdminCli(["--help"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output).toContain("--env <name>");
        expect(execution.output).toContain("--env-file <path>");
        expect(execution.output).toContain("--confirm-production <target>");
        expect(execution.output).toContain("SUPACLOUD_READ_ONLY=true");
        expect(execution.output).toContain("platform:<API host>");
        expect(execution.output).toContain("host:<SSH host[:port]>");
    });

    test("runs through an npm-style bin symlink", async () => {
        const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: PACKAGE_ROOT });
        expect(build.exitCode).toBe(0);
        const sandbox = mkdtempSync(join(tmpdir(), "supacloud-admin-bin-"));
        const binDir = join(sandbox, "node_modules/.bin");
        mkdirSync(binDir, { recursive: true });
        const linkedEntry = join(binDir, "supacloud-admin");
        symlinkSync(join(PACKAGE_ROOT, "dist/index.js"), linkedEntry);
        try {
            const result = await runAdminCliPath(linkedEntry, ["--help"]);
            expect(result.exitCode).toBe(0);
            expect(result.output).toContain("Platform administration CLI");
            const backupHelp = await runAdminCliPath(linkedEntry, ["platform", "create_backup", "--help"]);
            expect(backupHelp.exitCode).toBe(0);
            expect(backupHelp.output).toContain("--ref");
            expect(backupHelp.output).toContain("--backup_type");
            const version = await runAdminCliPath(linkedEntry, ["--version"]);
            expect(version.exitCode).toBe(0);
            expect(version.output.trim()).toBe(packageMetadata.version);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    test("build output bundles the shared release-manifest contract", async () => {
        const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: PACKAGE_ROOT });
        expect(build.exitCode).toBe(0);
        const sandbox = mkdtempSync(join(tmpdir(), "supacloud-admin-standalone-dist-"));
        const isolatedEntry = join(sandbox, "supacloud-admin");
        copyFileSync(join(PACKAGE_ROOT, "dist/index.js"), isolatedEntry);
        chmodSync(isolatedEntry, 0o755);
        try {
            const execution = await runAdminCliPath(isolatedEntry, ["--version"]);
            expect(execution.exitCode).toBe(0);
            expect(execution.output.trim()).toBe(packageMetadata.version);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    test("loads one named environment source and keeps status secret-free", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-named-env-"));
        const environmentPath = join(workspace, ".env.supacloud.test");
        writeFileSync(environmentPath, [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_API_URL=https://management.test.example.com",
            "SUPACLOUD_API_TOKEN=file-secret-token",
            "SUPACLOUD_PROJECT_REF=test-ref",
        ].join("\n") + "\n");

        try {
            const execution = await runAdminCli(["status", "--env=test"], {
                SUPACLOUD_API_TOKEN: "process-secret-token",
            }, workspace);
            const status = JSON.parse(execution.output);

            expect(execution.exitCode).toBe(0);
            expect(status).toMatchObject({
                environment: "test",
                production: false,
                readOnly: false,
                source: { kind: "named_env_file", path: realpathSync(environmentPath) },
                apiUrl: "https://management.test.example.com",
                hasApiToken: true,
            });
            expect(execution.output).not.toContain("file-secret-token");
            expect(execution.output).not.toContain("process-secret-token");
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("rejects a generated project env file before registering Admin HTTP tools", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-project-env-source-"));
        const envFile = join(workspace, ".env.project-credentials.test");
        const serviceRoleKey = "project-service-role-secret";
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json([]);
            },
        });
        writeFileSync(envFile, [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_PROJECT_REF=abcdefghijklmnopqrst",
            `SUPABASE_URL=http://127.0.0.1:${server.port}`,
            `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
            "",
        ].join("\n"));

        try {
            const execution = await runAdminCli([
                "project", "list", "--env-file", envFile,
            ], {}, workspace);

            expect(execution.exitCode).not.toBe(0);
            expect(execution.output).toContain("cannot be used as a SupaCloud Admin profile");
            expect(execution.output).not.toContain(serviceRoleKey);
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("requires exact production project confirmation before HTTP and rejects cross-ref writes", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-production-project-"));
        const requestedPaths: string[] = [];
        const authorizationHeaders: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                requestedPaths.push(new URL(request.url).pathname);
                authorizationHeaders.push(request.headers.get("authorization") || "");
                return Response.json({ deleted: true });
            },
        });
        writeFileSync(join(workspace, ".env.supacloud.production"), [
            "SUPACLOUD_ENV=production",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=file-production-token",
            "SUPACLOUD_PROJECT_REF=prod-ref",
        ].join("\n") + "\n");

        try {
            const unconfirmed = await runAdminCli([
                "project", "delete", "--ref", "prod-ref", "--env", "production",
            ], { SUPACLOUD_API_TOKEN: "process-production-token" }, workspace);
            const crossRef = await runAdminCli([
                "project", "delete", "--ref", "other-ref", "--env=production",
                "--confirm-production", "other-ref",
            ], {}, workspace);
            const confirmed = await runAdminCli([
                "--confirm-production=prod-ref", "project", "delete", "--ref", "prod-ref",
                "--env", "production",
            ], {}, workspace);

            expect(unconfirmed.exitCode).toBe(1);
            expect(unconfirmed.output).toContain("--confirm-production prod-ref");
            expect(crossRef.exitCode).toBe(1);
            expect(crossRef.output).toContain("different project ref");
            expect(confirmed.exitCode).toBe(0);
            expect(requestedPaths).toEqual(["/v1/projects/prod-ref"]);
            expect(authorizationHeaders).toEqual(["Bearer file-production-token"]);
            for (const execution of [unconfirmed, crossRef, confirmed]) {
                expect(execution.output).not.toContain("file-production-token");
                expect(execution.output).not.toContain("process-production-token");
            }
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("blocks read-only writes before HTTP without reflecting credentials", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-read-only-"));
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({});
            },
        });
        writeFileSync(join(workspace, ".env.supacloud.audit"), [
            "SUPACLOUD_ENV=audit",
            "SUPACLOUD_READ_ONLY=true",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=read-only-secret-token",
            "SUPACLOUD_PROJECT_REF=audit-ref",
        ].join("\n") + "\n");

        try {
            const execution = await runAdminCli([
                "project", "delete", "--ref", "audit-ref", "--env", "audit",
            ], {}, workspace);

            expect(execution.exitCode).toBe(1);
            expect(execution.output).toContain("SUPACLOUD_READ_ONLY=true");
            expect(execution.output).not.toContain("read-only-secret-token");
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("keeps a process read-only guard when a named profile is selected", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-process-read-only-"));
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({});
            },
        });
        writeFileSync(join(workspace, ".env.supacloud.test"), [
            "SUPACLOUD_ENV=test",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=profile-secret-token",
            "SUPACLOUD_PROJECT_REF=test-ref",
        ].join("\n") + "\n");

        try {
            const execution = await runAdminCli([
                "project", "delete", "--ref", "test-ref", "--env", "test",
            ], { SUPACLOUD_READ_ONLY: "true" }, workspace);

            expect(execution.exitCode).toBe(1);
            expect(execution.output).toContain("SUPACLOUD_READ_ONLY=true");
            expect(execution.output).not.toContain("profile-secret-token");
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("rejects unclassified process and legacy dotenv writes before HTTP", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-unclassified-write-"));
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({});
            },
        });
        writeFileSync(join(workspace, ".env"), [
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=legacy-secret-token",
            "SUPACLOUD_PROJECT_REF=legacy-ref",
        ].join("\n") + "\n");

        try {
            const processContext = await runAdminCli([
                "project", "delete", "--ref", "process-ref",
            ], {
                SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "process-secret-token",
            }, workspace);
            const legacyContext = await runAdminCli([
                "project", "delete", "--ref", "legacy-ref",
            ], {}, workspace);

            for (const execution of [processContext, legacyContext]) {
                expect(execution.exitCode).toBe(1);
                expect(execution.output).toContain("requires an explicit SUPACLOUD_ENV");
                expect(execution.output).not.toContain("process-secret-token");
                expect(execution.output).not.toContain("legacy-secret-token");
            }
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("rejects API URL query strings and fragments without reflecting them in status or help", async () => {
        for (const apiUrl of [
            "https://management.example.com/?query-secret",
            "https://management.example.com/#fragment-secret",
        ]) {
            const [status, help] = await Promise.all([
                runAdminCli(["status"], {
                    SUPACLOUD_API_URL: apiUrl,
                    SUPACLOUD_API_TOKEN: "api-secret-token",
                }),
                runAdminCli(["--help"], {
                    SUPACLOUD_API_URL: apiUrl,
                    SUPACLOUD_API_TOKEN: "api-secret-token",
                }),
            ]);

            expect(status.exitCode).toBe(0);
            expect(JSON.parse(status.output)).toMatchObject({ apiUrl: null, hasApiToken: true });
            expect(help.exitCode).toBe(0);
            for (const execution of [status, help]) {
                expect(execution.output).not.toContain("query-secret");
                expect(execution.output).not.toContain("fragment-secret");
                expect(execution.output).not.toContain("api-secret-token");
            }
        }
    });

    test("binds ref-less production writes to the exact API host", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-production-platform-"));
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({
                    ref: "abcdefghijklmnopqrst",
                    api: { url: "https://abcdefghijklmnopqrst.api.example.test" },
                }, { status: 201 });
            },
        });
        writeFileSync(join(workspace, ".env.supacloud.production"), [
            "SUPACLOUD_ENV=production",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=platform-production-token",
        ].join("\n") + "\n");
        const confirmationTarget = `platform:127.0.0.1:${server.port}`;

        try {
            const unconfirmed = await runAdminCli([
                "project", "create", "--name", "staging", "--env", "production",
            ], {}, workspace);
            const genericConfirmation = await runAdminCli([
                "project", "create", "--name", "staging", "--env", "production",
                "--confirm-production", "production",
            ], {}, workspace);
            const confirmed = await runAdminCli([
                "project", "create", "--name", "staging", "--env", "production",
                "--confirm-production", confirmationTarget,
            ], {}, workspace);

            expect(unconfirmed.exitCode).toBe(1);
            expect(unconfirmed.output).toContain(`--confirm-production ${confirmationTarget}`);
            expect(genericConfirmation.exitCode).toBe(1);
            expect(confirmed.exitCode).toBe(0);
            expect(requestCount).toBe(1);
            for (const execution of [unconfirmed, genericConfirmation, confirmed]) {
                expect(execution.output).not.toContain("platform-production-token");
            }
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("returns a non-zero exit code when a project command has no API context", async () => {
        const result = await runAdminCli(["project", "list"]);

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN");
    });

    test("returns a non-zero exit code when a shortcut command reports failure text", async () => {
        const execution = await runAdminCli(["project"], {
            SUPACLOUD_API_URL: "http://127.0.0.1:1",
            SUPACLOUD_API_TOKEN: "test-token",
        });

        expect(execution.exitCode).toBe(1);
        expect(execution.output).toContain("❌ Unknown action: undefined");
        expect(execution.output).not.toContain("test-token");
    });

    test("documents every project create domain flag without API context", async () => {
        const execution = await runAdminCli(["project", "create", "--help"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output).toContain("--domain");
        expect(execution.output).toContain("--api_domain");
        expect(execution.output).toContain("--auth_domain");
        expect(execution.output).toContain("--studio_domain");
        expect(execution.output).toContain("--env_file");
        expect(execution.output).toContain("--environment");
    });

    test("documents every physical backup flag without API context", async () => {
        const execution = await runAdminCli(["platform", "create_backup", "--help"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output).toContain("--ref");
        expect(execution.output).toContain("--backup_type");
    });

    test("creates a full backup with a sanitized machine-readable receipt", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown }> = [];
        let inventoryRead = 0;
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (request.method === "POST") {
                    const body = await request.json();
                    calls.push({ method: request.method, path, body });
                    return Response.json({
                        message: "full backup completed",
                        token: "successful-mutation-secret",
                    });
                }
                calls.push({ method: request.method, path });
                inventoryRead += 1;
                return Response.json(inventoryRead === 1
                    ? [EXISTING_PHYSICAL_BACKUP]
                    : [EXISTING_PHYSICAL_BACKUP, {
                        ...COMPLETED_PHYSICAL_BACKUP,
                        secret: "inventory-secret",
                    }]);
            },
        });
        const fixtureToken = "backup-api-token";

        try {
            const execution = await runAdminCli([
                "platform", "create_backup", "--ref", "fa_staging", "--backup_type", "full",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: fixtureToken,
            });

            expect(execution.exitCode).toBe(0);
            expect(JSON.parse(execution.output)).toEqual({
                project_ref: "fa_staging",
                requested_type: "full",
                backup: COMPLETED_PHYSICAL_BACKUP,
            });
            expect(calls).toEqual([
                { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
                {
                    method: "POST",
                    path: "/v1/projects/fa_staging/database/backups",
                    body: { type: "full" },
                },
                { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
            ]);
            expect(execution.output).not.toContain(fixtureToken);
            expect(execution.output).not.toContain("successful-mutation-secret");
            expect(execution.output).not.toContain("inventory-secret");
        } finally {
            apiServer.stop(true);
        }
    });

    test("exits nonzero after reconciling an uncertain backup mutation", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown }> = [];
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (request.method === "POST") {
                    const body = await request.json();
                    calls.push({ method: request.method, path, body });
                    return Response.json({
                        message: "remote failure detail",
                        token: "failed-mutation-secret",
                    }, { status: 503 });
                }
                calls.push({ method: request.method, path });
                return Response.json([EXISTING_PHYSICAL_BACKUP]);
            },
        });
        const fixtureToken = "failed-backup-api-token";

        try {
            const execution = await runAdminCli([
                "platform", "create_backup", "--ref", "fa_staging", "--backup_type", "full",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: fixtureToken,
            });

            expect(execution.exitCode).toBe(1);
            expect(JSON.parse(execution.output).error).toEqual({
                code: "OUTCOME_UNKNOWN",
                http_status: 503,
            });
            expect(calls).toEqual([
                { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
                {
                    method: "POST",
                    path: "/v1/projects/fa_staging/database/backups",
                    body: { type: "full" },
                },
                { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
            ]);
            expect(execution.output).not.toContain(fixtureToken);
            expect(execution.output).not.toContain("remote failure detail");
            expect(execution.output).not.toContain("failed-mutation-secret");
        } finally {
            apiServer.stop(true);
        }
    });

    test("documents constrained project service control without credential flags", async () => {
        const execution = await runAdminCli(["project", "service_control", "--help"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output).toContain("--ref");
        expect(execution.output).toContain("--service");
        expect(execution.output).toContain("--service_action");
        expect(execution.output).not.toContain("--token");
    });

    test("returns non-zero when service control reports HTTP 200 with success false", async () => {
        let authorizationHeader = "";
        let requestMethod = "";
        let requestedPath = "";
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                authorizationHeader = request.headers.get("authorization") || "";
                requestMethod = request.method;
                requestedPath = requestUrl.pathname;
                return Response.json({
                    service: "gotrue",
                    action: "stop",
                    success: false,
                    message: "remote service failure text",
                    token: "remote-response-token",
                    secret: "remote-response-secret",
                    Authorization: "Bearer remote-response-authorization",
                    project_ref: "hidden-project-ref",
                });
            },
        });
        const fixtureToken = "dummy-supacloud-api-token";

        try {
            const execution = await runAdminCli([
                "project", "service_control",
                "--ref", "project-ref",
                "--service", "gotrue",
                "--service_action", "stop",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: fixtureToken,
            });

            expect(execution.exitCode).toBe(1);
            expect(requestMethod).toBe("POST");
            expect(requestedPath).toBe("/v1/projects/project-ref/services/gotrue/stop");
            expect(authorizationHeader).toBe(`Bearer ${fixtureToken}`);
            expect(execution.output).toContain("Project service control failed");
            expect(execution.output).not.toContain(fixtureToken);
            expect(execution.output).not.toContain("remote service failure text");
            expect(execution.output).not.toContain("remote-response-token");
            expect(execution.output).not.toContain("remote-response-secret");
            expect(execution.output).not.toContain("remote-response-authorization");
            expect(execution.output).not.toContain("hidden-project-ref");
        } finally {
            apiServer.stop(true);
        }
    });

    test("returns non-zero for every invalid service inventory without reflection", async () => {
        const secretMarker = "process-inventory-secret";
        const oversizedMarker = "oversized-process-secret-".repeat(48);
        const invalidInventories = invalidProcessInventories(secretMarker, oversizedMarker);
        let responseIndex = 0;
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json(invalidInventories[responseIndex++]);
            },
        });

        try {
            for (const _inventory of invalidInventories) {
                const execution = await runAdminCli(["project", "services", "--ref", "project-ref"], {
                    SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                    SUPACLOUD_API_TOKEN: "test-token",
                });
                expect(execution.exitCode).toBe(1);
                expect(execution.output.trim()).toBe("❌ Project service inventory response is invalid");
                expect(execution.output).not.toContain(secretMarker);
                expect(execution.output).not.toContain(oversizedMarker);
            }
            expect(responseIndex).toBe(invalidInventories.length);
        } finally {
            apiServer.stop(true);
        }
    });

    test("returns non-zero without reflecting a service control HTTP error body", async () => {
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json({
                    message: "remote HTTP failure text",
                    token: "remote-http-token",
                    secret: "remote-http-secret",
                    Authorization: "Bearer remote-http-authorization",
                    project_ref: "hidden-http-project-ref",
                }, { status: 503 });
            },
        });
        const fixtureToken = "dummy-http-api-token";

        try {
            const execution = await runAdminCli([
                "project", "service_control",
                "--ref", "project-ref",
                "--service", "gotrue",
                "--service_action", "stop",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: fixtureToken,
            });

            expect(execution.exitCode).toBe(1);
            expect(execution.output.trim()).toBe("❌ Failed (503)");
            expect(execution.output).not.toContain(fixtureToken);
            expect(execution.output).not.toContain("remote HTTP failure text");
            expect(execution.output).not.toContain("remote-http-token");
            expect(execution.output).not.toContain("remote-http-secret");
            expect(execution.output).not.toContain("remote-http-authorization");
            expect(execution.output).not.toContain("hidden-http-project-ref");
        } finally {
            apiServer.stop(true);
        }
    });

    test("returns a non-zero exit code when project creation is rejected", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requests.push({
                    path: new URL(request.url).pathname,
                    body: await request.json(),
                });
                return Response.json({ message: "invalid domain" }, { status: 400 });
            },
        });

        try {
            const execution = await runAdminCli(
                ["project", "create", "--name", "rejected-project", "--domain", "invalid.example"],
                {
                    SUPACLOUD_ENV: "test",
                    SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                    SUPACLOUD_API_TOKEN: "test-token",
                },
            );

            expect(execution.exitCode).toBe(1);
            expect(JSON.parse(execution.output).error).toEqual({
                code: "HTTP_ERROR",
                http_status: 400,
            });
            expect(requests).toEqual([{
                path: "/v1/projects",
                body: expect.objectContaining({
                    name: "rejected-project",
                    domain: "invalid.example",
                }),
            }]);
        } finally {
            server.stop(true);
        }
    });

    test.each([
        ["the API domain binding is missing", ["--environment", "test"], "API_DOMAIN_BINDING_REQUIRED"],
        ["the environment binding is missing", ["--api_domain", "api.example.test"], "ENVIRONMENT_BINDING_REQUIRED"],
    ] as const)("fails before remote project creation when %s", async (_label, bindingArgs, code) => {
        let requestCount = 0;
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount += 1;
                return Response.json({ unexpected: "remote-secret" }, { status: 201 });
            },
        });
        const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-admin-binding-")));
        const envFile = join(sandbox, ".env.project-credentials.test");
        const apiToken = "private-binding-api-token";

        try {
            const execution = await runAdminCli([
                "project", "create",
                "--name", "binding-required",
                "--env_file", envFile,
                ...bindingArgs,
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: apiToken,
            });

            expect(execution.exitCode).toBe(1);
            expect(JSON.parse(execution.output).error).toEqual({ code, http_status: null });
            expect(requestCount).toBe(0);
            expect(existsSync(envFile)).toBe(false);
            expect(execution.output).not.toContain(apiToken);
        } finally {
            apiServer.stop(true);
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform !== "linux")(
        "rejects an expired service-role response without writing or reflecting it",
        async () => {
        const jwtSegment = (claims: Record<string, unknown>) =>
            Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
        const expiredServiceRoleKey = [
            jwtSegment({ alg: "HS256", typ: "JWT" }),
            jwtSegment({ role: "service_role", iss: "supabase", exp: 1 }),
            "s".repeat(43),
        ].join(".");
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json({
                    ref: "abcdefghijklmnopqrst",
                    name: "expired-credential",
                    api: { url: "https://api.example.test" },
                    credentials: { service_role_key: expiredServiceRoleKey },
                }, { status: 201 });
            },
        });
        const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-admin-expired-")));
        const envFile = join(sandbox, ".env.project-credentials.test");

        try {
            const execution = await runAdminCli([
                "project", "create",
                "--name", "expired-credential",
                "--api_domain", "api.example.test",
                "--env_file", envFile,
                "--environment", "test",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
            });

            expect(execution.exitCode).toBe(1);
            expect(JSON.parse(execution.output).error).toEqual({
                code: "INVALID_RESPONSE",
                http_status: 201,
            });
            expect(existsSync(envFile)).toBe(false);
            expect(execution.output).not.toContain(expiredServiceRoleKey);
        } finally {
            apiServer.stop(true);
            rmSync(sandbox, { recursive: true, force: true });
        }
        },
    );

    test.skipIf(process.platform !== "linux")(
        "creates a project without printing one-time credentials and writes the env file as 0600",
        async () => {
        const projectRef = "abcdefghijklmnopqrst";
        const jwtSegment = (claims: Record<string, unknown>) =>
            Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
        const serviceRoleKey = [
            jwtSegment({ alg: "HS256", typ: "JWT" }),
            jwtSegment({ role: "service_role", iss: "supabase", exp: 4_102_444_800 }),
            "s".repeat(43),
        ].join(".");
        const privateSentinel = "private-process-response-secret";
        const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-admin-create-process-")));
        const envFile = join(sandbox, ".env.project-credentials.test");
        let requestBody: Record<string, unknown> | undefined;
        const apiServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.json() as Record<string, unknown>;
                return Response.json({
                    ref: projectRef,
                    name: "process-project",
                    api: { url: "https://api.example.test" },
                    credentials: {
                        service_role_key: serviceRoleKey,
                        jwt_secret: privateSentinel,
                    },
                    db_password: privateSentinel,
                    secret_key: privateSentinel,
                }, { status: 201 });
            },
        });

        try {
            const execution = await runAdminCli([
                "project", "create",
                "--name", "process-project",
                "--api_domain", "api.example.test",
                "--env_file", envFile,
                "--environment", "test",
            ], {
                SUPACLOUD_ENV: "test",
                SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                SUPACLOUD_API_TOKEN: "test-token",
            });

            expect(execution.exitCode).toBe(0);
            expect(requestBody).toEqual(expect.objectContaining({
                name: "process-project",
                credential_delivery: "response",
            }));
            expect(execution.output).toContain('"credentials_written": true');
            expect(execution.output).toContain('"env_file_scope": "project_application"');
            expect(execution.output).toContain(envFile);
            expect(execution.output).not.toContain(serviceRoleKey);
            expect(execution.output).not.toContain(privateSentinel);
            expect(readFileSync(envFile, "utf8")).toBe([
                "SUPACLOUD_ENV=test",
                `SUPACLOUD_PROJECT_REF=${projectRef}`,
                "SUPABASE_URL=https://api.example.test",
                `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
                "",
            ].join("\n"));
            if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
        } finally {
            apiServer.stop(true);
            rmSync(sandbox, { recursive: true, force: true });
        }
        },
    );

    test.skipIf(process.platform === "linux")(
        "rejects env-file credential delivery before the HTTP request on unsupported platforms",
        async () => {
            let requestCount = 0;
            const apiServer = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch() {
                    requestCount += 1;
                    return Response.json({ unexpected: true }, { status: 201 });
                },
            });
            const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-admin-platform-")));
            const envFile = join(sandbox, ".env.project-credentials.test");

            try {
                const execution = await runAdminCli([
                    "project", "create",
                    "--name", "unsupported-platform",
                    "--api_domain", "api.example.test",
                    "--env_file", envFile,
                    "--environment", "test",
                ], {
                    SUPACLOUD_ENV: "test",
                    SUPACLOUD_API_URL: `http://127.0.0.1:${apiServer.port}`,
                    SUPACLOUD_API_TOKEN: "test-token",
                });

                expect(execution.exitCode).toBe(1);
                expect(JSON.parse(execution.output).error.code).toBe("ENV_FILE_PLATFORM_UNSUPPORTED");
                expect(requestCount).toBe(0);
                expect(existsSync(envFile)).toBe(false);
            } finally {
                apiServer.stop(true);
                rmSync(sandbox, { recursive: true, force: true });
            }
        },
    );

    test("surfaces every sanitized cause when an operation and cleanup both fail", async () => {
        const result = await runAggregateFailureCli();

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("Remote upgrade failed and helper cleanup did not complete");
        expect(result.output).toContain("Remote upgrade failed (exit 42): transaction failed");
        expect(result.output).toContain("DATABASE_URL=postgresql://admin:[REDACTED]@localhost/db");
        expect(result.output).toContain("Failed to remove remote upgrade helper: permission denied");
        expect(result.output).not.toContain("database-password");
    });

    test("preserves nested reconciliation summaries alongside cleanup failures", () => {
        const reconciliation = new AggregateError(
            [new Error("SSH stream closed")],
            "Reconcile unit=upgrade.service stage=/stage status=/status log=/log drop=/drop; do not retry blindly",
        );
        const failure = new AggregateError(
            [reconciliation, new Error("Local bundle cleanup failed")],
            "Local upgrade and local bundle cleanup both failed",
        );

        const formatted = formatCliError(failure);
        expect(formatted).toContain("Local upgrade and local bundle cleanup both failed");
        expect(formatted).toContain("unit=upgrade.service stage=/stage status=/status log=/log drop=/drop");
        expect(formatted).toContain("do not retry blindly");
        expect(formatted).toContain("SSH stream closed");
        expect(formatted).toContain("Local bundle cleanup failed");
    });
});
