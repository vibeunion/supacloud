import { describe, test, expect, spyOn, mock } from "bun:test";
import { BackupService } from "../../src/services/backup.service";
import { $ } from "bun";

describe("BackupService", () => {

    test("createBackup should return success message immediately", async () => {
        const result = await BackupService.createBackup("db-main", "full");
        expect(result.message).toContain("started");
    });

    test("restore should return success message", async () => {
        const result = await BackupService.restore({ target: "2024-01-01 12:00:00" });
        expect(result.message).toContain("started");
    });
});
