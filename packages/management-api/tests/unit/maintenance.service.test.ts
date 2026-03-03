import { describe, test, expect, spyOn } from "bun:test";
import { MaintenanceService } from "../../src/services/maintenance.service";
import { shellService } from "../../src/services/shell.service";

describe("MaintenanceService", () => {
    test("switchover should call ha_manager.sh with correct args", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "OK" });

        const result = await MaintenanceService.switchover("db-cluster", "node-2");
        expect(result.message).toContain("successfully");
        expect(spy).toHaveBeenCalledWith("ha_manager.sh", ["switchover", "db-cluster", "node-2"]);

        spy.mockRestore();
    });

    test("reloadConfig should call ha_manager.sh reload", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "OK" });

        const result = await MaintenanceService.reloadConfig("192.168.1.10");
        expect(result.message).toContain("sent");
        expect(spy).toHaveBeenCalledWith("ha_manager.sh", ["reload", "192.168.1.10"]);

        spy.mockRestore();
    });

    test("addReplica should trigger async expansion", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "OK" });

        const result = await MaintenanceService.addReplica("192.168.1.11");
        expect(result.message).toContain("started");
        expect(spy).toHaveBeenCalled();

        spy.mockRestore();
    });
});
