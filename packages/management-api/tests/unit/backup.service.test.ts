import { describe, test, expect, spyOn, mock } from "bun:test";
import { createBackup, restore } from "../../src/services/backup.service";
import { $ } from "bun";

describe("BackupService", () => {

    test("createBackup should return success message immediately", async () => {
        const result = await createBackup("db-main", "full");
        expect(result.message).toContain("started");
    });

    test("restore should return success message", async () => {
        const result = await restore({ target: "2024-01-01T12:00:00Z" });
        expect(result.message).toContain("started");
    });
});
