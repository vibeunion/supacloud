import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSupaCloudContext } from "./context";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), "supacloud-cli-context-"));
    temporaryDirectories.push(workspace);
    return workspace;
}

function writeEnvironment(workspace: string, filename: string, values: Record<string, string>): string {
    const path = join(workspace, filename);
    writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
    return path;
}

describe("resolveSupaCloudContext", () => {
    test("keeps custom project application credentials out of Management context", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://api.xg.aizhuliren.cn",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.host).toBe("api.xg.aizhuliren.cn");
        expect(context.apiToken).toBe("");
        expect(context.inferredSupabaseUrl).toBe("https://api.xg.aizhuliren.cn");
        expect(context.inferredServiceRoleKey).toBe("service-role");
        expect(context.credentialScope).toBe("project_application");
    });

    test("infers only the project ref from a managed project application origin", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://abc123.api.example.com/",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.projectRef).toBe("abc123");
        expect(context.inferredSupabaseUrl).toBe("https://abc123.api.example.com");
        expect(context.credentialScope).toBe("project_application");
    });

    test("explicit management API URL wins over Supabase URL inference", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://api.xg.aizhuliren.cn",
            SUPACLOUD_API_URL: "https://management.example.com/",
            SUPACLOUD_API_TOKEN: "token",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("https://management.example.com");
        expect(context.apiToken).toBe("token");
        expect(context.credentialScope).toBe("management");
    });

    test("prefers SUPACLOUD_API_TOKEN within one atomic source", () => {
        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: "https://management.example.com",
            SUPACLOUD_PROJECT_REF: "project-ref",
            SUPACLOUD_API_TOKEN: "api-token",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiToken).toBe("api-token");
    });

    test("does not substitute an application key for a missing Management token", () => {
        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: "https://management.example.com",
            SUPACLOUD_PROJECT_REF: "project-ref",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context).toMatchObject({
            apiUrl: "https://management.example.com",
            apiToken: "",
            credentialScope: "management",
            inferredServiceRoleKey: "service-role",
        });
    });

    test("explicit project ref wins over managed hostname inference", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://inferred.api.example.com",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            SUPACLOUD_PROJECT_REF: "explicit-ref",
        }, "/tmp/no-such-supacloud-context");

        expect(context.projectRef).toBe("explicit-ref");
        expect(context.apiUrl).toBe("");
    });

    test("invalid placeholder Supabase URL does not throw", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "{API_URL}",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.host).toBe("");
        expect(context.inferredSupabaseUrl).toBe("");
        expect(context.apiToken).toBe("");
    });

    test.each([
        "http://management.example.com",
        "https://user:password@management.example.com",
        "https://management.example.com/private",
        "https://management.example.com/%2e",
        "https://management.example.com?token=private",
        "https://management.example.com#private",
    ])("rejects unsafe Management origin %s", (managementUrl) => {
        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: managementUrl,
            SUPACLOUD_API_TOKEN: "management-token",
            SUPACLOUD_PROJECT_REF: "project-ref",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.apiToken).toBe("management-token");
        expect(context.credentialScope).toBe("management");
    });

    test.each([
        "https://management.example.com:443",
        "https://management.example.com:443/",
        "http://127.0.0.1:80",
        "http://[::1]:80/",
    ])("rejects non-canonical explicit default port %s", (managementUrl) => {
        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: managementUrl,
            SUPACLOUD_API_TOKEN: "management-token",
            SUPACLOUD_PROJECT_REF: "project-ref",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.credentialScope).toBe("management");
    });

    test("rejects an explicit default port on an application origin", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://abc123.api.example.com:443",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.inferredSupabaseUrl).toBe("");
        expect(context.host).toBe("");
        expect(context.credentialScope).toBe("project_application");
    });

    test("allows HTTP only for literal loopback Management origins", () => {
        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: "http://127.0.0.1:9090/",
            SUPACLOUD_API_TOKEN: "management-token",
            SUPACLOUD_PROJECT_REF: "project-ref",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("http://127.0.0.1:9090");
        expect(context.credentialScope).toBe("management");
    });

    test("strictly selects a named environment file without mixing process context", () => {
        const workspace = temporaryWorkspace();
        const path = writeEnvironment(workspace, ".env.supacloud.Test", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: "https://test-management.example.com",
            SUPACLOUD_API_TOKEN: "file-token",
            SUPACLOUD_PROJECT_REF: "test-ref",
        });

        const context = resolveSupaCloudContext({
            SUPACLOUD_API_TOKEN: "process-token",
        }, workspace, { environmentName: "Test" });

        expect(context).toMatchObject({
            environment: "test",
            source: "named_env_file",
            sourcePath: path,
            apiToken: "file-token",
            projectRef: "test-ref",
            production: false,
        });
    });

    test("does not fall back when a named environment file is missing", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env", {
            SUPACLOUD_API_URL: "https://legacy.example.com",
            SUPACLOUD_API_TOKEN: "legacy-token",
            SUPACLOUD_PROJECT_REF: "legacy-ref",
        });

        expect(() => resolveSupaCloudContext({}, workspace, { environmentName: "missing" }))
            .toThrow(".env.supacloud.missing");
    });

    test("requires explicit files to declare SUPACLOUD_ENV", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, "custom.env", {
            SUPACLOUD_API_URL: "https://management.example.com",
        });

        expect(() => resolveSupaCloudContext({}, workspace, { envFile: "custom.env" }))
            .toThrow("SUPACLOUD_ENV is required");
    });

    test("loads quoted values from an explicit environment file", () => {
        const workspace = temporaryWorkspace();
        const path = join(workspace, "ci.env");
        writeFileSync(path, [
            'SUPACLOUD_ENV="production"',
            "SUPACLOUD_API_URL='https://management.example.com/'",
            'SUPACLOUD_API_TOKEN="file-token"',
            "SUPACLOUD_PROJECT_REF='prod-ref'",
        ].join("\n") + "\n");

        const context = resolveSupaCloudContext({
            SUPACLOUD_API_TOKEN: "process-token",
        }, workspace, { envFile: "ci.env" });

        expect(context).toMatchObject({
            environment: "production",
            source: "explicit_env_file",
            sourcePath: path,
            apiUrl: "https://management.example.com",
            apiToken: "file-token",
            projectRef: "prod-ref",
            production: true,
        });
    });

    test("rejects a named file whose declared environment differs from its selector", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env.supacloud.test", { SUPACLOUD_ENV: "prod" });

        expect(() => resolveSupaCloudContext({}, workspace, { environmentName: "test" }))
            .toThrow("does not match selector test");
    });

    test("uses complete SUPACLOUD_ENV process context as one CI source", () => {
        const workspace = temporaryWorkspace();
        const context = resolveSupaCloudContext({
            SUPACLOUD_ENV: "production",
            SUPACLOUD_API_URL: "https://management.example.com",
            SUPACLOUD_API_TOKEN: "process-token",
            SUPACLOUD_PROJECT_REF: "prod-ref",
        }, workspace);

        expect(context).toMatchObject({
            environment: "production",
            source: "process_env",
            sourcePath: null,
            projectRef: "prod-ref",
            production: true,
        });
    });

    test("uses a complete application SUPACLOUD_ENV process context as one source", () => {
        const workspace = temporaryWorkspace();
        const context = resolveSupaCloudContext({
            SUPACLOUD_ENV: "test",
            SUPABASE_URL: "https://abc123.api.example.com",
            SUPABASE_SERVICE_ROLE_KEY: "application-service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        }, workspace);

        expect(context).toMatchObject({
            environment: "test",
            source: "process_env",
            sourcePath: null,
            credentialScope: "project_application",
            apiUrl: "",
            apiToken: "",
            projectRef: "abc123",
        });
    });

    test("uses SUPACLOUD_ENV as a strict named selector when process context is incomplete", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env.supacloud.test", {
            SUPACLOUD_API_URL: "https://test.example.com",
            SUPACLOUD_API_TOKEN: "file-token",
            SUPACLOUD_PROJECT_REF: "test-ref",
        });

        const context = resolveSupaCloudContext({
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_TOKEN: "partial-process-token",
        }, workspace);

        expect(context.source).toBe("named_env_file");
        expect(context.apiToken).toBe("file-token");
    });

    test("does not mix partial process context with legacy dotenv", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env", {
            SUPACLOUD_API_TOKEN: "dotenv-token",
            SUPACLOUD_PROJECT_REF: "dotenv-ref",
        });

        const context = resolveSupaCloudContext({
            SUPACLOUD_API_URL: "https://process.example.com",
        }, workspace);

        expect(context.source).toBe("process_env");
        expect(context.apiUrl).toBe("https://process.example.com");
        expect(context.apiToken).toBe("");
        expect(context.projectRef).toBe("");
    });

    test("keeps legacy dotenv compatibility when process context is absent", () => {
        const workspace = temporaryWorkspace();
        const path = writeEnvironment(workspace, ".env", {
            SUPACLOUD_API_URL: "https://legacy.example.com",
            SUPACLOUD_API_TOKEN: "legacy-token",
            SUPACLOUD_PROJECT_REF: "legacy-ref",
        });

        const context = resolveSupaCloudContext({}, workspace);

        expect(context).toMatchObject({
            source: "legacy_dotenv",
            sourcePath: path,
            projectRef: "legacy-ref",
        });
    });
});
