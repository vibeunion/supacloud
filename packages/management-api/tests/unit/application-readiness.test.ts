import { expect, test } from "bun:test";
import { ApplicationReadiness, ApplicationReadinessError } from "../../src/services/application-readiness";
import { applicationRuntimePlan, type ApplicationProcessObservation } from "../../src/services/application-runtime";
import { runtimeInput } from "../helpers/application-runtime";

function fixture() {
  const input = runtimeInput();
  const plan = applicationRuntimePlan(input);
  const states: ApplicationProcessObservation[] = plan.targets.map((target, index) => ({
    target: target.name, unit: target.unit, loadState: "loaded", activeState: "active", subState: "running",
    mainPid: 100 + index, invocationId: String(index + 1).repeat(32), result: "success", processRunning: true,
  }));
  const identities = plan.targets.map((target, index) => ({
    schema: "supacloud.application-runtime.v1", project_ref: plan.projectRef,
    application_id: plan.applicationId, environment_id: plan.environmentId,
    release_id: plan.releaseId, activation_id: plan.activationId, target: target.name,
    object_id: target.objectId, kind: target.kind, pid: states[index]!.mainPid,
  }));
  const worker = () => JSON.stringify({
    _PID: String(states[1]!.mainPid), _SYSTEMD_INVOCATION_ID: states[1]!.invocationId,
    MESSAGE: JSON.stringify({ event: "delivery-worker-started", identity: identities[1] }),
  });
  const probes = {
    observe: async () => structuredClone(states),
    http: async () => ({ ready: true, identity: identities[0] }),
    journal: async () => worker(),
  };
  return { input, states, identities, probes, worker };
}

test("readiness binds every target to release, environment and stable process identity", async () => {
  const f = fixture();
  const report = await new ApplicationReadiness(f.probes).requireReady(f.input, 0);
  expect(report.ready).toBe(true);
  expect(report.activation_id).toBe(f.input.activationId);
  expect(report.targets.map(target => target.code)).toEqual(["READY", "READY"]);
});

test("a responding old release and an old worker invocation cannot pass readiness", async () => {
  const f = fixture();
  f.identities[0]!.release_id = "0".repeat(64);
  const old = f.worker();
  f.states[1]!.invocationId = "f".repeat(32);
  f.probes.journal = async () => old;
  const report = await new ApplicationReadiness(f.probes).inspect(f.input);
  expect(report.ready).toBe(false);
  expect(report.targets.map(target => target.code)).toEqual(["IDENTITY_MISMATCH", "WORKER_NOT_READY"]);
});

test("a process restart during probes invalidates even matching readiness receipts", async () => {
  const f = fixture();
  let reads = 0;
  f.probes.observe = async () => {
    if (reads++ > 0) f.states[0]!.invocationId = "f".repeat(32);
    return structuredClone(f.states);
  };
  const report = await new ApplicationReadiness(f.probes).inspect(f.input);
  expect(report.ready).toBe(false);
  expect(report.targets[0]!.code).toBe("PROCESS_CHANGED");
});

test("worker messages from another PID are ignored and inactive processes are not probed", async () => {
  const f = fixture();
  f.identities[1]!.pid = 999;
  const report = await new ApplicationReadiness(f.probes).inspect(f.input);
  expect(report.targets[1]!.code).toBe("WORKER_NOT_READY");
  let journalCalls = 0;
  f.states[1]!.processRunning = false;
  f.probes.journal = async () => { journalCalls++; return f.worker(); };
  expect((await new ApplicationReadiness(f.probes).inspect(f.input)).ready).toBe(false);
  expect(journalCalls).toBe(0);
});

test("probe failures produce bounded metadata reports, not raw logs or exception messages", async () => {
  const f = fixture();
  f.probes.http = async () => { throw new Error("private-provider-error"); };
  f.probes.journal = async () => "private-worker-log";
  try {
    await new ApplicationReadiness(f.probes).requireReady(f.input, 0);
    throw new Error("expected readiness failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationReadinessError);
    expect(JSON.stringify(error)).not.toContain("private-");
    expect((error as ApplicationReadinessError).report.targets.map(target => target.code))
      .toEqual(["PROBE_UNAVAILABLE", "WORKER_NOT_READY"]);
  }
});

test("incomplete supervisor inventory cannot certify a partial application", async () => {
  const f = fixture();
  f.probes.observe = async () => [f.states[0]!];
  const report = await new ApplicationReadiness(f.probes).inspect(f.input);
  expect(report.ready).toBe(false);
  expect(report.targets.every(target => target.code === "SUPERVISOR_UNAVAILABLE")).toBe(true);
});

test("the readiness wait budget cancels an in-flight supervisor observation", async () => {
  const f = fixture();
  let cancelled = false;
  const readiness = new ApplicationReadiness({
    ...f.probes,
    observe: async (_input, signal) => new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => {
        cancelled = true;
        reject(new Error("blocked supervisor"));
      }, { once: true });
    }),
  });
  const started = Date.now();
  await expect(readiness.requireReady(f.input, 20)).rejects.toBeInstanceOf(ApplicationReadinessError);
  expect(cancelled).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
});
