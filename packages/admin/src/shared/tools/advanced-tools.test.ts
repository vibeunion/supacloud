import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import { registerAdvancedTools } from "./advanced-tools";

type ToolResponse = { content: Array<{ text: string }>; isError?: boolean };

function platformTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<ToolResponse>) | undefined;
    registerAdvancedTools({
        tool(name, _description, toolSchema, toolCallback) {
            if (name !== "platform") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as never);
    if (!schema || !callback) throw new Error("platform tool was not registered");
    return { schema, callback };
}

describe("admin platform backup CLI", () => {
    test("requires an explicit full physical backup type", async () => {
        const { schema, callback } = platformTool({});

        expect(parseToolArguments(schema, {
            action: "create_backup",
            ref: "fa_staging",
            backup_type: "full",
        }).backup_type).toBe("full");
        expect(() => parseToolArguments(schema, {
            action: "create_backup",
            ref: "fa_staging",
            backup_type: "incr",
        })).toThrow("Invalid arguments");
        await expect(callback({ action: "create_backup", ref: "fa_staging" }))
            .rejects.toThrow("'backup_type' required for 'create_backup'");
    });

    test("requires the complete verified logical restore identity", async () => {
        const { schema, callback } = platformTool({});
        const backupId = "logical-full_fa_staging_0123456789abcdef0123456789abcdef";
        const sha256 = "a".repeat(64);
        const confirmation = `RESTORE_PROJECT:fa_staging:${backupId}:${sha256}`;

        expect(parseToolArguments(schema, {
            action: "restore_logical_backup",
            ref: "fa_staging",
            backup_id: backupId,
            expected_sha256: sha256,
            confirmation,
        })).toMatchObject({ backup_id: backupId, expected_sha256: sha256, confirmation });
        await expect(callback({ action: "create_logical_backup" }))
            .rejects.toThrow("'ref' required for 'create_logical_backup'");
        await expect(callback({ action: "restore_logical_backup", ref: "fa_staging" }))
            .rejects.toThrow("'backup_id' required for 'restore_logical_backup'");
        await expect(callback({
            action: "restore_logical_backup", ref: "fa_staging", backup_id: backupId,
        })).rejects.toThrow("'expected_sha256' required for 'restore_logical_backup'");
        await expect(callback({
            action: "restore_logical_backup", ref: "fa_staging", backup_id: backupId,
            expected_sha256: sha256,
        })).rejects.toThrow("'confirmation' required for 'restore_logical_backup'");
    });

    test("dispatches verified logical list, create, and restore through bounded contracts", async () => {
        const backupId = "logical-full_fa_staging_0123456789abcdef0123456789abcdef";
        const sha256 = "a".repeat(64);
        const confirmation = `RESTORE_PROJECT:fa_staging:${backupId}:${sha256}`;
        const backup = {
            backup_id: backupId,
            project_ref: "fa_staging",
            database: "supa_fa_staging",
            kind: "logical-full",
            created_at: "2026-08-12T00:00:00.000Z",
            completed_at: "2026-08-12T00:00:01.000Z",
            bytes: 8192,
            sha256,
        };
        const calls: Array<{ method: string; path: string; body?: unknown }> = [];
        let inventoryRead = 0;
        const { callback } = platformTool({
            get: async (path: string) => {
                calls.push({ method: "GET", path });
                inventoryRead += 1;
                return {
                    ok: true,
                    status: 200,
                    data: { backups: inventoryRead === 2 ? [] : [backup] },
                };
            },
            post: async (path: string, body: unknown) => {
                calls.push({ method: "POST", path, body });
                return path.endsWith("/restore")
                    ? { ok: true, status: 200, data: { restored_backup: backup } }
                    : { ok: true, status: 200, data: { backup } };
            },
        });

        const listed = await callback({ action: "list_logical_backups", ref: "fa_staging" });
        const created = await callback({ action: "create_logical_backup", ref: "fa_staging" });
        const restored = await callback({
            action: "restore_logical_backup",
            ref: "fa_staging",
            backup_id: backupId,
            expected_sha256: sha256,
            confirmation,
        });

        expect(listed.isError).not.toBe(true);
        expect(created.isError).not.toBe(true);
        expect(restored.isError).not.toBe(true);
        expect(calls).toEqual([
            { method: "GET", path: "/v1/projects/fa_staging/database/backups/logical" },
            { method: "GET", path: "/v1/projects/fa_staging/database/backups/logical" },
            { method: "POST", path: "/v1/projects/fa_staging/database/backups/logical", body: {} },
            { method: "GET", path: "/v1/projects/fa_staging/database/backups/logical" },
            { method: "GET", path: "/v1/projects/fa_staging/database/backups/logical" },
            {
                method: "POST",
                path: "/v1/projects/fa_staging/database/backups/logical/restore",
                body: { backup_id: backupId, expected_sha256: sha256, confirmation },
            },
        ]);
    });
});
