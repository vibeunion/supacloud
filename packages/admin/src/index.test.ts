import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdminTools } from "./index";
import { formatCliError } from "./shared/cli";
import { schemaEnumValues } from "./shared/schema";
import packageMetadata from "../package.json" with { type: "json" };

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
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
]);

function cleanEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !ADMIN_CONTEXT_KEYS.has(key)) env[key] = value;
    }
    return env;
}

async function runAdminCli(args: string[]): Promise<{ exitCode: number; output: string }> {
    const processHandle = Bun.spawn([process.execPath, "src/index.ts", ...args], {
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
    inferredSupabaseUrl: "",
    inferredServiceRoleKey: "",
    source: "env" as const,
};

describe("admin SSH registration gate", () => {
    test("keeps the versions action in the disabled SSH schema", () => {
        const tools = createAdminTools(baseContext);

        expect(schemaEnumValues(tools.ssh.schema.action)).toContain("versions");
    });

    test("does not register executable SSH tools without a verified host fingerprint", () => {
        const tools = createAdminTools(baseContext);
        expect(tools.project.schema.name).toBeDefined();
        expect(tools.ssh.schema.command).toBeUndefined();
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
    test("prints the exact package version", async () => {
        const execution = await runAdminCli(["--version"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output.trim()).toBe(packageMetadata.version);
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

    test("returns a non-zero exit code when a project command has no API context", async () => {
        const result = await runAdminCli(["project", "list"]);

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN");
    });

    test("documents every project create domain flag without API context", async () => {
        const execution = await runAdminCli(["project", "create", "--help"]);

        expect(execution.exitCode).toBe(0);
        expect(execution.output).toContain("--domain");
        expect(execution.output).toContain("--api_domain");
        expect(execution.output).toContain("--auth_domain");
        expect(execution.output).toContain("--studio_domain");
    });

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
