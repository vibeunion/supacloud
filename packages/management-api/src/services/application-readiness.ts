import {
  APPLICATION_RUNTIME_PROBE_PATH, parseApplicationRuntimeIdentity, type ApplicationRuntimeIdentity,
  type ApplicationReadinessReport,
} from "@supacloud/delivery";
import { stableStringify } from "../utils/stable-json";
import {
  applicationRuntimePlan, ApplicationSystemdRuntime,
  type ApplicationRuntimeInput, type ApplicationRuntimePlan, type ApplicationRuntimeTarget,
  type ApplicationProcessObservation,
} from "./application-runtime";

export type { ApplicationReadinessReport, ApplicationReadinessTarget } from "@supacloud/delivery";

export interface ApplicationReadinessOperations {
  observe(input: ApplicationRuntimeInput, signal: AbortSignal): Promise<ApplicationProcessObservation[]>;
  http(port: number, signal: AbortSignal): Promise<unknown>;
  journal(unit: string, invocationId: string, signal: AbortSignal): Promise<string>;
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("Readiness output exceeded limit");
      }
      chunks.push(result.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

const runtime = new ApplicationSystemdRuntime();
const operations: ApplicationReadinessOperations = {
  observe: (input, signal) => runtime.inspect(input, signal),
  async http(port, signal) {
    const response = await fetch(`http://127.0.0.1:${port}${APPLICATION_RUNTIME_PROBE_PATH}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: "error",
    });
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    return JSON.parse(await boundedText(response.body, 8192));
  },
  async journal(unit, invocationId, signal) {
    signal.throwIfAborted();
    const child = Bun.spawn({
      cmd: ["journalctl", "--no-pager", "--output=json",
        "--output-fields=MESSAGE,_PID,_SYSTEMD_INVOCATION_ID", "--lines=16",
        "--grep=delivery-worker-started", `_SYSTEMD_UNIT=${unit}`, `_SYSTEMD_INVOCATION_ID=${invocationId}`],
      stdout: "pipe", stderr: "ignore",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    try {
      const output = await boundedText(child.stdout, 65_536);
      if (await child.exited !== 0) throw new Error("Worker readiness journal unavailable");
      signal.throwIfAborted();
      return output;
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  },
};

function expectedIdentity(
  plan: ApplicationRuntimePlan, target: ApplicationRuntimeTarget, pid: number,
): ApplicationRuntimeIdentity {
  return {
    schema: "supacloud.application-runtime.v1", project_ref: plan.projectRef,
    application_id: plan.applicationId, environment_id: plan.environmentId,
    release_id: plan.releaseId, activation_id: plan.activationId,
    object_id: target.objectId, target: target.name, kind: target.kind, pid,
  };
}

function matches(value: unknown, expected: ApplicationRuntimeIdentity): boolean {
  try { return stableStringify(parseApplicationRuntimeIdentity(value)) === stableStringify(expected); }
  catch { return false; }
}

function workerReady(output: string, state: ApplicationProcessObservation, expected: ApplicationRuntimeIdentity): boolean {
  for (const line of output.split("\n")) {
    if (!line) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || !("_PID" in entry) || entry._PID !== String(state.mainPid)
        || !("_SYSTEMD_INVOCATION_ID" in entry) || entry._SYSTEMD_INVOCATION_ID !== state.invocationId
        || !("MESSAGE" in entry) || typeof entry.MESSAGE !== "string") continue;
      const message: unknown = JSON.parse(entry.MESSAGE);
      if (message && typeof message === "object" && "event" in message
        && message.event === "delivery-worker-started" && "identity" in message
        && matches(message.identity, expected)) return true;
    } catch { /* Unrelated or malformed application log lines are not readiness. */ }
  }
  return false;
}

function inventory(plan: ApplicationRuntimePlan, states: ApplicationProcessObservation[]) {
  const map = new Map(states.map(state => [state.target, state]));
  if (map.size !== states.length || map.size !== plan.targets.length
    || plan.targets.some(target => map.get(target.name)?.unit !== target.unit)) {
    throw new Error("Invalid supervisor inventory");
  }
  return map;
}

export class ApplicationReadinessError extends Error {
  readonly code = "APPLICATION_NOT_READY";
  constructor(readonly report: ApplicationReadinessReport) {
    super("Application readiness could not be confirmed");
  }
}

export class ApplicationReadiness {
  private readonly probes: ApplicationReadinessOperations;
  constructor(probes: Partial<ApplicationReadinessOperations> = {}) {
    this.probes = { ...operations, ...probes };
  }

  async inspect(input: ApplicationRuntimeInput, signal = AbortSignal.timeout(5000)): Promise<ApplicationReadinessReport> {
    const plan = applicationRuntimePlan(input);
    const report: ApplicationReadinessReport = {
      project_ref: plan.projectRef, application_id: plan.applicationId, environment_id: plan.environmentId,
      release_id: plan.releaseId, activation_id: plan.activationId, ready: false,
      targets: plan.targets.map(target => ({
        target: target.name, kind: target.kind, unit: target.unit, pid: 0, invocation_id: null,
        ready: false, code: "SUPERVISOR_UNAVAILABLE",
      })),
    };
    let before: Map<string, ApplicationProcessObservation>;
    try { before = inventory(plan, await this.probes.observe(input, signal)); }
    catch { return report; }
    await Promise.all(plan.targets.map(async (target, index) => {
      const state = before.get(target.name)!;
      const result = report.targets[index]!;
      result.pid = state.mainPid;
      result.invocation_id = state.invocationId;
      if (!state.processRunning || state.mainPid < 1 || !state.invocationId) {
        result.code = "PROCESS_NOT_RUNNING";
        return;
      }
      const expected = expectedIdentity(plan, target, state.mainPid);
      try {
        if (target.kind === "http") {
          const value = await this.probes.http(target.port!, signal);
          if (!value || typeof value !== "object" || !("ready" in value) || value.ready !== true) {
            result.code = "HTTP_NOT_READY";
            return;
          }
          if (!("identity" in value) || !matches(value.identity, expected)) {
            result.code = "IDENTITY_MISMATCH";
            return;
          }
        } else if (!workerReady(await this.probes.journal(target.unit, state.invocationId, signal), state, expected)) {
          result.code = "WORKER_NOT_READY";
          return;
        }
        result.ready = true;
        result.code = "READY";
      } catch { result.code = "PROBE_UNAVAILABLE"; }
    }));
    try {
      signal.throwIfAborted();
      const after = inventory(plan, await this.probes.observe(input, signal));
      signal.throwIfAborted();
      for (const result of report.targets) {
        const previous = before.get(result.target)!;
        const current = after.get(result.target)!;
        if (!current.processRunning || current.mainPid !== previous.mainPid
          || current.invocationId !== previous.invocationId) {
          result.ready = false;
          result.code = "PROCESS_CHANGED";
        }
      }
    } catch {
      for (const result of report.targets) { result.ready = false; result.code = "SUPERVISOR_UNAVAILABLE"; }
    }
    report.ready = report.targets.every(target => target.ready);
    return report;
  }

  async requireReady(input: ApplicationRuntimeInput, waitMs = 30_000): Promise<ApplicationReadinessReport> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error("Invalid readiness wait budget");
    const deadline = Date.now() + waitMs;
    for (;;) {
      const probeBudget = waitMs === 0 ? 5000 : Math.min(5000, Math.max(1, deadline - Date.now()));
      const report = await this.inspect(input, AbortSignal.timeout(probeBudget));
      if (report.ready) return report;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ApplicationReadinessError(report);
      await Bun.sleep(Math.min(250, remaining));
    }
  }
}
