import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createAdminTools } from "./index";

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
    test("returns a non-zero exit code when a project command has no API context", async () => {
        const result = await runAdminCli(["project", "list"]);

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN");
    });
});
