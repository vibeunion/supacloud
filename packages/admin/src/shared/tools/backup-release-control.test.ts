import { describe, expect, test } from "bun:test";
import { createFullPhysicalBackup, listPhysicalBackups } from "./backup-release-control";

const EXISTING_BACKUP = {
    id: "20260811-010000F",
    type: "full",
    timestamp: { start: 1_786_400_000, stop: 1_786_400_030 },
    size: 4096,
    database: "supa_fa_staging",
};

const NEW_BACKUP = {
    id: "20260811-020000F",
    type: "full",
    timestamp: { start: 1_786_403_600, stop: 1_786_403_660 },
    size: 8192,
    database: "supa_fa_staging",
};

function parsed(response: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

describe("admin physical backup release control", () => {
    test("creates an explicit full backup and returns exact completed evidence", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown; timeoutMs?: number }> = [];
        let inventoryRead = 0;
        const http = {
            get: async (path: string) => {
                calls.push({ method: "GET", path });
                inventoryRead += 1;
                return {
                    ok: true,
                    status: 200,
                    data: inventoryRead === 1 ? [EXISTING_BACKUP] : [EXISTING_BACKUP, {
                        ...NEW_BACKUP,
                        token: "remote-token-must-not-escape",
                    }],
                };
            },
            post: async (path: string, body: unknown, options: { timeoutMs: number }) => {
                calls.push({ method: "POST", path, body, timeoutMs: options.timeoutMs });
                return { ok: true, status: 200, data: { message: "full backup completed" } };
            },
        };

        const response = await createFullPhysicalBackup(http as never, "fa_staging");

        expect(response.isError).not.toBe(true);
        expect(parsed(response)).toEqual({
            project_ref: "fa_staging",
            requested_type: "full",
            backup: NEW_BACKUP,
        });
        expect(response.content[0].text).not.toContain("remote-token-must-not-escape");
        expect(calls).toEqual([
            { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
            {
                method: "POST",
                path: "/v1/projects/fa_staging/database/backups",
                body: { type: "full" },
                timeoutMs: 35 * 60_000,
            },
            { method: "GET", path: "/v1/projects/fa_staging/database/backups" },
        ]);
    });

    test("fails before mutation when the initial inventory is malformed", async () => {
        let postCount = 0;
        let inventoryRead = 0;
        const http = {
            get: async () => {
                inventoryRead += 1;
                return {
                    ok: true,
                    status: 200,
                    data: [{
                        ...EXISTING_BACKUP,
                        ...(inventoryRead === 1
                            ? { size: -1 }
                            : { timestamp: { start: 1_786_400_030, stop: 1_786_400_000 } }),
                    }],
                };
            },
            post: async () => {
                postCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        };

        const response = await createFullPhysicalBackup(http as never, "fa_staging");

        expect(response.isError).toBe(true);
        expect(parsed(response).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
        expect(postCount).toBe(0);

        const reversedTimestamp = await createFullPhysicalBackup(http as never, "fa_staging");
        expect(parsed(reversedTimestamp).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
        expect(postCount).toBe(0);
    });

    test("reconciles a failed mutation and reports an unknown server outcome without reflection", async () => {
        const calls: string[] = [];
        const http = {
            get: async () => {
                calls.push("GET");
                return { ok: true, status: 200, data: [EXISTING_BACKUP] };
            },
            post: async () => {
                calls.push("POST");
                return {
                    ok: false, status: 503,
                    data: { token: "remote-backup-secret", message: "remote detail" },
                };
            },
        };

        const response = await createFullPhysicalBackup(http as never, "fa_staging");

        expect(response.isError).toBe(true);
        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 503 });
        expect(calls).toEqual(["GET", "POST", "GET"]);
        expect(response.content[0].text).not.toContain("remote-backup-secret");
        expect(response.content[0].text).not.toContain("remote detail");
    });

    test.each([400, 401, 403, 409, 429])(
        "reconciles deterministic client error %d and classifies it as an HTTP error",
        async (statusCode) => {
            const calls: string[] = [];
            const response = await createFullPhysicalBackup({
                get: async () => {
                    calls.push("GET");
                    return { ok: true, status: 200, data: [EXISTING_BACKUP] };
                },
                post: async () => {
                    calls.push("POST");
                    return { ok: false, status: statusCode, data: { secret: "client-error-secret" } };
                },
            } as never, "fa_staging");

            expect(parsed(response).error).toEqual({ code: "HTTP_ERROR", http_status: statusCode });
            expect(calls).toEqual(["GET", "POST", "GET"]);
            expect(response.content[0].text).not.toContain("client-error-secret");
        },
    );

    test("keeps a request-timeout mutation outcome unknown after reconciliation", async () => {
        let inventoryReads = 0;
        const response = await createFullPhysicalBackup({
            get: async () => {
                inventoryReads += 1;
                return { ok: true, status: 200, data: [EXISTING_BACKUP] };
            },
            post: async () => ({ ok: false, status: 408, data: null }),
        } as never, "fa_staging");

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 408 });
        expect(inventoryReads).toBe(2);
    });

    test("keeps an unacknowledged timed-out outcome unknown even when reconciliation sees a completed backup", async () => {
        let inventoryReads = 0;
        let postCount = 0;
        const response = await createFullPhysicalBackup({
            get: async () => ({
                ok: true,
                status: 200,
                data: inventoryReads++ === 0
                    ? [EXISTING_BACKUP]
                    : [EXISTING_BACKUP, NEW_BACKUP],
            }),
            post: async () => {
                postCount++;
                return { ok: false, status: 500, data: null };
            },
        } as never, "fa_staging");

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 500 });
        expect(inventoryReads).toBe(2);
        expect(postCount).toBe(1);
    });

    test("reconciles malformed success before reporting an unknown outcome", async () => {
        const calls: string[] = [];
        const malformedReceipt = await createFullPhysicalBackup({
            get: async () => {
                calls.push("GET");
                return { ok: true, status: 200, data: [EXISTING_BACKUP] };
            },
            post: async () => {
                calls.push("POST");
                return { ok: true, status: 200, data: { message: "started" } };
            },
        } as never, "fa_staging");

        expect(parsed(malformedReceipt).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
        expect(calls).toEqual(["GET", "POST", "GET"]);
    });

    test("rejects zero-sized and ambiguous completed full backup evidence", async () => {
        let inventoryRead = 0;
        const zeroSizedBackup = await createFullPhysicalBackup({
            get: async () => ({
                ok: true,
                status: 200,
                data: inventoryRead++ === 0
                    ? [EXISTING_BACKUP]
                    : [EXISTING_BACKUP, { ...NEW_BACKUP, size: 0 }],
            }),
            post: async () => ({ ok: true, status: 200, data: { message: "full backup completed" } }),
        } as never, "fa_staging");
        inventoryRead = 0;
        const ambiguousInventory = await createFullPhysicalBackup({
            get: async () => {
                inventoryRead += 1;
                return {
                    ok: true,
                    status: 200,
                    data: inventoryRead === 1
                        ? [EXISTING_BACKUP]
                        : [EXISTING_BACKUP, NEW_BACKUP, { ...NEW_BACKUP, id: "20260811-030000F" }],
                };
            },
            post: async () => ({ ok: true, status: 200, data: { message: "full backup completed" } }),
        } as never, "fa_staging");

        expect(parsed(zeroSizedBackup).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
        expect(parsed(ambiguousInventory).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("lists only sanitized, duplicate-free physical backup records", async () => {
        const safeList = await listPhysicalBackups({
            get: async () => ({ ok: true, status: 200, data: [{ ...EXISTING_BACKUP, secret: "hidden" }] }),
        } as never, "fa_staging");
        const duplicateList = await listPhysicalBackups({
            get: async () => ({ ok: true, status: 200, data: [EXISTING_BACKUP, EXISTING_BACKUP] }),
        } as never, "fa_staging");

        expect(JSON.parse(safeList.content[0].text)).toEqual([EXISTING_BACKUP]);
        expect(safeList.content[0].text).not.toContain("hidden");
        expect(parsed(duplicateList).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
    });

    test("rejects unsafe project refs before HTTP dispatch", async () => {
        let requestCount = 0;
        const http = {
            get: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: [] };
            },
        };

        await expect(listPhysicalBackups(http as never, "../fa")).rejects.toThrow("invalid for physical backup");
        expect(requestCount).toBe(0);
    });
});
