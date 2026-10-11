import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerReleaseTools } from "./release-tools";
import { authorizeExecution, executionMode } from "../execution-policy";
import type { ResolvedContext } from "../context";

const PROJECT_REF = "proj";
const CREATED_AT = "2026-08-17T00:00:00.000Z";
const COMPLETED_AT = "2026-08-17T00:00:01.000Z";
const SHA256 = "a".repeat(64);
const BACKUP_ID = `logical-full_${PROJECT_REF}_${"b".repeat(32)}`;
const APPLICATION_ORIGIN = "https://api.example.test";

type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type ReleaseCallback = (args: Record<string, unknown>) => Promise<ToolResult>;

function verifiedBackup(overrides: Record<string, unknown> = {}) {
    return {
        backup_id: BACKUP_ID,
        project_ref: PROJECT_REF,
        database: "private_database_name",
        kind: "logical-full",
        created_at: CREATED_AT,
        completed_at: COMPLETED_AT,
        bytes: 42,
        sha256: SHA256,
        receipt_hmac_sha256: "private-receipt-hmac",
        archive_path: "/private/archive.dump",
        ...overrides,
    };
}

function healthyPostgrest(overrides: Record<string, unknown> = {}) {
    return {
        component: "postgrest",
        desired: "running",
        actual: "running",
        health: "healthy",
        unit: "private-unit-name",
        port: 3000,
        ...overrides,
    };
}

function projectEndpoints(apiOrigin = APPLICATION_ORIGIN) {
    const api = new URL(apiOrigin);
    return {
        schema: "supacloud.project-endpoints.v1",
        project_ref: PROJECT_REF,
        endpoints: {
            api: { origin: api.origin, host: api.host, scheme: api.protocol.slice(0, -1), source: "explicit_api_domain", aliases: [] },
            auth: { origin: "https://auth.example.test", host: "auth.example.test", scheme: "https", source: "explicit_auth_domain", aliases: [] },
            studio: { origin: "https://studio.example.test", host: "studio.example.test", scheme: "https", source: "explicit_studio_domain", aliases: [] },
        },
    };
}

function captureReleaseTool(
    http: Record<string, unknown>,
    applicationHttp?: Record<string, unknown>,
): ReleaseCallback {
    let callback: ReleaseCallback | undefined;
    registerReleaseTools({
        tool(name, _description, _schema, toolCallback) {
            if (name === "release") callback = toolCallback;
        },
    }, http as never, {
        projectRef: PROJECT_REF,
        applicationHttp: applicationHttp as never,
        applicationOrigin: applicationHttp ? APPLICATION_ORIGIN : undefined,
    });
    if (!callback) throw new Error("release tool was not registered");
    return callback;
}

function payload(response: ToolResult): Record<string, any> {
    return JSON.parse(response.content[0].text) as Record<string, any>;
}

test("logical backup list returns only the safe verified receipt projection", async () => {
    const requests: Array<{ path: string; options: Record<string, unknown> }> = [];
    const callback = captureReleaseTool({
        get: async (path: string, options: Record<string, unknown>) => {
            requests.push({ path, options });
            return { ok: true, status: 200, data: { backups: [verifiedBackup()] } };
        },
    });

    const response = await callback({ action: "logical_backup_list" });
    const result = payload(response);

    expect(requests).toEqual([{
        path: "/v1/projects/proj/database/backups/logical",
        options: { maxJsonBytes: 1024 * 1024, responseTimeoutMs: 5_000 },
    }]);
    expect(result).toMatchObject({
        ok: true,
        operation: "release.logical_backup.list",
        project_ref: PROJECT_REF,
        backups: [{ backup_id: BACKUP_ID, sha256: SHA256 }],
    });
    expect(response.content[0].text).not.toContain("private_database_name");
    expect(response.content[0].text).not.toContain("private-receipt-hmac");
    expect(response.content[0].text).not.toContain("/private/archive.dump");
});

test("logical backup create sends one stable ID and verifies that exact receipt", async () => {
    const requests: Array<{ method: "get" | "post"; path: string; options?: Record<string, unknown> }> = [];
    const backupId = `logical-full_${PROJECT_REF}_${"c".repeat(32)}`;
    const callback = captureReleaseTool({
        get: async (path: string, options: Record<string, unknown>) => {
            requests.push({ method: "get", path, options });
            return {
                ok: true,
                status: 200,
                data: { backup: verifiedBackup({ backup_id: backupId }) },
            };
        },
        postReleaseMutation: async (path: string, body: unknown, options: Record<string, unknown>) => {
            requests.push({ method: "post", path, options: { ...options, body } });
            return { ok: true, status: 200, data: { backup: verifiedBackup({ backup_id: backupId }) } };
        },
    });

    const response = await callback({ action: "logical_backup_create", backup_id: backupId });
    const result = payload(response);

    expect(requests).toEqual([
        {
            method: "post",
            path: "/v1/projects/proj/database/backups/logical",
            options: { timeoutMs: 36 * 60_000, body: { backup_id: backupId } },
        },
        {
            method: "get",
            path: `/v1/projects/proj/database/backups/logical/${backupId}`,
            options: { maxJsonBytes: 64 * 1024, responseTimeoutMs: 5_000 },
        },
    ]);
    expect(result).toMatchObject({
        ok: true,
        operation: "release.logical_backup.create",
        backup: { backup_id: backupId, sha256: SHA256 },
    });
});

