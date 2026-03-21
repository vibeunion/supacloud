import { describe, test, expect, spyOn, mock } from "bun:test";
import { ScalingService } from "../../src/services/scaling.service";
import * as MonitorService from "../../src/services/monitor.service";
import { shellService } from "../../src/services/shell.service";
import { projectRepository } from "../../src/repositories/project.repository";
import type { Project } from "../../src/db";

const mockProject: Partial<Project> = {
    ref: "test-proj",
    status: "active",
    config: {}
};

describe("ScalingService", () => {
    test("checkAndScale should trigger vertical scale on high CPU", async () => {
        const projectSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(
            mockProject as Project
        );

        const monitorSpy = spyOn(MonitorService, "getMetrics").mockResolvedValue({
            qps: 10,
            active_connections: 5,
            slow_queries: 0,
            cpu_usage: 95,
            mem_usage: 40
        });

        const shellSpy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await ScalingService.checkAndScale("test-proj");

        expect(result.action).toBe("vertical_scale");
        expect(result.reason).toContain("CPU");
        expect(shellSpy).toHaveBeenCalledWith("ha_manager.sh", ["vertical_scale", "supa_test-proj", "cpu=4,mem=8g"]);

        shellSpy.mockRestore();
        monitorSpy.mockRestore();
        projectSpy.mockRestore();
    });

    test("checkAndScale should trigger horizontal scale on high QPS", async () => {
        const projectSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(
            mockProject as Project
        );

        const monitorSpy = spyOn(MonitorService, "getMetrics").mockResolvedValue({
            qps: 1200,
            active_connections: 5,
            slow_queries: 0,
            cpu_usage: 10,
            mem_usage: 10
        });

        const shellSpy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await ScalingService.checkAndScale("test-proj");

        expect(result.action).toBe("horizontal_scale");
        expect(shellSpy).toHaveBeenCalledWith("gateway_manager.sh", expect.arrayContaining(["add-upstream-target"]));

        shellSpy.mockRestore();
        monitorSpy.mockRestore();
        projectSpy.mockRestore();
    });
});
