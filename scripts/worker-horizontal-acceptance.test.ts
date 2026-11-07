import { describe, expect, test } from "bun:test";
import { parseJsonCommand, parseSystemdProperties, verifyCgroupReadback } from "./worker-horizontal-acceptance";

describe("worker horizontal acceptance helpers", () => {
  test("requires an explicit argv array for crash/restart commands", () => {
    expect(() => parseJsonCommand(undefined)).toThrow("WORKER_ACCEPTANCE_RESTART_COMMAND_REQUIRED");
    expect(() => parseJsonCommand("systemctl restart worker.service")).toThrow("WORKER_ACCEPTANCE_RESTART_COMMAND_INVALID");
    expect(() => parseJsonCommand(undefined, "CRASH")).toThrow("WORKER_ACCEPTANCE_CRASH_COMMAND_REQUIRED");
    expect(parseJsonCommand('["systemctl","restart","worker.service"]')).toEqual(["systemctl", "restart", "worker.service"]);
  });

  test("verifies systemd properties and cgroup v2 files together", () => {
    const properties = parseSystemdProperties([
      "CPUQuotaPerSecUSec=500ms", "MemoryMax=268435456", "MemorySwapMax=0",
      "CPUAccounting=yes", "MemoryAccounting=yes", "KillMode=control-group",
      "ControlGroup=/system.slice/worker-r1-s00.service",
    ].join("\n"));
    expect(verifyCgroupReadback(
      "worker-r1-s00.service", properties,
      { cpuMax: "50000 100000\n", memoryMax: "268435456\n", memorySwapMax: "0\n" },
      { cpuLimit: 0.5, memoryLimitMiB: 256 },
    )).toMatchObject({ passed: true, failures: [] });
    expect(verifyCgroupReadback(
      "worker-r1-s00.service", properties,
      { cpuMax: "100000 100000\n", memoryMax: "268435456\n", memorySwapMax: "0\n" },
      { cpuLimit: 0.5, memoryLimitMiB: 256 },
    ).failures).toContain("CPU_MAX");
  });
});