test("logical backup create preserves the stable ID when exact readback is ambiguous", async () => {
    const secondBackup = verifiedBackup({ backup_id: `logical-full_${PROJECT_REF}_${"c".repeat(32)}` });
    const backupId = `logical-full_${PROJECT_REF}_${"d".repeat(32)}`;
    const callback = captureReleaseTool({
        get: async () => {
            return {
                ok: true,
                status: 200,
                data: { backups: [verifiedBackup(), secondBackup] },
            };
        },
        postReleaseMutation: async () => ({
            ok: true, status: 200, data: { backup: verifiedBackup({ backup_id: backupId }) },
        }),
    });

    const response = await callback({ action: "logical_backup_create", backup_id: backupId });

    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.logical_backup.create",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
        project_ref: PROJECT_REF,
        backup_id: backupId,
    });
    expect(response.content[0].text).not.toContain("private_database_name");
});

test("logical backup status verifies one exact ID without reading the full inventory", async () => {
    const requests: Array<{ path: string; options: Record<string, unknown> }> = [];
    const callback = captureReleaseTool({
        get: async (path: string, options: Record<string, unknown>) => {
            requests.push({ path, options });
            return { ok: true, status: 200, data: { backup: verifiedBackup() } };
        },
    });

    const response = await callback({ action: "logical_backup_status", backup_id: BACKUP_ID });

    expect(requests).toEqual([{
        path: `/v1/projects/${PROJECT_REF}/database/backups/logical/${BACKUP_ID}`,
        options: { maxJsonBytes: 64 * 1024, responseTimeoutMs: 5_000 },
    }]);
    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.logical_backup.status",
        project_ref: PROJECT_REF,
        backup_id: BACKUP_ID,
        backup: { backup_id: BACKUP_ID, sha256: SHA256 },
    });
    expect(response.content[0].text).not.toContain("private_database_name");
    expect(response.content[0].text).not.toContain("private-receipt-hmac");
});

test("logical backup create generates its identity before dispatch and reuses it for readback", async () => {
    let backupId = "";
    const requests: string[] = [];
    const callback = captureReleaseTool({
        postReleaseMutation: async (path: string, body: { backup_id: string }) => {
            backupId = body.backup_id;
            requests.push(`POST:${path}`);
            expect(backupId).toMatch(/^logical-full_proj_[a-f0-9]{32}$/);
            return { ok: true, status: 200, data: { backup: verifiedBackup({ backup_id: backupId }) } };
        },
        get: async (path: string) => {
            requests.push(`GET:${path}`);
            return { ok: true, status: 200, data: { backup: verifiedBackup({ backup_id: backupId }) } };
        },
    });
    const result = payload(await callback({ action: "logical_backup_create" }));
    expect(result).toMatchObject({ ok: true, project_ref: PROJECT_REF, backup_id: backupId });
    expect(requests).toEqual([
        "POST:/v1/projects/proj/database/backups/logical",
        `GET:/v1/projects/proj/database/backups/logical/${backupId}`,
    ]);
});

test.each([
    { ok: false, status: 0, data: null, transportError: true },
    { ok: false, status: 200, data: null, responseReadError: true },
    { ok: false, status: 503, data: null },
    { ok: false, status: 408, data: null },
])("lost creation responses use exact observation, never another POST: %j", async mutation => {
    let writes = 0, reads = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => { writes++; return mutation; },
        get: async (path: string) => {
            reads++;
            expect(path).toEndWith(`/logical/${BACKUP_ID}`);
            return { ok: true, status: 200, data: { backup: verifiedBackup() } };
        },
    });
    const result = payload(await callback({ action: "logical_backup_create", backup_id: BACKUP_ID }));
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(result).toMatchObject({
        ok: false, backup_verified: true, creation_confirmed: false,
        error: { code: "OUTCOME_UNKNOWN" },
        backup_id: BACKUP_ID, backup: { backup_id: BACKUP_ID, sha256: SHA256 },
    });
});

