import { expect, test } from "bun:test";
import {
  applicationRuntimePlan, ApplicationSystemdRuntime, type ApplicationSystemdOperations,
} from "../../src/services/application-runtime";
import { assertManagedSystemdUnitContent } from "../../src/services/systemd-unit-broker";
import { runtimeInput } from "../helpers/application-runtime";
import {
  applicationResourceUsage, buildApplicationCapacityReport,
  type ApplicationRuntimeAllocation,
} from "../../src/services/application-runtime-allocation";
import { ApplicationReadiness } from "../../src/services/application-readiness";

const running = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nInvocationID=" + "a".repeat(32) + "\nResult=success\n";
const stopped = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nInvocationID=\nResult=success\n";

test("ordinary HTTP and worker compute is bounded, budgeted and requires cgroup evidence", async () => {
  const input = runtimeInput();
  for (const target of input.release.targets) target.compute = { cpuLimit: 0.5, memoryLimitMiB: 256 };
  expect(applicationResourceUsage(input.release)).toEqual({ cpu: 1, memoryMiB: 512, connections: 0, concurrency: 0 });
  const plan = applicationRuntimePlan(input);
  for (const target of plan.targets) {
    expect(target.unitContent).toContain("CPUQuota=50%");
    expect(target.unitContent).toContain("MemoryMax=268435456");
    expect(target.unitContent).not.toContain("RuntimeMaxSec");
    expect(() => assertManagedSystemdUnitContent(target.unit, target.unitContent)).not.toThrow();
  }
  const runtime = new ApplicationSystemdRuntime({
    install: async () => {},
    command: async args => ({ exitCode: 0, stdout: `${running}CPUQuotaPerSecUSec=500ms\nMemoryMax=268435456\nMemorySwapMax=0\nCPUAccounting=yes\nMemoryAccounting=yes\nKillMode=control-group\nControlGroup=/system.slice/${args[1]}\n` }),
    resources: async () => false,
  });
  expect((await runtime.inspect(input)).every(state => state.resourcesVerified === false)).toBe(true);
  let probes = 0;
  const readiness = new ApplicationReadiness({
    observe: value => runtime.inspect(value),
    http: async () => { probes++; return null; },
    journal: async () => { probes++; return ""; },
  });
  expect((await readiness.inspect(input)).ready).toBe(false);
  expect(probes).toBe(0);
});

test("capacity report exposes host pressure and project noisy-neighbor usage", () => {
  const input = runtimeInput();
  for (const target of input.release.targets) target.compute = { cpuLimit: 0.5, memoryLimitMiB: 256 };
  const allocation = {
    schema: "supacloud.application-runtime-allocation.v1" as const,
    runtime: input,
    configurationId: "91234567-89ab-4def-8123-456789abcdef",
    createdAt: "2026-10-08T00:00:00.000Z",
  } satisfies ApplicationRuntimeAllocation;
  const report = buildApplicationCapacityReport({
    projectRef: input.release.project_ref,
    allocations: [allocation],
    activePorts: 1,
    budget: { cpu: 2, memoryMiB: 1024, connections: 10, concurrency: 10, ports: 4 },
    generatedAt: "2026-10-08T00:00:00.000Z",
    queueOwners: [{
      queue: "scw_reviews_v1",
      projectRef: input.release.project_ref,
      applicationId: input.release.application_id,
      environmentId: input.environmentId,
      activationId: input.activationId,
    }],
  });
  expect(report.pressure).toBe("normal");
  expect(report.projectAllocations).toBe(1);
  expect(report.projectUsage.cpu).toBeGreaterThan(0);
  expect(report.remaining?.ports).toBe(3);
  expect(report.queueOwners).toHaveLength(1);
});

test("HTTP and worker plans share immutable release identity and pass the managed broker", () => {
  const input = runtimeInput();
  const plan = applicationRuntimePlan(input);
  expect(plan.targets).toHaveLength(2);
  for (const target of plan.targets) {
    expect(target.directory).toContain(`${input.activationId}/objects/${target.objectId}`);
    expect(target.unitContent).toContain(`SUPACLOUD_RELEASE_ID=${input.release.release_id}`);
    expect(target.unitContent).toContain("SUPACLOUD_ENVIRONMENT_ID=test");
    expect(target.unitContent).toContain("bun --no-env-file ");
    expect(() => assertManagedSystemdUnitContent(target.unit, target.unitContent)).not.toThrow();
  }
  expect(plan.targets[0]!.unitContent).toContain('Environment="PORT=31000"');
  expect(plan.targets[1]!.unitContent).not.toContain('Environment="PORT=');
  expect(plan.targets[0]!.unitContent).toContain("TimeoutStopSec=15");
});

