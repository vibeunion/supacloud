import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringEnum } from "./schema";
import { authorizeExecution, executionMode, validateExecutionPolicyCoverage } from "./execution-policy";
import type { ResolvedContext } from "./context";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../index.ts", import.meta.url));
const CONTEXT_ENVIRONMENT_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPACLOUD_API_URL",
    "SUPACLOUD_MANAGEMENT_API_URL",
    "MANAGEMENT_API_URL",
    "SUPACLOUD_API_TOKEN",
    "SUPACLOUD_PROJECT_REF",
    "X_PROJECT_REF",
    "SUPACLOUD_HOST",
    "SUPACLOUD_ENV",
    "SUPACLOUD_READ_ONLY",
];

function cliEnvironment(): Record<string, string> {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key, value]) => value !== undefined && !CONTEXT_ENVIRONMENT_KEYS.includes(key)),
    ) as Record<string, string>;
    return environment;
}

async function runCli(args: string[], workingDirectory: string) {
    const processHandle = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
        cwd: workingDirectory,
        env: cliEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stderr).text(),
    ]);
    return { exitCode, stderr };
}

function context(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
    return {
        host: "management.example.com",
        sshUser: "root",
        sshPort: 22,
        sshKey: "",
        sshPass: "",
        apiUrl: "https://management.example.com",
        apiToken: "secret-token",
        projectRef: "prod-ref",
        readOnly: false,
        environment: "production",
        production: true,
        inferredSupabaseUrl: "",
        inferredServiceRoleKey: "",
        credentialScope: "management",
        source: "process_env",
        sourcePath: null,
        ...overrides,
    };
}