test.each([401, 403, 409])("definite creation failure %i is not replaced by readback success", async status => {
    let writes = 0, reads = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => { writes++; return { ok: false, status, data: { secret: "private" } }; },
        get: async () => { reads++; return { ok: true, status: 200, data: { backup: verifiedBackup() } }; },
    });
    const result = payload(await callback({ action: "logical_backup_create", backup_id: BACKUP_ID }));
    expect(writes).toBe(1);
    expect(reads).toBe(0);
    expect(result).toMatchObject({ ok: false, backup_id: BACKUP_ID, error: { code: "HTTP_ERROR", http_status: status } });
});

test.each([404, 409, 503])("uncertain creation retains its ID if exact observation returns %i", async status => {
    let writes = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => {
            writes++;
            return { ok: false, status: 0, data: null, transportError: true };
        },
        get: async () => ({ ok: false, status, data: { password: "do-not-reflect" } }),
    });
    const response = await callback({ action: "logical_backup_create", backup_id: BACKUP_ID });
    expect(writes).toBe(1);
    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
        ok: false, project_ref: PROJECT_REF, backup_id: BACKUP_ID,
        error: { code: "OUTCOME_UNKNOWN", http_status: null },
    });
    expect(response.content[0].text).not.toContain("do-not-reflect");
});

test("thrown providers preserve creation identity without reflecting errors", async () => {
    let writes = 0, reads = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => { writes++; throw new Error("token=private /path"); },
        get: async () => { reads++; throw new Error("password=private /path"); },
    });
    const response = await callback({ action: "logical_backup_create", backup_id: BACKUP_ID });
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(payload(response)).toMatchObject({ ok: false, backup_id: BACKUP_ID, error: { code: "OUTCOME_UNKNOWN" } });
    expect(response.content[0].text).not.toContain("private");
});

test.each([
    { mutationId: `logical-full_proj_${"d".repeat(32)}`, observationSha: SHA256 },
    { mutationId: BACKUP_ID, observationSha: "d".repeat(64) },
])("successful creation requires matching mutation and exact observation: %j", async ({ mutationId, observationSha }) => {
    const callback = captureReleaseTool({
        postReleaseMutation: async () => ({
            ok: true, status: 200, data: { backup: verifiedBackup({ backup_id: mutationId }) },
        }),
        get: async () => ({ ok: true, status: 200, data: { backup: verifiedBackup({ sha256: observationSha }) } }),
    });
    expect(payload(await callback({ action: "logical_backup_create", backup_id: BACKUP_ID }))).toMatchObject({
        ok: false, backup_id: BACKUP_ID, error: { code: "OUTCOME_UNKNOWN" },
    });
});

test.each([404, 409, 503])("backup status preserves exact identity on HTTP %i", async status => {
    const callback = captureReleaseTool({
        get: async () => ({ ok: false, status, data: { credentials: "do-not-reflect" } }),
    });
    const response = await callback({ action: "logical_backup_status", backup_id: BACKUP_ID });
    expect(payload(response)).toMatchObject({
        ok: false, project_ref: PROJECT_REF, backup_id: BACKUP_ID, error: { code: "HTTP_ERROR", http_status: status },
    });
    expect(response.content[0].text).not.toContain("do-not-reflect");
});

test.each([
    "../escape", `logical-full_other_${"b".repeat(32)}`, `logical-full_proj-longer_${"b".repeat(32)}`,
    `logical-full_proj_${"B".repeat(32)}`,
])("invalid or foreign backup ID %s never dispatches a read or write", async backupId => {
    let calls = 0;
    const callback = captureReleaseTool({
        get: async () => { calls++; throw new Error("must not run"); },
        postReleaseMutation: async () => { calls++; throw new Error("must not run"); },
    });
    for (const action of ["logical_backup_status", "logical_backup_create"]) {
        await expect(callback({ action, backup_id: backupId })).rejects.toThrow("backup_id");
    }
    expect(calls).toBe(0);
});

test("exact backup status remains a scoped production read while creation is protected", () => {
    const context: ResolvedContext = {
        host: "example.test", sshUser: "", sshPort: 22, sshKey: "", sshPass: "",
        apiUrl: "https://example.test", apiToken: "", projectRef: PROJECT_REF,
        readOnly: true, environment: "production", production: true,
        inferredSupabaseUrl: "", inferredServiceRoleKey: "", credentialScope: "management",
        source: "process_env", sourcePath: null, environmentVariables: {}, insecureTls: false,
    };
    expect(executionMode("release", "logical_backup_status", {})).toBe("read");
    expect(() => authorizeExecution("release", { action: "logical_backup_status", ref: PROJECT_REF }, { context }))
        .not.toThrow();
    expect(() => authorizeExecution("release", { action: "logical_backup_status", ref: "other" }, { context }))
        .toThrow("cannot target a different project");
    expect(() => authorizeExecution("release", { action: "logical_backup_create", ref: PROJECT_REF }, { context }))
        .toThrow("read-only mode");
    expect(() => authorizeExecution("release", { action: "logical_backup_create", ref: PROJECT_REF }, {
        context: { ...context, readOnly: false },
    })).toThrow("--confirm-production");
});

