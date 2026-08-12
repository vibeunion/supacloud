import { describe, expect, test } from "bun:test";
import {
    createVerifiedLogicalBackup,
    listVerifiedLogicalBackups,
    restoreVerifiedLogicalBackup,
} from "./logical-backup-control";

const PROJECT_REF = "fa_staging";
const BACKUP_ID = "logical-full_fa_staging_0123456789abcdef0123456789abcdef";
const SHA256 = "a".repeat(64);
const BACKUP = {
    backup_id: BACKUP_ID,
    project_ref: PROJECT_REF,
    database: "supa_fa_staging",
    kind: "logical-full",
    created_at: "2026-08-12T00:00:00.000Z",
    completed_at: "2026-08-12T00:00:01.000Z",
    bytes: 8_192,
    sha256: SHA256,
};
const PREVIOUS_BACKUP = {
    ...BACKUP,
    backup_id: "logical-full_fa_staging_fedcba9876543210fedcba9876543210",
    created_at: "2026-08-11T00:00:00.000Z",
    completed_at: "2026-08-11T00:00:01.000Z",
    sha256: "b".repeat(64),
};
const CONFIRMATION = `RESTORE_PROJECT:${PROJECT_REF}:${BACKUP_ID}:${SHA256}`;

function parsed(response: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

describe("Admin verified logical backup control", () => {
    test("lists a fixed, duplicate-free identity projection", async () => {
        let getOptions: unknown;
        const response = await listVerifiedLogicalBackups({
            get: async (_path: string, options: unknown) => {
                getOptions = options;
                return {
                    ok: true,
                    status: 200,
                    data: { backups: [{ ...BACKUP, receipt_hmac_sha256: "remote-secret" }] },
                };
            },
        } as never, PROJECT_REF);

        expect(response.isError).not.toBe(true);
        expect(parsed(response)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "platform.list_logical_backups",
            project_ref: PROJECT_REF,
            backups: [BACKUP],
        });
        expect(getOptions).toEqual({ maxJsonBytes: 1024 * 1024 });
        expect(response.content[0]!.text).not.toContain("remote-secret");
    });

    test.each([
        { backups: [BACKUP, BACKUP] },
        { backups: [{ ...BACKUP, project_ref: "other_project" }] },
        { backups: [{ ...BACKUP, backup_id: `${BACKUP_ID}0` }] },
        { backups: [{ ...BACKUP, sha256: SHA256.toUpperCase() }] },
        { backups: [{ ...BACKUP, bytes: 0 }] },
        { backups: [{ ...BACKUP, database: "unsafe\ndatabase" }] },
        { backups: [{ ...BACKUP, completed_at: "2026-08-11T23:59:59.000Z" }] },
        { backups: "remote-secret" },
    ])("rejects malformed or duplicate inventory %# without reflection", async (payload) => {
        const response = await listVerifiedLogicalBackups({
            get: async () => ({ ok: true, status: 200, data: { ...payload, token: "remote-secret" } }),
        } as never, PROJECT_REF);

        expect(response.isError).toBe(true);
        expect(parsed(response).error).toEqual({ code: "INVALID_RESPONSE", http_status: 200 });
        expect(response.content[0]!.text).not.toContain("remote-secret");
    });

    test("creates only when the response and one new verified inventory identity agree", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown; options?: unknown }> = [];
        let inventoryRead = 0;
        const response = await createVerifiedLogicalBackup({
            get: async (path: string, options: unknown) => {
                calls.push({ method: "GET", path, options });
                inventoryRead += 1;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        backups: inventoryRead === 1
                            ? [PREVIOUS_BACKUP]
                            : [BACKUP, PREVIOUS_BACKUP],
                    },
                };
            },
            post: async (path: string, body: unknown, options: unknown) => {
                calls.push({ method: "POST", path, body, options });
                return {
                    ok: true,
                    status: 200,
                    data: { backup: { ...BACKUP, archive_path: "/private/archive" }, token: "remote-secret" },
                };
            },
        } as never, PROJECT_REF);

        expect(response.isError).not.toBe(true);
        expect(parsed(response)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "platform.create_logical_backup",
            project_ref: PROJECT_REF,
            backup: BACKUP,
        });
        expect(calls).toEqual([
            {
                method: "GET",
                path: `/v1/projects/${PROJECT_REF}/database/backups/logical`,
                options: { maxJsonBytes: 1024 * 1024 },
            },
            {
                method: "POST",
                path: `/v1/projects/${PROJECT_REF}/database/backups/logical`,
                body: {},
                options: { timeoutMs: 36 * 60_000, maxJsonBytes: 64 * 1024 },
            },
            {
                method: "GET",
                path: `/v1/projects/${PROJECT_REF}/database/backups/logical`,
                options: { maxJsonBytes: 1024 * 1024 },
            },
        ]);
        expect(response.content[0]!.text).not.toContain("remote-secret");
        expect(response.content[0]!.text).not.toContain("/private/archive");
    });

    test("fails closed when create evidence is missing, ambiguous, mismatched, or destructive", async () => {
        const afterInventories = [
            [PREVIOUS_BACKUP],
            [PREVIOUS_BACKUP, BACKUP, { ...BACKUP, backup_id: "logical-full_fa_staging_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
            [PREVIOUS_BACKUP, { ...BACKUP, sha256: "c".repeat(64) }],
            [BACKUP],
            [BACKUP, { ...PREVIOUS_BACKUP, bytes: PREVIOUS_BACKUP.bytes + 1 }],
        ];
        for (const afterInventory of afterInventories) {
            let inventoryRead = 0;
            const response = await createVerifiedLogicalBackup({
                get: async () => ({
                    ok: true,
                    status: 200,
                    data: { backups: inventoryRead++ === 0 ? [PREVIOUS_BACKUP] : afterInventory },
                }),
                post: async () => ({
                    ok: true,
                    status: 200,
                    data: { backup: BACKUP, internal: "create-secret" },
                }),
            } as never, PROJECT_REF);

            expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
            expect(response.content[0]!.text).not.toContain("create-secret");
        }
    });

    test("rejects a noncanonical successful HTTP status for create and restore", async () => {
        let inventoryRead = 0;
        const create = await createVerifiedLogicalBackup({
            get: async () => ({
                ok: true,
                status: 200,
                data: { backups: inventoryRead++ === 0 ? [PREVIOUS_BACKUP] : [PREVIOUS_BACKUP, BACKUP] },
            }),
            post: async () => ({ ok: true, status: 201, data: { backup: BACKUP } }),
        } as never, PROJECT_REF);
        const restore = await restoreVerifiedLogicalBackup({
            get: async () => ({ ok: true, status: 200, data: { backups: [BACKUP] } }),
            post: async () => ({ ok: true, status: 201, data: { restored_backup: BACKUP } }),
        } as never, {
            projectRef: PROJECT_REF,
            backupId: BACKUP_ID,
            expectedSha256: SHA256,
            confirmation: CONFIRMATION,
        });

        expect(parsed(create).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 201 });
        expect(parsed(restore).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 201 });
    });

    test("rejects noncanonical inventory statuses and strips transport status", async () => {
        let createPostCount = 0;
        const listed = await listVerifiedLogicalBackups({
            get: async () => ({ ok: true, status: 201, data: { backups: [] } }),
        } as never, PROJECT_REF);
        const created = await createVerifiedLogicalBackup({
            get: async () => ({
                ok: false,
                status: 500,
                data: { token: "transport-secret" },
                transportError: true,
            }),
            post: async () => {
                createPostCount += 1;
                return { ok: true, status: 200, data: { backup: BACKUP } };
            },
        } as never, PROJECT_REF);

        expect(parsed(listed).error).toEqual({ code: "INVALID_RESPONSE", http_status: 201 });
        expect(parsed(created).error).toEqual({ code: "HTTP_ERROR", http_status: null });
        expect(created.content[0]!.text).not.toContain("transport-secret");
        expect(createPostCount).toBe(0);
    });

    test("requires a canonical post-create inventory response", async () => {
        let inventoryRead = 0;
        const response = await createVerifiedLogicalBackup({
            get: async () => ({
                ok: true,
                status: inventoryRead++ === 0 ? 200 : 201,
                data: { backups: inventoryRead === 1 ? [PREVIOUS_BACKUP] : [PREVIOUS_BACKUP, BACKUP] },
            }),
            post: async () => ({ ok: true, status: 200, data: { backup: BACKUP } }),
        } as never, PROJECT_REF);

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test.each([
        [{ ok: false, status: 400, data: { message: "client-secret" } }, "HTTP_ERROR", 400],
        [{ ok: false, status: 408, data: { message: "timeout-secret" } }, "OUTCOME_UNKNOWN", 408],
        [{ ok: false, status: 503, data: { message: "server-secret" } }, "OUTCOME_UNKNOWN", 503],
        [{ ok: false, status: 500, data: { message: "transport-secret" }, transportError: true }, "OUTCOME_UNKNOWN", null],
        [{ ok: false, status: 200, data: { message: "read-secret" }, responseError: true }, "OUTCOME_UNKNOWN", 200],
    ] as const)("classifies create mutation failure without remote reflection", async (mutation, code, status) => {
        let inventoryRead = 0;
        const response = await createVerifiedLogicalBackup({
            get: async () => {
                inventoryRead += 1;
                return { ok: true, status: 200, data: { backups: [PREVIOUS_BACKUP] } };
            },
            post: async () => mutation,
        } as never, PROJECT_REF);

        expect(parsed(response).error).toEqual({ code, http_status: status });
        expect(inventoryRead).toBe(2);
        expect(response.content[0]!.text).not.toContain("secret");
    });

    test("restores an inventory-bound identity with the exact request contract", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown; options?: unknown }> = [];
        const response = await restoreVerifiedLogicalBackup({
            get: async (path: string, options: unknown) => {
                calls.push({ method: "GET", path, options });
                return { ok: true, status: 200, data: { backups: [BACKUP] } };
            },
            post: async (path: string, body: unknown, options: unknown) => {
                calls.push({ method: "POST", path, body, options });
                return {
                    ok: true,
                    status: 200,
                    data: { restored_backup: { ...BACKUP, receipt_hmac_sha256: "restore-secret" } },
                };
            },
        } as never, {
            projectRef: PROJECT_REF,
            backupId: BACKUP_ID,
            expectedSha256: SHA256,
            confirmation: CONFIRMATION,
        });

        expect(response.isError).not.toBe(true);
        expect(parsed(response)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "platform.restore_logical_backup",
            project_ref: PROJECT_REF,
            restored_backup: BACKUP,
        });
        expect(calls).toEqual([
            {
                method: "GET",
                path: `/v1/projects/${PROJECT_REF}/database/backups/logical`,
                options: { maxJsonBytes: 1024 * 1024 },
            },
            {
                method: "POST",
                path: `/v1/projects/${PROJECT_REF}/database/backups/logical/restore`,
                body: {
                    backup_id: BACKUP_ID,
                    expected_sha256: SHA256,
                    confirmation: CONFIRMATION,
                },
                options: { timeoutMs: 36 * 60_000, maxJsonBytes: 64 * 1024 },
            },
        ]);
        expect(response.content[0]!.text).not.toContain("restore-secret");
    });

    test("rejects missing inventory identity and digest mismatch before restore POST", async () => {
        let postCount = 0;
        for (const backups of [[], [{ ...BACKUP, sha256: "c".repeat(64) }]]) {
            const response = await restoreVerifiedLogicalBackup({
                get: async () => ({ ok: true, status: 200, data: { backups } }),
                post: async () => {
                    postCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
            } as never, {
                projectRef: PROJECT_REF,
                backupId: BACKUP_ID,
                expectedSha256: SHA256,
                confirmation: CONFIRMATION,
            });

            expect(parsed(response).error).toEqual({ code: "INVALID_RESPONSE", http_status: 200 });
        }
        expect(postCount).toBe(0);
    });

    test("treats a mismatched or malformed restore success as outcome unknown", async () => {
        for (const restoredBackup of [
            { ...BACKUP, backup_id: "logical-full_fa_staging_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            { ...BACKUP, sha256: "c".repeat(64) },
            null,
        ]) {
            const response = await restoreVerifiedLogicalBackup({
                get: async () => ({ ok: true, status: 200, data: { backups: [BACKUP] } }),
                post: async () => ({
                    ok: true,
                    status: 200,
                    data: { restored_backup: restoredBackup, internal: "restore-response-secret" },
                }),
            } as never, {
                projectRef: PROJECT_REF,
                backupId: BACKUP_ID,
                expectedSha256: SHA256,
                confirmation: CONFIRMATION,
            });

            expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
            expect(response.content[0]!.text).not.toContain("restore-response-secret");
        }
    });

    test("rejects unsafe restore bindings before HTTP dispatch", async () => {
        let requestCount = 0;
        const http = {
            get: async () => { requestCount += 1; return { ok: true, status: 200, data: { backups: [] } }; },
            post: async () => { requestCount += 1; return { ok: true, status: 200, data: {} }; },
        };

        await expect(listVerifiedLogicalBackups(http as never, "../fa"))
            .rejects.toThrow("invalid for verified logical backup");
        await expect(restoreVerifiedLogicalBackup(http as never, {
            projectRef: PROJECT_REF,
            backupId: "logical-full_fa_staging_extra_0123456789abcdef0123456789abcdef",
            expectedSha256: SHA256,
            confirmation: CONFIRMATION,
        })).rejects.toThrow("must belong");
        await expect(restoreVerifiedLogicalBackup(http as never, {
            projectRef: PROJECT_REF,
            backupId: BACKUP_ID,
            expectedSha256: SHA256.toUpperCase(),
            confirmation: CONFIRMATION,
        })).rejects.toThrow("64 lowercase");
        await expect(restoreVerifiedLogicalBackup(http as never, {
            projectRef: PROJECT_REF,
            backupId: BACKUP_ID,
            expectedSha256: SHA256,
            confirmation: "RESTORE_PROJECT",
        })).rejects.toThrow("exactly bind");
        expect(requestCount).toBe(0);
    });
});
