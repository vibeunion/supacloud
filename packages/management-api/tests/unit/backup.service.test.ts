import { describe, test, expect, mock, spyOn } from "bun:test";
import { BackupService } from "../../src/services/backup.service";
import { shellService } from "../../src/services/shell.service";

describe("BackupService", () => {
    test("listBackups should parse pgBackRest JSON output", async () => {
        const mockOutput = JSON.stringify([{
            name: "db-main",
            backup: [
                {
                    label: "20240101-120000F",
                    type: "full",
                    timestamp: { start: 1704110400, stop: 1704114000 },
                    info: { size: { backup: 1024 * 1024 } }
                }
            ]
        }]);

        const spy = spyOn(shellService, "execute").mockResolvedValue({
            success: true,
            output: mockOutput
        });

        const backups = await BackupService.listBackups("db-main");

        expect(backups).toHaveLength(1);
        expect(backups[0].id).toBe("20240101-120000F");
        expect(backups[0].size).toBe(1024 * 1024);
        expect(spy).toHaveBeenCalledWith("backup_manager.sh", ["list", "db-main"]);

        spy.mockRestore();
    });

    test("createBackup should return success message immediately", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await BackupService.createBackup("db-main", "full");
        expect(result.message).toContain("已启动 full 备份任务");

        // shellService should be called eventually (async)
        // In Bun tests with mock/spy, it's captured
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test("restore should return success message", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await BackupService.restore({ target: "2024-01-01 12:00:00" });
        expect(result.message).toContain("点对点恢复");
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