test("real CLI permits exact read-only production status and blocks writes and cross-project reads before HTTP", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "logical-backup-cli-policy-"));
    const requests: Array<{ method: string; path: string }> = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            requests.push({ method: request.method, path: new URL(request.url).pathname });
            return Response.json({ backup: verifiedBackup() });
        },
    });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        value !== undefined && !/^(SUPACLOUD_|SUPABASE_|MANAGEMENT_|X_PROJECT_REF$)/.test(key)));
    const cli = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const run = async (action: string, ref: string, readOnly = true) => {
        const child = Bun.spawn([process.execPath, cli, "release", action, "--ref", ref, "--backup_id", BACKUP_ID], {
            cwd: workspace,
            env: {
                ...environment, SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
                SUPACLOUD_API_TOKEN: "logical-backup-policy-test-token", SUPACLOUD_PROJECT_REF: PROJECT_REF,
                SUPACLOUD_ENV: "production", SUPACLOUD_READ_ONLY: String(readOnly),
            },
            stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    };
    try {
        const observed = await run("logical_backup_status", PROJECT_REF);
        expect(observed.exitCode).toBe(0);
        expect(observed.stdout).toContain("release.logical_backup.status");
        expect(observed.stdout).not.toContain("private_database_name");
        expect(observed.stdout).not.toContain("logical-backup-policy-test-token");
        expect(requests).toEqual([{
            method: "GET", path: `/v1/projects/proj/database/backups/logical/${BACKUP_ID}`,
        }]);
        expect((await run("logical_backup_create", PROJECT_REF)).stderr).toContain("read-only mode");
        expect((await run("logical_backup_status", "other")).stderr).toContain("cannot target a different project");
        expect((await run("logical_backup_create", PROJECT_REF, false)).stderr).toContain("--confirm-production");
        expect(requests).toHaveLength(1);
    } finally {
        server.stop(true);
        rmSync(workspace, { recursive: true, force: true });
    }
}, 15_000);

test("logical backup restore binds the exact inventory identity before and after one mutation", async () => {
    const confirmation = `RESTORE_PROJECT:${PROJECT_REF}:${BACKUP_ID}:${SHA256}`;
    const requests: Array<{ method: "get" | "post"; path: string; body?: unknown }> = [];
    let inventoryReads = 0;
    const callback = captureReleaseTool({
        get: async (path: string) => {
            requests.push({ method: "get", path });
            inventoryReads += 1;
            return { ok: true, status: 200, data: { backups: [verifiedBackup()] } };
        },
        postReleaseMutation: async (path: string, body: unknown) => {
            requests.push({ method: "post", path, body });
            return { ok: true, status: 200, data: { restored_backup: verifiedBackup() } };
        },
    });

    const response = await callback({
        action: "logical_backup_restore",
        backup_id: BACKUP_ID,
        expected_sha256: SHA256,
        restore_confirmation: confirmation,
    });

    expect(requests).toEqual([
        { method: "get", path: "/v1/projects/proj/database/backups/logical" },
        {
            method: "post",
            path: "/v1/projects/proj/database/backups/logical/restore",
            body: { backup_id: BACKUP_ID, expected_sha256: SHA256, confirmation },
        },
        { method: "get", path: "/v1/projects/proj/database/backups/logical" },
    ]);
    expect(inventoryReads).toBe(2);
    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.logical_backup.restore",
        backup: { backup_id: BACKUP_ID, sha256: SHA256 },
    });
    expect(response.content[0].text).not.toContain("private_database_name");
    expect(response.content[0].text).not.toContain("private-receipt-hmac");
});

test.each([
    ["transport failure", { ok: false, status: 500, data: {}, transportError: true }, null],
    ["unreadable response", { ok: false, status: 200, data: {}, responseReadError: true }, 200],
    ["server failure", { ok: false, status: 503, data: {} }, 503],
] as const)("logical backup restore has no retry after a %s", async (_label, mutation, expectedStatus) => {
    let postCalls = 0;
    const callback = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: { backups: [verifiedBackup()] } }),
        postReleaseMutation: async () => {
            postCalls += 1;
            return mutation;
        },
    });

    const response = await callback({
        action: "logical_backup_restore",
        backup_id: BACKUP_ID,
        expected_sha256: SHA256,
        restore_confirmation: `RESTORE_PROJECT:${PROJECT_REF}:${BACKUP_ID}:${SHA256}`,
    });

    expect(postCalls).toBe(1);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.logical_backup.restore",
        error: { code: "OUTCOME_UNKNOWN", http_status: expectedStatus },
    });
});

