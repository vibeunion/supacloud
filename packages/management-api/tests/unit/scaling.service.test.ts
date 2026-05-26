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

import * as db from "../../src/db";

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
        const dbSpy = spyOn(db, "resolveDbName").mockResolvedValue("supa_test-proj");
        const updateSpy = spyOn(projectRepository, "updateConfig").mockImplementation(async (_ref, config) => ({
            ...mockProject,
            config,
        } as Project));

        const result = await ScalingService.checkAndScale("test-proj");

        expect(result.action).toBe("vertical_scale");
        expect(result.reason).toContain("CPU");
        expect(shellSpy).toHaveBeenCalledWith("ha_manager.sh", ["vertical_scale", "supa_test-proj", "cpu=4,mem=8g"]);
        expect(updateSpy).toHaveBeenCalledWith("test-proj", expect.objectContaining({
            compute: expect.objectContaining({ tier: "pro", status: "active" }),
        }));

        updateSpy.mockRestore();
        dbSpy.mockRestore();
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
        const dbSpy = spyOn(db, "resolveDbName").mockResolvedValue("supa_test-proj");
        const updateSpy = spyOn(projectRepository, "updateConfig").mockImplementation(async (_ref, config) => ({
            ...mockProject,
            config,
        } as Project));

        const result = await ScalingService.checkAndScale("test-proj");

        expect(result.action).toBe("horizontal_scale");
        expect(shellSpy).toHaveBeenCalledWith("gateway_manager.sh", expect.arrayContaining(["add-upstream-target"]));
        expect(updateSpy).toHaveBeenCalledWith("test-proj", expect.objectContaining({
            read_replicas: expect.arrayContaining([
                expect.objectContaining({ status: "active" }),
            ]),
        }));

        updateSpy.mockRestore();
        dbSpy.mockRestore();
        shellSpy.mockRestore();
        monitorSpy.mockRestore();
        projectSpy.mockRestore();
    });

    test("getScalingState normalizes compute and read replica config", async () => {
        const projectSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
            ...mockProject,
            config: {
                compute: { tier: "team", status: "active", cpu: 8, memory: "16g", updated_at: "2026-01-01T00:00:00.000Z" },
                read_replicas: [
                    { id: "rr_1", ip: "10.0.0.2", region: "local", status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
                    { id: "rr_2", ip: "10.0.0.3", status: "deleted" },
                ],
            },
        } as Project);

        const state = await ScalingService.getScalingState("test-proj");

        expect(state?.compute).toEqual(expect.objectContaining({ tier: "team", cpu: 8, memory: "16g" }));
        expect(state?.read_replicas).toEqual([
            expect.objectContaining({ id: "rr_1", ip: "10.0.0.2", status: "active" }),
        ]);

        projectSpy.mockRestore();
    });

    test("removeReadReplica deregisters target and tombstones metadata", async () => {
        const projectSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
            ...mockProject,
            config: {
                read_replicas: [
                    { id: "rr_1", ip: "10.0.0.2", region: "local", status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
                ],
            },
        } as Project);
        const shellSpy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
        const updateSpy = spyOn(projectRepository, "updateConfig").mockImplementation(async (_ref, config) => ({
            ...mockProject,
            config,
        } as Project));

        const removed = await ScalingService.removeReadReplica("test-proj", "rr_1");

        expect(removed).toEqual(expect.objectContaining({ id: "rr_1", status: "deleted" }));
        expect(shellSpy).toHaveBeenCalledWith("gateway_manager.sh", ["remove-upstream-target", "test-proj", "10.0.0.2"]);
        expect(updateSpy).toHaveBeenCalledWith("test-proj", expect.objectContaining({
            read_replicas: [expect.objectContaining({ id: "rr_1", status: "deleted" })],
        }));

        updateSpy.mockRestore();
        shellSpy.mockRestore();
        projectSpy.mockRestore();
    });
});