test("plans reject absent or extraneous ports and invalid activation identity", () => {
  const input = runtimeInput();
  const invalidPorts: Array<Record<string, number>> = [{}, { api: 0 }, { api: 3000, jobs: 3001 }, { api: 65536 }];
  for (const ports of invalidPorts) {
    expect(() => applicationRuntimePlan({ ...input, ports })).toThrow("ports");
  }
  expect(() => applicationRuntimePlan({ ...input, activationId: "../current" })).toThrow("identity");
});

test("application broker binds environment file and tenant identity to the exact target", () => {
  const [target] = applicationRuntimePlan(runtimeInput()).targets;
  expect(() => assertManagedSystemdUnitContent(target!.unit,
    target!.unitContent.replace("/api.env", "/jobs.env"))).toThrow("EnvironmentFile");
  expect(() => assertManagedSystemdUnitContent(target!.unit,
    target!.unitContent.replaceAll("supacloud-demo", "supacloud-other"))).toThrow("tenant");
  expect(() => assertManagedSystemdUnitContent(target!.unit,
    target!.unitContent.replace("EnvironmentFile=", "EnvironmentFile=-"))).toThrow("EnvironmentFile");
});

test("runtime installs and starts every target and distinguishes process liveness from health", async () => {
  const calls: string[][] = [];
  const installed: string[] = [];
  const runtime = new ApplicationSystemdRuntime({
    install: async unit => { installed.push(unit); },
    command: async args => { calls.push(args); return { exitCode: 0, stdout: running }; },
  });
  const plan = await runtime.install(runtimeInput());
  expect(installed).toEqual(plan.targets.map(target => target.unit));
  const states = await runtime.start(runtimeInput());
  expect(calls[0]).toEqual(["start", ...installed]);
  expect(states.map(state => state.processRunning)).toEqual([true, true]);
  expect(states.every(state => !("healthy" in state))).toBe(true);
});

test("stop acts on all targets and requires observed process termination", async () => {
  const calls: string[][] = [];
  const ops: ApplicationSystemdOperations = {
    install: async () => {},
    command: async args => { calls.push(args); return { exitCode: 0, stdout: stopped }; },
  };
  const states = await new ApplicationSystemdRuntime(ops).stop(runtimeInput());
  expect(calls[0]![0]).toBe("stop");
  expect(calls[0]).toHaveLength(3);
  expect(states.every(state => !state.processRunning && state.mainPid === 0)).toBe(true);
  ops.command = async () => ({ exitCode: 0, stdout: running });
  await expect(new ApplicationSystemdRuntime(ops).stop(runtimeInput())).rejects.toThrow("STOP_UNCONFIRMED");
});

test("runtime never infers success from failed commands or incomplete observations", async () => {
  const ops: ApplicationSystemdOperations = {
    install: async () => { throw new Error("install failed"); },
    command: async () => ({ exitCode: 1, stdout: running }),
  };
  const runtime = new ApplicationSystemdRuntime(ops);
  await expect(runtime.install(runtimeInput())).rejects.toThrow("install failed");
  await expect(runtime.start(runtimeInput())).rejects.toThrow("START_FAILED");
  await expect(runtime.stop(runtimeInput())).rejects.toThrow("STOP_FAILED");
  await expect(runtime.inspect(runtimeInput())).rejects.toThrow("OBSERVATION_FAILED");
  ops.command = async () => ({ exitCode: 0, stdout: "ActiveState=active" });
  await expect(runtime.inspect(runtimeInput())).rejects.toThrow("Incomplete");
});

test("stopped observation never sends stop or start commands", async () => {
  const calls: string[][] = [];
  const ops: ApplicationSystemdOperations = {
    install: async () => { throw new Error("unexpected install"); },
    command: async args => { calls.push(args); return { exitCode: 0, stdout: stopped }; },
  };
  await new ApplicationSystemdRuntime(ops).requireStopped(runtimeInput());
  expect(calls).toHaveLength(2);
  expect(calls.every(args => args[0] === "show")).toBe(true);
  ops.command = async () => ({ exitCode: 0, stdout: running });
  await expect(new ApplicationSystemdRuntime(ops).requireStopped(runtimeInput())).rejects.toThrow("STOP_UNCONFIRMED");
});