test("logical backup restore reports an unknown outcome when post-restore inventory is invalid", async () => {
    let inventoryReads = 0;
    const callback = captureReleaseTool({
        get: async () => {
            inventoryReads += 1;
            return {
                ok: true,
                status: 200,
                data: inventoryReads === 1 ? { backups: [verifiedBackup()] } : { backups: [] },
            };
        },
        postReleaseMutation: async () => ({ ok: true, status: 200, data: { restored_backup: verifiedBackup() } }),
    });

    const response = await callback({
        action: "logical_backup_restore",
        backup_id: BACKUP_ID,
        expected_sha256: SHA256,
        restore_confirmation: `RESTORE_PROJECT:${PROJECT_REF}:${BACKUP_ID}:${SHA256}`,
    });

    expect(inventoryReads).toBe(2);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.logical_backup.restore",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
    });
});

test("PostgREST status exposes only the desired, actual, and health fields", async () => {
    const callback = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: healthyPostgrest() }),
    });

    const response = await callback({ action: "postgrest_status" });

    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.postgrest.status",
        postgrest: { desired: "running", actual: "running", health: "healthy" },
    });
    expect(response.content[0].text).not.toContain("private-unit-name");
    expect(response.content[0].text).not.toContain("3000");
});

test("PostgREST restart requires a matching receipt and healthy status readback", async () => {
    const requests: Array<{ method: "get" | "post"; path: string }> = [];
    const callback = captureReleaseTool({
        postReleaseMutation: async (path: string) => {
            requests.push({ method: "post", path });
            return {
                ok: true,
                status: 200,
                data: { service: "postgrest", action: "restart", success: true, private_receipt: "hidden" },
            };
        },
        get: async (path: string) => {
            requests.push({ method: "get", path });
            return { ok: true, status: 200, data: healthyPostgrest() };
        },
    });

    const response = await callback({ action: "postgrest_restart" });

    expect(requests).toEqual([
        { method: "post", path: "/v1/projects/proj/services/postgrest/restart" },
        { method: "get", path: "/v1/projects/proj/services/postgrest/status" },
    ]);
    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.postgrest.restart",
        postgrest: { desired: "running", actual: "running", health: "healthy" },
    });
    expect(response.content[0].text).not.toContain("hidden");
});

test("PostgREST restart fails closed when the healthy readback is absent", async () => {
    const callback = captureReleaseTool({
        postReleaseMutation: async () => ({
            ok: true,
            status: 200,
            data: { service: "postgrest", action: "restart", success: true },
        }),
        get: async () => ({ ok: true, status: 200, data: healthyPostgrest({ health: "unhealthy" }) }),
    });

    const response = await callback({ action: "postgrest_restart" });

    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.postgrest.restart",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
    });
});

test("release-canary fixture stage replay returns only a strict idempotent receipt", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    let endpointReads = 0;
    const callback = captureReleaseTool({
        get: async () => {
            endpointReads += 1;
            return { ok: true, status: 200, data: projectEndpoints() };
        },
    }, {
        postReleaseMutation: async (path: string, body: unknown) => {
            requests.push({ path, body });
            return {
                ok: true,
                status: 200,
                data: {
                    fixtureId: "11111111-1111-4111-8111-111111111111",
                    tenantKey: "release-canary-22222222-2222-4222-8222-222222222222",
                    state: "staged",
                    idempotent: true,
                },
            };
        },
    });
    const privateSubject = "33333333-3333-4333-8333-333333333333";
    const requestId = "44444444-4444-4444-8444-444444444444";

    const response = await callback({
        action: "release_canary_fixture_stage_replay",
        subject: privateSubject,
        request_id: requestId,
    });

    expect(endpointReads).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/rest/v1/rpc/fa_release_canary_fixture_stage");
    expect(requests[0]?.body).toEqual({ p_subject: privateSubject, p_request_id: requestId });
    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.release_canary.fixture_stage_replay",
        project_ref: PROJECT_REF,
        receipt: { state: "staged", idempotent: true },
    });
    expect(response.content[0].text).not.toContain(privateSubject);
});

