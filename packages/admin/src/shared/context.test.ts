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
    const workspace = mkdtempSync(join(tmpdir(), "supacloud-admin-context-"));
    temporaryDirectories.push(workspace);
    return workspace;
}

function writeEnvironment(
    workspace: string,
    filename: string,
    environment: Record<string, string>,
): string {
    const path = join(workspace, filename);
    const contents = Object.entries(environment)
        .map(([key, environmentValue]) => `${key}=${environmentValue}`)
        .join("\n");
    writeFileSync(path, `${contents}\n`);
    return path;
}

describe("resolveSupaCloudContext", () => {
    test("reads a complete SSH process context without inferring a fingerprint", () => {
        const missingFingerprint = resolveSupaCloudContext({
            SUPACLOUD_HOST: "server.example.com",
        }, "/nonexistent");
        expect(missingFingerprint.sshHostFingerprint).toBe("");

        const configured = resolveSupaCloudContext({
            SUPACLOUD_ENV: "production",
            SUPACLOUD_HOST: "server.example.com",
            SUPACLOUD_SSH_HOST_FINGERPRINT: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }, "/nonexistent");
        expect(configured).toMatchObject({
            host: "server.example.com",
            environment: "production",
            production: true,
            source: "process_env",
        });
    });

    test("strictly selects one named file without mixing process API or SSH secrets", () => {
        const workspace = temporaryWorkspace();
        const path = writeEnvironment(workspace, ".env.supacloud.test", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: "https://test-management.example.com",
            SUPACLOUD_API_TOKEN: "file-api-token",
            SUPACLOUD_PROJECT_REF: "test-ref",
            SUPACLOUD_HOST: "test-host.example.com",
            SUPACLOUD_SSH_PASS: "file-ssh-password",
            SUPACLOUD_SSH_HOST_FINGERPRINT: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });

        const context = resolveSupaCloudContext({
            SUPACLOUD_API_TOKEN: "process-api-token",
            SUPACLOUD_SSH_PASS: "process-ssh-password",
            SUPACLOUD_READ_ONLY: "true",
        }, workspace, { environmentName: "test" });

        expect(context).toMatchObject({
            source: "named_env_file",
            sourcePath: path,
            environment: "test",
            apiToken: "file-api-token",
            sshPass: "file-ssh-password",
            projectRef: "test-ref",
            readOnly: true,
        });
    });

    test("requires an explicit file to declare its environment", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, "custom.env", {
            SUPACLOUD_API_URL: "https://management.example.com",
            SUPACLOUD_API_TOKEN: "file-token",
        });

        expect(() => resolveSupaCloudContext({}, workspace, { envFile: "custom.env" }))
            .toThrow("SUPACLOUD_ENV is required");
    });

    test("loads quoted values from an explicit production file", () => {
        const workspace = temporaryWorkspace();
        const path = join(workspace, "production.env");
        writeFileSync(path, [
            'SUPACLOUD_ENV="production"',
            "SUPACLOUD_API_URL='https://management.example.com/'",
            'SUPACLOUD_API_TOKEN="file-token"',
            "SUPACLOUD_PROJECT_REF='prod-ref'",
        ].join("\n") + "\n");

        const context = resolveSupaCloudContext({
            SUPACLOUD_API_TOKEN: "process-token",
        }, workspace, { envFile: "production.env" });

        expect(context).toMatchObject({
            source: "explicit_env_file",
            sourcePath: path,
            environment: "production",
            production: true,
            apiUrl: "https://management.example.com",
            apiToken: "file-token",
            projectRef: "prod-ref",
        });
    });

    test("rejects project application credentials as an explicit Admin profile", () => {
        const workspace = temporaryWorkspace();
        const serviceRoleKey = "project-service-role-secret";
        writeEnvironment(workspace, "project.env", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_PROJECT_REF: "abcdefghijklmnopqrst",
            SUPABASE_URL: "https://api.example.test",
            SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        });

        let failure: unknown;
        try {
            resolveSupaCloudContext({}, workspace, { envFile: "project.env" });
        } catch (error: unknown) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("cannot be used as a SupaCloud Admin profile");
        expect(String(failure)).toContain("SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN are required");
        expect(String(failure)).not.toContain(serviceRoleKey);
    });

    test("requires explicit Management URL and token fields as a complete file pair", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, "missing-token.env", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: "https://management.example.test",
        });
        writeEnvironment(workspace, "missing-url.env", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_TOKEN: "management-token",
        });

        for (const envFile of ["missing-token.env", "missing-url.env"]) {
            expect(() => resolveSupaCloudContext({}, workspace, { envFile }))
                .toThrow("requires both SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN");
        }
    });

    test("uses SUPACLOUD_ENV as a named selector when process context is incomplete", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env.supacloud.test", {
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_URL: "https://test.example.com",
            SUPACLOUD_API_TOKEN: "file-token",
        });

        const context = resolveSupaCloudContext({
            SUPACLOUD_ENV: "test",
            SUPACLOUD_API_TOKEN: "partial-process-token",
        }, workspace);

        expect(context.source).toBe("named_env_file");
        expect(context.apiToken).toBe("file-token");
    });

    test("requires selected profiles to declare a matching environment", () => {
        const workspace = temporaryWorkspace();
        writeEnvironment(workspace, ".env.supacloud.audit", {
            SUPACLOUD_API_URL: "https://management.example.com",
            SUPACLOUD_API_TOKEN: "file-token",
        });
        writeEnvironment(workspace, ".env.supacloud.test", { SUPACLOUD_ENV: "production" });

        expect(() => resolveSupaCloudContext({}, workspace, { environmentName: "audit" }))
            .toThrow("SUPACLOUD_ENV is required");
        expect(() => resolveSupaCloudContext({}, workspace, { environmentName: "test" }))
            .toThrow("does not match selector test");
        expect(() => resolveSupaCloudContext({ SUPACLOUD_ENV: "../production" }, workspace))
            .toThrow("must match");
    });

    test("does not combine partial process context with legacy dotenv", () => {
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

    test("rejects ambiguous SSH ports and unsafe management URL components", () => {
        expect(() => resolveSupaCloudContext({
            SUPACLOUD_HOST: "server.example.com",
            SUPACLOUD_SSH_PORT: "2201junk",
        }, "/nonexistent")).toThrow("SUPACLOUD_SSH_PORT must be an integer");
        expect(() => resolveSupaCloudContext({
            SUPACLOUD_HOST: "server.example.com",
            SUPACLOUD_SSH_PORT: "65536",
        }, "/nonexistent")).toThrow("SUPACLOUD_SSH_PORT must be an integer");

        for (const apiUrl of [
            "https://operator:url-secret@management.example.com",
            "https://management.example.com/?query-secret",
            "https://management.example.com/#fragment-secret",
        ]) {
            const unsafeUrl = resolveSupaCloudContext({
                SUPACLOUD_API_URL: apiUrl,
                SUPACLOUD_API_TOKEN: "api-token",
            }, "/nonexistent");
            expect(unsafeUrl.apiUrl).toBe("");
            expect(JSON.stringify(unsafeUrl)).not.toContain("url-secret");
            expect(JSON.stringify(unsafeUrl)).not.toContain("query-secret");
            expect(JSON.stringify(unsafeUrl)).not.toContain("fragment-secret");
        }
    });
});
