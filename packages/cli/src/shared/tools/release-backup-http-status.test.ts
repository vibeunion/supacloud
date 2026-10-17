import { expect, test } from "bun:test";
import { registerReleaseTools } from "./release-tools";
import type { ToolInvocation } from "../tool-server";
import type { HttpResult, HttpTransport } from "../transports/http";

const ref = "proj";
const backupId = `logical-full_${ref}_${"b".repeat(32)}`;
const sha256 = "a".repeat(64);
const path = `/v1/projects/${ref}/database/backups/logical`;
const statuses: number[] = [201, 202, 204, 206, 299];
const backup = {
    backup_id: backupId, project_ref: ref, database: "private-database-marker", kind: "logical-full",
    created_at: "2026-10-10T00:00:00.000Z", completed_at: "2026-10-10T00:00:01.000Z",
    bytes: 42, sha256, receipt_hmac_sha256: "private-hmac-marker",
};

function fixture(mutationStatus: number, readStatus = 200) {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let handler: ToolInvocation | undefined;
    registerReleaseTools({
        tool(name, _description, _schema, callback) { if (name === "release") handler = callback; },
    }, {
        get: async (url: string): Promise<HttpResult<unknown>> => {
            requests.push({ method: "GET", path: url });
            const data = url.endsWith("/postgrest/status")
                ? { component: "postgrest", desired: "running", actual: "running", health: "healthy" }
                : url === path ? { backups: [backup] } : { backup };
            return { ok: readStatus >= 200 && readStatus < 300, status: readStatus, data };
        },
        postReleaseMutation: async (url: string, body: unknown): Promise<HttpResult<unknown>> => {
            requests.push({ method: "POST", path: url, body });
            return { ok: mutationStatus >= 200 && mutationStatus < 300, status: mutationStatus,
                data: { backup, restored_backup: backup, service: "postgrest", action: "restart", success: true } };
        },
    } as unknown as HttpTransport, { projectRef: ref });
    if (!handler) throw new Error("Missing release tool");
    return { handler, requests };
}

for (const readStatus of [200, 202, 404]) {
    test.each(statuses)(`backup create HTTP %i remains unknown after exact readback HTTP ${readStatus}`, async status => {
        const f = fixture(status, readStatus);
        const response = await f.handler({ action: "logical_backup_create", backup_id: backupId });
        const result = JSON.parse(response.content[0]!.text);
        expect(response.isError).toBe(true);
        expect(result).toMatchObject({
            ok: false, operation: "release.logical_backup.create", project_ref: ref, backup_id: backupId,
            error: { code: "OUTCOME_UNKNOWN", http_status: status },
        });
        expect(f.requests).toEqual([
            { method: "POST", path, body: { backup_id: backupId } },
            { method: "GET", path: `${path}/${backupId}` },
        ]);
        if (readStatus === 200) {
            expect(result).toMatchObject({ backup_verified: true, creation_confirmed: false,
                backup: { backup_id: backupId, sha256 } });
        } else {
            expect(result.backup_verified).toBeUndefined();
            expect(result.backup).toBeUndefined();
        }
        expect(response.content[0]!.text).not.toContain("private-");
    });
}

test.each(statuses)("backup status HTTP %i is an invalid observation, not success or a mutation", async status => {
    const f = fixture(200, status);
    const response = await f.handler({ action: "logical_backup_status", backup_id: backupId });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({
        ok: false, project_ref: ref, backup_id: backupId,
        error: { code: "INVALID_RESPONSE", http_status: status },
    });
    expect(f.requests).toEqual([{ method: "GET", path: `${path}/${backupId}` }]);
    expect(response.content[0]!.text).not.toContain("private-");
});

test.each([401, 403, 409])("definite backup create rejection HTTP %i does not trigger observation or retry", async status => {
    const f = fixture(status);
    const response = await f.handler({ action: "logical_backup_create", backup_id: backupId });
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({
        ok: false, backup_id: backupId, error: { code: "HTTP_ERROR", http_status: status },
    });
    expect(f.requests).toEqual([{ method: "POST", path, body: { backup_id: backupId } }]);
});

test("only HTTP 200 plus matching exact readback confirms backup creation", async () => {
    const f = fixture(200);
    const response = await f.handler({ action: "logical_backup_create", backup_id: backupId });
    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({
        ok: true, project_ref: ref, backup_id: backupId, backup: { backup_id: backupId, sha256 },
    });
    expect(f.requests.map(request => request.method)).toEqual(["POST", "GET"]);
    expect(response.content[0]!.text).not.toContain("private-");
});

for (const action of ["logical_backup_restore", "postgrest_restart"] as const) {
    test.each(statuses)(`${action} HTTP %i cannot confirm completion or trigger a second write`, async status => {
        const f = fixture(status);
        const response = await f.handler({ action, ...(action === "logical_backup_restore" ? {
            backup_id: backupId, expected_sha256: sha256,
            restore_confirmation: `RESTORE_PROJECT:${ref}:${backupId}:${sha256}`,
        } : {}) });
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0]!.text)).toMatchObject({
            ok: false, error: { code: "OUTCOME_UNKNOWN", http_status: status },
        });
        expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1);
        expect(response.content[0]!.text).not.toContain("private-");
    });
}