test("release-canary fixture stage replay fails closed for missing application context and unsafe receipts", async () => {
    const callbackWithoutApplication = captureReleaseTool({});
    await expect(callbackWithoutApplication({
        action: "release_canary_fixture_stage_replay",
        subject: "33333333-3333-4333-8333-333333333333",
        request_id: "44444444-4444-4444-8444-444444444444",
    })).rejects.toThrow("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

    const callbackWithInvalidResponse = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: projectEndpoints() }),
    }, {
        postReleaseMutation: async () => ({
            ok: true,
            status: 200,
            data: {
                fixtureId: "11111111-1111-4111-8111-111111111111",
                tenantKey: "release-canary-22222222-2222-4222-8222-222222222222",
                state: "staged",
                idempotent: true,
                privateEcho: "must-not-be-reflected",
            },
        }),
    });
    const response = await callbackWithInvalidResponse({
        action: "release_canary_fixture_stage_replay",
        subject: "33333333-3333-4333-8333-333333333333",
        request_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.release_canary.fixture_stage_replay",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
    });
    expect(response.content[0].text).not.toContain("must-not-be-reflected");
});

test.each([
    ["invalid subject", { subject: "not-a-uuid", request_id: "44444444-4444-4444-8444-444444444444" }],
    ["invalid request ID", { subject: "33333333-3333-4333-8333-333333333333", request_id: "not-a-uuid" }],
])("release-canary fixture stage replay rejects %s before dispatch", async (_label, input) => {
    let calls = 0;
    const callback = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: {} }),
    }, {
        postReleaseMutation: async () => {
            calls += 1;
            return { ok: true, status: 200, data: {} };
        },
    });
    await expect(callback({ action: "release_canary_fixture_stage_replay", ...input })).rejects.toThrow();
    expect(calls).toBe(0);
});

test("release-canary fixture stage replay refuses an application origin outside the selected project projection", async () => {
    let calls = 0;
    const callback = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: projectEndpoints("https://other.example.test") }),
    }, {
        postReleaseMutation: async () => {
            calls += 1;
            return { ok: true, status: 200, data: {} };
        },
    });

    const response = await callback({
        action: "release_canary_fixture_stage_replay",
        subject: "33333333-3333-4333-8333-333333333333",
        request_id: "44444444-4444-4444-8444-444444444444",
    });

    expect(calls).toBe(0);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.release_canary.fixture_stage_replay",
        error: { code: "INVALID_RESPONSE", http_status: null },
    });
});

test.each([false, true] as const)("release-canary fixture disable replay accepts idempotent=%s and proves pending=false", async (idempotent) => {
    const fixtureId = "11111111-1111-4111-8111-111111111111";
    const disableRequestId = "55555555-5555-4555-8555-555555555555";
    const subject = "33333333-3333-4333-8333-333333333333";
    const issuer = "https://issuer.example.test/auth/v1";
    const managementRequests: string[] = [];
    const applicationRequests: Array<{ method: string; path: string; body?: unknown }> = [];
    const callback = captureReleaseTool({
        get: async (path: string, options: Record<string, unknown>) => {
            managementRequests.push(`${path}:${JSON.stringify(options)}`);
            return { ok: true, status: 200, data: projectEndpoints() };
        },
    }, {
        postReleaseMutation: async (path: string, body: unknown) => {
            applicationRequests.push({ method: "POST", path, body });
            return { ok: true, status: 200, data: { fixtureId, state: "disabled", idempotent } };
        },
        get: async (path: string, options: Record<string, unknown>) => {
            applicationRequests.push({ method: "GET", path, body: options });
            return { ok: true, status: 200, data: false };
        },
    });

    const response = await callback({
        action: "release_canary_fixture_disable_replay",
        fixture_id: fixtureId,
        disable_request_id: disableRequestId,
        issuer,
        subject,
    });

    expect(payload(response)).toMatchObject({
        ok: true,
        operation: "release.release_canary.fixture_disable_replay",
        project_ref: PROJECT_REF,
        receipt: { fixtureId, state: "disabled", idempotent },
        pending: false,
    });
    expect(managementRequests).toHaveLength(2);
    expect(applicationRequests).toEqual([
        {
            method: "POST",
            path: "/rest/v1/rpc/fa_release_canary_fixture_disable",
            body: {
                p_fixture_id: fixtureId,
                p_disable_request_id: disableRequestId,
                p_issuer: issuer,
                p_subject: subject,
            },
        },
        {
            method: "GET",
            path: `/rest/v1/rpc/fa_release_canary_fixture_pending?p_issuer=https%3A%2F%2Fissuer.example.test%2Fauth%2Fv1&p_subject=${subject}`,
            body: { maxJsonBytes: 64 * 1024, responseTimeoutMs: 5_000 },
        },
    ]);
    expect(response.content[0].text).not.toContain(issuer);
    expect(response.content[0].text).not.toContain(subject);
});