describe("CLI execution policy", () => {
    test("treats one-command deploy as a protected write and dry run as read-only", () => {
        expect(executionMode("deploy", "deploy", {})).toBe("write");
        expect(executionMode("deploy", "deploy", { dry_run: true })).toBe("read");
        expect(() => authorizeExecution("deploy", { ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("deploy", { ref: "prod-ref" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
        expect(() => authorizeExecution("deploy", { ref: "prod-ref", dry_run: true }, {
            context: context(),
        })).not.toThrow();
    });

    test("requires an exact production confirmation for remote writes", () => {
        for (const action of ["pause", "restore"]) {
            expect(executionMode("project", action, {})).toBe("write");
            expect(() => authorizeExecution("project", { action }, { context: context() }))
                .toThrow("--confirm-production prod-ref");
            expect(() => authorizeExecution("project", { action }, {
                context: context(),
                confirmProduction: "prod-ref",
            })).not.toThrow();
        }
    });

    test("rejects cross-project production overrides even when confirmed", () => {
        expect(() => authorizeExecution("queue", { action: "send", ref: "other-ref" }, {
            context: context(),
            confirmProduction: "other-ref",
        })).toThrow("cannot target a different project");
    });

    test("rejects cross-project production reads while preserving same-project and non-production reads", () => {
        expect(() => authorizeExecution("project", { action: "api_keys", ref: "other-ref" }, {
            context: context(),
        })).toThrow("cannot target a different project");
        expect(() => authorizeExecution("project", { action: "api_keys", ref: "prod-ref" }, {
            context: context(),
        })).not.toThrow();
        expect(() => authorizeExecution("project", { action: "api_keys", ref: "other-ref" }, {
            context: context({ production: false, environment: "test" }),
        })).not.toThrow();
    });

    test("blocks cross-project production reads before the CLI sends HTTP", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-production-read-"));
        let requestCount = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                requestCount++;
                return Response.json([]);
            },
        });
        writeFileSync(join(workspace, ".env.supacloud.prod"), [
            "SUPACLOUD_ENV=production",
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=prod-secret-token",
            "SUPACLOUD_PROJECT_REF=prod-ref",
        ].join("\n") + "\n");

        try {
            const response = await runCli([
                "--env", "prod", "project", "api_keys", "--ref", "other-ref",
            ], workspace);

            expect(response.exitCode).toBe(1);
            expect(response.stderr).toContain("cannot target a different project");
            expect(requestCount).toBe(0);
        } finally {
            server.stop(true);
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("blocks every classified remote write in read-only mode", () => {
        expect(() => authorizeExecution("frontend", { action: "redeploy" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
        for (const action of ["pause", "restore"]) {
            expect(() => authorizeExecution("project", { action }, {
                context: context({ production: false, environment: "test", readOnly: true }),
            })).toThrow("SUPACLOUD_READ_ONLY=true");
        }
    });

    test("classifies immutable frontend release reads and protects their mutations", () => {
        expect(executionMode("frontend", "list_releases", {})).toBe("read");
        expect(executionMode("frontend", "get_release", {})).toBe("read");
        expect(executionMode("frontend", "upload_release", {})).toBe("write");
        expect(executionMode("frontend", "activate_release", {})).toBe("write");
        expect(() => authorizeExecution("frontend", { action: "upload_release", ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("frontend", { action: "activate_release", ref: "prod-ref" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
        expect(() => authorizeExecution("frontend", { action: "upload_release", ref: "prod-ref" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
    });

    test("classifies Function, Scheduled Function, and Storage lifecycle actions", () => {
        expect(executionMode("database", "lint_migrations", {})).toBe("local");
        expect(executionMode("database", "lint", {})).toBe("local");
        expect(executionMode("edge_functions", "get_config", {})).toBe("read");
        expect(executionMode("edge_functions", "config", {})).toBe("write");
        expect(executionMode("edge_functions", "activate", {})).toBe("write");
        expect(executionMode("scheduled_functions", "list", {})).toBe("read");
        expect(executionMode("scheduled_functions", "get", {})).toBe("read");
        for (const action of ["create", "update", "delete"]) {
            expect(executionMode("scheduled_functions", action, {})).toBe("write");
        }
        expect(executionMode("storage", "get_bucket", {})).toBe("read");
        for (const action of ["create_bucket", "update_bucket", "delete_bucket"]) {
            expect(executionMode("storage", action, {})).toBe("write");
        }
    });

    test("classifies dedicated release-canary OAuth client reads and mutations", () => {
        expect(executionMode("oauth_clients", "list", {})).toBe("read");
        expect(executionMode("oauth_clients", "get", {})).toBe("read");
        expect(executionMode("oauth_clients", "create", {})).toBe("write");
        expect(executionMode("oauth_clients", "delete", {})).toBe("write");
        expect(executionMode("auth", "get_oauth_server", {})).toBe("read");
        expect(executionMode("auth", "migrate_oauth_server", {})).toBe("write");
        expect(() => authorizeExecution("oauth_clients", { action: "create", ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("oauth_clients", { action: "delete", ref: "prod-ref" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
        expect(() => authorizeExecution("oauth_clients", { action: "create", ref: "prod-ref" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
    });

    test("classifies auth user reads and generate_link as a production-confirmed write", () => {
        expect(executionMode("auth", "list_users", {})).toBe("read");
        expect(executionMode("auth", "get_user", {})).toBe("read");
        expect(executionMode("auth", "generate_link", {})).toBe("write");
        expect(() => authorizeExecution("auth", { action: "generate_link", ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("auth", { action: "generate_link", ref: "prod-ref" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
    });

    test("classifies verified release controls and protects their mutations", () => {
        expect(executionMode("release", "logical_backup_list", {})).toBe("read");
        expect(executionMode("release", "postgrest_status", {})).toBe("read");
        expect(executionMode("release", "logical_backup_create", {})).toBe("write");
        expect(executionMode("release", "logical_backup_restore", {})).toBe("write");
        expect(executionMode("release", "postgrest_restart", {})).toBe("write");
        expect(executionMode("release", "release_canary_fixture_stage_replay", {})).toBe("write");
        expect(executionMode("release", "release_canary_fixture_disable_replay", {})).toBe("write");
        expect(() => authorizeExecution("release", { action: "logical_backup_create" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("release", { action: "postgrest_restart" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
        expect(() => authorizeExecution("release", { action: "release_canary_fixture_stage_replay", ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("release", { action: "release_canary_fixture_disable_replay", ref: "prod-ref" }, {
            context: context(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("release", { action: "release_canary_fixture_disable_replay" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
        expect(() => authorizeExecution("release", { action: "logical_backup_restore", ref: "other-ref" }, {
            context: context(),
            confirmProduction: "other-ref",
        })).toThrow("cannot target a different project");
        expect(() => authorizeExecution("release", { action: "logical_backup_restore" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
    });

    test("allows migration previews and local authoring without production confirmation", () => {
        expect(executionMode("database", "migration_inventory", {})).toBe("read");
        expect(executionMode("database", "push_migrations", { dry_run: true })).toBe("read");
        expect(executionMode("supabase", "push", { dry_run: true })).toBe("read");
        expect(() => authorizeExecution("supabase", { action: "db_dump" }, { context: context() }))
            .not.toThrow();
    });

    test("always rejects diagnostics repair in production", () => {
        expect(() => authorizeExecution("diagnostics", { action: "repair" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).toThrow("forbidden in production");
    });

    test("fails closed for unknown production actions", () => {
        expect(() => authorizeExecution("queue", { action: "future_mutation" }, { context: context() }))
            .toThrow("no classification");
    });

    test("detects registered action catalog drift", () => {
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: stringEnum(["get", "future_mutation"]) } },
        })).toThrow("project.future_mutation");
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: stringEnum(["get", "task_cancel"]) } },
        })).not.toThrow();
    });
});
