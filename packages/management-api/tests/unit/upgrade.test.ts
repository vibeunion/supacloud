import { describe, expect, test } from "bun:test";
import {
  buildEdgeRuntimeCapacityDropIn,
  resolveEdgeRuntimeCapacityConfig,
} from "../../src/upgrade";

describe("upgrade edge-runtime capacity defaults", () => {
  test("sizes systemd limits to sixty percent of a two-core node", () => {
    const config = resolveEdgeRuntimeCapacityConfig({
      env: {},
      cpuCount: 2,
      totalMemoryMb: 2048,
    });

    expect(config.workerPoolSize).toBe(20);
    expect(config.backgroundWorkerPoolSize).toBe(20);
    expect(config.cpuQuotaPercent).toBe(120);
    expect(config.memoryMaxMb).toBe(1228);
    expect(config.memoryHighMb).toBe(982);
    expect(config.tasksMax).toBe(256);
  });

  test("honors explicit upgrade environment overrides", () => {
    const config = resolveEdgeRuntimeCapacityConfig({
      env: {
        SUPACLOUD_EDGE_WORKER_POOL_SIZE: "8",
        SUPACLOUD_EDGE_BACKGROUND_WORKER_POOL_SIZE: "16",
        SUPACLOUD_EDGE_CPU_QUOTA_PERCENT: "75",
        SUPACLOUD_EDGE_MEMORY_MAX_MB: "512",
        SUPACLOUD_EDGE_MEMORY_HIGH_MB: "400",
        SUPACLOUD_EDGE_TASKS_MAX: "128",
      },
      cpuCount: 2,
      totalMemoryMb: 2048,
    });

    expect(config).toEqual({
      workerPoolSize: 8,
      backgroundWorkerPoolSize: 16,
      cpuQuotaPercent: 75,
      memoryMaxMb: 512,
      memoryHighMb: 400,
      tasksMax: 128,
    });
  });

  test("writes a late systemd drop-in that overrides stale low limits", () => {
    const dropIn = buildEdgeRuntimeCapacityDropIn({
      workerPoolSize: 20,
      backgroundWorkerPoolSize: 20,
      cpuQuotaPercent: 120,
      memoryHighMb: 982,
      memoryMaxMb: 1228,
      tasksMax: 256,
    });

    expect(dropIn).toContain("Environment=WORKER_POOL_SIZE=20");
    expect(dropIn).toContain("Environment=BACKGROUND_WORKER_POOL_SIZE=20");
    expect(dropIn).toContain("CPUQuota=120%");
    expect(dropIn).toContain("MemoryHigh=982M");
    expect(dropIn).toContain("MemoryMax=1228M");
    expect(dropIn).toContain("TasksMax=256");
  });
});