test("release-canary fixture disable replay fails closed when pending readback is not authoritative", async () => {
    const fixtureId = "11111111-1111-4111-8111-111111111111";
    const callback = captureReleaseTool({
        get: async () => ({ ok: true, status: 200, data: projectEndpoints() }),
    }, {
        postReleaseMutation: async () => ({ ok: true, status: 200, data: { fixtureId, state: "disabled", idempotent: false } }),
        get: async () => ({ ok: true, status: 200, data: true }),
    });
    const response = await callback({
        action: "release_canary_fixture_disable_replay",
        fixture_id: fixtureId,
        disable_request_id: "55555555-5555-4555-8555-555555555555",
        issuer: "https://issuer.example.test/auth/v1",
        subject: "33333333-3333-4333-8333-333333333333",
    });
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.release_canary.fixture_disable_replay",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
    });
});

test.each([
    ["invalid fixture ID", { fixture_id: "not-a-uuid", disable_request_id: "55555555-5555-4555-8555-555555555555" }],
    ["invalid disable request ID", { fixture_id: "11111111-1111-4111-8111-111111111111", disable_request_id: "not-a-uuid" }],
    ["invalid issuer", { fixture_id: "11111111-1111-4111-8111-111111111111", disable_request_id: "55555555-5555-4555-8555-555555555555", issuer: "javascript:alert(1)" }],
    ["external HTTP issuer", { fixture_id: "11111111-1111-4111-8111-111111111111", disable_request_id: "55555555-5555-4555-8555-555555555555", issuer: "http://issuer.example.test/auth/v1" }],
    ["HTTP issuer without an explicit loopback port", { fixture_id: "11111111-1111-4111-8111-111111111111", disable_request_id: "55555555-5555-4555-8555-555555555555", issuer: "http://127.0.0.1/auth/v1" }],
])("release-canary fixture disable replay rejects %s before dispatch", async (_label, input) => {
    let calls = 0;
    const inputRecord = input as Record<string, string>;
    const callback = captureReleaseTool({ get: async () => ({ ok: true, status: 200, data: projectEndpoints() }) }, {
        postReleaseMutation: async () => {
            calls += 1;
            return { ok: true, status: 200, data: {} };
        },
    });
    await expect(callback({
        action: "release_canary_fixture_disable_replay",
        fixture_id: inputRecord.fixture_id,
        disable_request_id: inputRecord.disable_request_id,
        issuer: inputRecord.issuer ?? "https://issuer.example.test/auth/v1",
        subject: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow();
    expect(calls).toBe(0);
});

test("an unsupported release action cannot issue a mutation", async () => {
    let postCalls = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => {
            postCalls += 1;
            return { ok: true, status: 200, data: {} };
        },
    });

    await expect(callback({ action: "delete_everything" })).rejects.toThrow("- action:");
    expect(postCalls).toBe(0);
});

test("scope_rebind updates single file baseCommit canonically and computes scope_sha256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-rebind-single-"));
    try {
        const oldCommit = "1".repeat(40);
        const newCommit = "2".repeat(40);
        const scopePath = join(dir, "20260907-intake-p1-production.json");
        const initialScope = {
            baseCommit: oldCommit,
            excludedFunctions: ["fa-worker"],
            functions: ["fa-api"],
            migrations: ["20260907120000_init"],
            targetProjectRef: "vxmnblbzsxzutzrjntyu",
            taskId: "FA-INTAKE-P1-PROD",
            web: false,
        };
        writeFileSync(scopePath, JSON.stringify(initialScope, null, 2) + "\n", "utf8");

        const callback = captureReleaseTool({});
        const response = await callback({
            action: "scope_rebind",
            file: scopePath,
            base_commit: newCommit,
            cwd: dir,
        });

        const result = payload(response);
        expect(result).toMatchObject({
            ok: true,
            operation: "release.scope_rebind",
            base_commit: newCommit,
            count: 1,
            updated_count: 1,
            scopes: [{
                previous_base_commit: oldCommit,
                new_base_commit: newCommit,
                updated: true,
            }],
        });

        const updatedContent = readFileSync(scopePath, "utf8");
        const parsed = JSON.parse(updatedContent);
        expect(parsed.baseCommit).toBe(newCommit);
        expect(parsed.taskId).toBe("FA-INTAKE-P1-PROD");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scope_rebind handles dry_run and unchanged baseCommit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-rebind-dry-"));
    try {
        const oldCommit = "3".repeat(40);
        const newCommit = "4".repeat(40);
        const scopePath = join(dir, "scope.json");
        const initialScope = {
            baseCommit: oldCommit,
            excludedFunctions: [],
            functions: [],
            migrations: [],
            targetProjectRef: "vxmnblbzsxzutzrjntyu",
            taskId: "FA-TASK-1",
            web: true,
        };
        writeFileSync(scopePath, JSON.stringify(initialScope, null, 2) + "\n", "utf8");

        const callback = captureReleaseTool({});
        const dryResponse = await callback({
            action: "scope_rebind",
            file: scopePath,
            base_commit: newCommit,
            dry_run: true,
            cwd: dir,
        });
        const dryResult = payload(dryResponse);
        expect(dryResult.dry_run).toBe(true);
        expect(dryResult.updated_count).toBe(1);
        expect(JSON.parse(readFileSync(scopePath, "utf8")).baseCommit).toBe(oldCommit);

        const unchangedResponse = await callback({
            action: "scope_rebind",
            file: scopePath,
            base_commit: oldCommit,
            cwd: dir,
        });
        const unchangedResult = payload(unchangedResponse);
        expect(unchangedResult.updated_count).toBe(0);
        expect(unchangedResult.scopes[0].updated).toBe(false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scope_rebind updates multiple files and scans directories by task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-rebind-multi-"));
    try {
        const scopesDir = join(dir, "supacloud/fa/release-scopes");
        mkdirSync(scopesDir, { recursive: true });
        const oldCommit = "5".repeat(40);
        const newCommit = "6".repeat(40);
        const prodPath = join(scopesDir, "20260907-intake-p1-production.json");
        const stagingPath = join(scopesDir, "20260907-intake-p1-staging.json");
        writeFileSync(prodPath, JSON.stringify({
            baseCommit: oldCommit,
            excludedFunctions: [],
            functions: [],
            migrations: [],
            targetProjectRef: "vxmnblbzsxzutzrjntyu",
            taskId: "FA-INTAKE-P1-PROD",
            web: false,
        }, null, 2) + "\n", "utf8");
        writeFileSync(stagingPath, JSON.stringify({
            baseCommit: oldCommit,
            excludedFunctions: [],
            functions: [],
            migrations: [],
            targetProjectRef: "stagingprojectref1234",
            taskId: "FA-INTAKE-P1-STAGING",
            web: false,
        }, null, 2) + "\n", "utf8");

        const callback = captureReleaseTool({});
        const response = await callback({
            action: "scope_rebind",
            task: "20260907-intake-p1",
            base_commit: newCommit,
            cwd: dir,
        });

        const result = payload(response);
        expect(result.count).toBe(2);
        expect(result.updated_count).toBe(2);
        expect(JSON.parse(readFileSync(prodPath, "utf8")).baseCommit).toBe(newCommit);
        expect(JSON.parse(readFileSync(stagingPath, "utf8")).baseCommit).toBe(newCommit);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scope_inspect verifies structure and computes canonical scope_sha256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-inspect-"));
    try {
        const commit = "7".repeat(40);
        const scopePath = join(dir, "scope.json");
        writeFileSync(scopePath, JSON.stringify({
            baseCommit: commit,
            excludedFunctions: ["fa-b"],
            functions: ["fa-a"],
            migrations: ["20260907120000_test"],
            targetProjectRef: "vxmnblbzsxzutzrjntyu",
            taskId: "FA-TASK-INSPECT",
            web: false,
        }, null, 2) + "\n", "utf8");

        const callback = captureReleaseTool({});
        const response = await callback({
            action: "scope_inspect",
            file: scopePath,
            cwd: dir,
        });

        const result = payload(response);
        expect(result.ok).toBe(true);
        expect(result.operation).toBe("release.scope_inspect");
        expect(result.scope.task_id).toBe("FA-TASK-INSPECT");
        expect(result.scope.base_commit).toBe(commit);
        expect(typeof result.scope.scope_sha256).toBe("string");
        expect(result.scope.scope_sha256).toHaveLength(64);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scope_create scaffolds a canonical scope manifest with resolved baseCommit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-create-"));
    try {
        const commit = "8".repeat(40);
        const scopePath = join(dir, "supacloud/fa/release-scopes/20260907-new.json");

        const callback = captureReleaseTool({});
        const response = await callback({
            action: "scope_create",
            file: scopePath,
            task: "FA-NEW-TASK",
            ref: "vxmnblbzsxzutzrjntyu",
            base_commit: commit,
            functions: "fa-api, fa-worker",
            migrations: "20260907120000_first, 20260907130000_second",
            web: true,
            cwd: dir,
        });

        const result = payload(response);
        expect(result.ok).toBe(true);
        expect(result.operation).toBe("release.scope_create");
        expect(result.base_commit).toBe(commit);
        expect(typeof result.scope_sha256).toBe("string");
        expect(result.scope_sha256).toHaveLength(64);

        const created = JSON.parse(readFileSync(scopePath, "utf8"));
        expect(created).toEqual({
            baseCommit: commit,
            excludedFunctions: [],
            functions: ["fa-api", "fa-worker"],
            migrations: ["20260907120000_first", "20260907130000_second"],
            targetProjectRef: "vxmnblbzsxzutzrjntyu",
            taskId: "FA-NEW-TASK",
            web: true,
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
