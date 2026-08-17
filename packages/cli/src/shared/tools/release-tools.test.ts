import { expect, test } from "bun:test";
import { registerReleaseTools } from "./release-tools";

const PROJECT_REF = "proj";
const CREATED_AT = "2026-08-17T00:00:00.000Z";
const COMPLETED_AT = "2026-08-17T00:00:01.000Z";
const SHA256 = "a".repeat(64);
const BACKUP_ID = `logical-full_${PROJECT_REF}_${"b".repeat(32)}`;

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

function captureReleaseTool(http: Record<string, unknown>): ReleaseCallback {
    let callback: ReleaseCallback | undefined;
    registerReleaseTools({
        tool(name, _description, _schema, toolCallback) {
            if (name === "release") callback = toolCallback;
        },
    }, http as never, { projectRef: PROJECT_REF });
    if (!callback) throw new Error("release tool was not registered");
    return callback;
}

function payload(response: ToolResult): Record<string, unknown> {
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
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

test("logical backup create requires matching pre/post inventory evidence", async () => {
    const requests: Array<{ method: "get" | "post"; path: string; options?: Record<string, unknown> }> = [];
    let inventoryReads = 0;
    const callback = captureReleaseTool({
        get: async (path: string, options: Record<string, unknown>) => {
            requests.push({ method: "get", path, options });
            inventoryReads += 1;
            return {
                ok: true,
                status: 200,
                data: { backups: inventoryReads === 1 ? [] : [verifiedBackup()] },
            };
        },
        postReleaseMutation: async (path: string, _body: unknown, options: Record<string, unknown>) => {
            requests.push({ method: "post", path, options });
            return { ok: true, status: 200, data: { backup: verifiedBackup() } };
        },
    });

    const response = await callback({ action: "logical_backup_create" });
    const result = payload(response);

    expect(requests).toEqual([
        {
            method: "get",
            path: "/v1/projects/proj/database/backups/logical",
            options: { maxJsonBytes: 1024 * 1024, responseTimeoutMs: 5_000 },
        },
        {
            method: "post",
            path: "/v1/projects/proj/database/backups/logical",
            options: { timeoutMs: 36 * 60_000 },
        },
        {
            method: "get",
            path: "/v1/projects/proj/database/backups/logical",
            options: { maxJsonBytes: 1024 * 1024, responseTimeoutMs: 5_000 },
        },
    ]);
    expect(result).toMatchObject({
        ok: true,
        operation: "release.logical_backup.create",
        backup: { backup_id: BACKUP_ID, sha256: SHA256 },
    });
});

test("logical backup create fails closed when post-mutation inventory is ambiguous", async () => {
    const secondBackup = verifiedBackup({ backup_id: `logical-full_${PROJECT_REF}_${"c".repeat(32)}` });
    let inventoryReads = 0;
    const callback = captureReleaseTool({
        get: async () => {
            inventoryReads += 1;
            return {
                ok: true,
                status: 200,
                data: { backups: inventoryReads === 1 ? [] : [verifiedBackup(), secondBackup] },
            };
        },
        postReleaseMutation: async () => ({ ok: true, status: 200, data: { backup: verifiedBackup() } }),
    });

    const response = await callback({ action: "logical_backup_create" });

    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
        ok: false,
        operation: "release.logical_backup.create",
        error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
    });
    expect(response.content[0].text).not.toContain("private_database_name");
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

test("an unsupported release action cannot issue a mutation", async () => {
    let postCalls = 0;
    const callback = captureReleaseTool({
        postReleaseMutation: async () => {
            postCalls += 1;
            return { ok: true, status: 200, data: {} };
        },
    });

    await expect(callback({ action: "delete_everything" })).rejects.toThrow("Unknown release control action");
    expect(postCalls).toBe(0);
});
