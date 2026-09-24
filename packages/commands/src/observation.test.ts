import { expect, test } from "bun:test";
import { CommandError, type DurableCommandReceipt } from "@supacloud/contracts";
import {
  createCommandRecoveryHandler, createExecutionPolicy,
  type CommandRecoveryEvent, type ExecutionPolicyEvent,
} from "./index";

test("policy observes classified read retries without leaking values or raw errors", async () => {
  const events: Readonly<ExecutionPolicyEvent>[] = [];
  let attempts = 0;
  const policy = createExecutionPolicy({
    kind: "read", retry: { maxAttempts: 2, delayMs: 1, classify: () => "retry" },
    observer: (event) => { expect(Object.isFrozen(event)).toBe(true); events.push(event); },
  });
  expect(await policy.execute(async () => {
    if (++attempts === 1) throw new Error("private connection details");
    return "private result";
  })).toBe("private result");
  expect(events).toEqual([
    { kind: "read", attempt: 1, phase: "started" },
    { kind: "read", attempt: 1, phase: "failed" },
    { kind: "read", attempt: 1, phase: "retry", reason: "retry" },
    { kind: "read", attempt: 2, phase: "started" },
    { kind: "read", attempt: 2, phase: "succeeded" },
  ]);
  expect(JSON.stringify(events)).not.toContain("private");
});

test("command observation does not turn unknown outcomes into retries", async () => {
  const events: ExecutionPolicyEvent[] = [];
  let calls = 0;
  const failure = new CommandError("COMMAND_OUTCOME_UNKNOWN");
  const policy = createExecutionPolicy({
    kind: "command", retry: { maxAttempts: 3, delayMs: 1, classify: () => "rolled-back" },
    observer: (event) => { events.push(event); },
  });
  await expect(policy.execute(async () => { calls++; throw failure; })).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(events).toEqual([
    { kind: "command", attempt: 1, phase: "started" },
    { kind: "command", attempt: 1, phase: "failed", reason: "COMMAND_OUTCOME_UNKNOWN" },
  ]);
});

test("confirmed rollback can retry; telemetry is best effort for both sync and async failures", async () => {
  for (const observer of [
    () => { throw new Error("telemetry unavailable"); },
    async () => { throw new Error("telemetry unavailable"); },
  ]) {
    let writes = 0;
    const policy = createExecutionPolicy({
      kind: "command", retry: { maxAttempts: 2, delayMs: 1, classify: () => "rolled-back" }, observer,
    });
    expect(await policy.execute(async () => {
      if (++writes === 1) throw new Error("driver-confirmed rollback");
      return 42;
    })).toBe(42);
    expect(writes).toBe(2);
  }
});

test("pre-aborted requests and open circuits are observed without starting an attempt", async () => {
  const events: ExecutionPolicyEvent[] = [];
  const policy = createExecutionPolicy({
    kind: "read", observer: (event) => { events.push(event); },
    circuit: { failureThreshold: 1, resetAfterMs: 60_000, isFailure: () => true },
  });
  await expect(policy.execute(async () => 1, AbortSignal.abort())).rejects.toMatchObject({ code: "EXECUTION_ABORTED" });
  await expect(policy.execute(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  await expect(policy.execute(async () => 1)).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  expect(events[0]).toEqual({ kind: "read", attempt: 0, phase: "rejected", reason: "EXECUTION_ABORTED" });
  expect(events.at(-1)).toEqual({ kind: "read", attempt: 0, phase: "rejected", reason: "CIRCUIT_OPEN" });
});

const reference = { tenantId: "tenant", actorId: "actor", command: "charge", operationId: "order-42" };
const claim = {
  status: "claimed", workflowName: "supacloud.command.reconcile", workflowVersion: "1",
  stepKey: "reconcile", runId: "command-42", input: { ...reference, commandId: "command-42" },
  stepId: "step-42", messageId: "7", attempt: 1, workerId: "worker",
};
const receipt: DurableCommandReceipt<unknown> = {
  ...reference, dispatchKey: "command-42", status: "confirmed", audit: "complete", result: { private: true },
};

test("recovery traces settlement failure separately and redelivery never dispatches a command", async () => {
  const events: CommandRecoveryEvent[] = [];
  let recoveries = 0, completions = 0;
  const failure = new Error("private acknowledgement failure");
  const handler = createCommandRecoveryHandler({
    tenantId: "tenant", principal: { subject: "worker" }, authorize: () => "allow",
    commands: { charge: { recover: async () => { recoveries++; return receipt; } } },
    workflows: {
      complete: async () => { if (++completions === 1) throw failure; },
      retry: async () => { throw new Error("unexpected retry"); },
      fail: async () => { throw new Error("unexpected failure"); },
    },
    retryDelaySeconds: 5,
    observer: (event) => { expect(Object.isFrozen(event)).toBe(true); events.push(event); },
  });
  await expect(handler.run(claim)).rejects.toBe(failure);
  expect(await handler.run({ ...claim, attempt: 2 })).toBe("completed");
  expect(recoveries).toBe(2);
  expect(events.map(({ stage, phase, attempt }) => [stage, phase, attempt])).toEqual([
    ["recover", "started", 1], ["recover", "succeeded", 1],
    ["complete", "started", 1], ["complete", "failed", 1],
    ["recover", "started", 2], ["recover", "succeeded", 2],
    ["complete", "started", 2], ["complete", "succeeded", 2],
  ]);
  expect(JSON.stringify(events)).not.toContain("private");
  expect(events.every((event) => !("input" in event) && !("result" in event) && !("actorId" in event))).toBe(true);
});

test("recovery reason codes distinguish pending, transient and terminal results", async () => {
  for (const scenario of [
    { recover: async () => null, stage: "retry", reason: "COMMAND_RECOVERY_REQUIRED" },
    { recover: async () => ({ ...receipt, audit: "pending" as const }), stage: "retry", reason: "COMMAND_RECOVERY_REQUIRED" },
    { recover: async () => { throw new Error("private backend"); }, stage: "retry", reason: "COMMAND_RECOVERY_FAILED" },
    { recover: async () => { throw new CommandError("COMMAND_INPUT_EXPIRED"); }, stage: "fail", reason: "COMMAND_INPUT_EXPIRED" },
    { recover: async () => ({ ...receipt, tenantId: "foreign" }), stage: "fail", reason: "COMMAND_RECEIPT_INVALID" },
  ]) {
    const events: CommandRecoveryEvent[] = [];
    const handler = createCommandRecoveryHandler({
      tenantId: "tenant", principal: { subject: "worker" }, authorize: () => "allow",
      commands: { charge: { recover: scenario.recover } }, retryDelaySeconds: 5,
      workflows: { complete: async () => {}, retry: async () => {}, fail: async () => {} },
      observer: async (event) => { events.push(event); throw new Error("private observer"); },
    });
    expect(await handler.run(claim)).toBe(scenario.stage === "fail" ? "failed" : "retry");
    expect(events.at(-1)).toMatchObject({ stage: scenario.stage, phase: "succeeded", reason: scenario.reason });
    expect(JSON.stringify(events)).not.toContain("private");
  }
});

test("denied or foreign recovery does not reach the observer or receipt handler", async () => {
  let calls = 0;
  const handler = createCommandRecoveryHandler({
    tenantId: "tenant", principal: { subject: "worker" }, authorize: () => "deny",
    commands: { charge: { recover: async () => { calls++; return receipt; } } }, retryDelaySeconds: 5,
    workflows: { complete: async () => { calls++; }, retry: async () => { calls++; }, fail: async () => { calls++; } },
    observer: () => { calls++; },
  });
  await expect(handler.run(claim)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  await expect(handler.run({ ...claim, workerId: "foreign" })).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect(calls).toBe(0);
});

test("failed retry/fail acknowledgements propagate instead of reporting settlement", async () => {
  for (const stage of ["retry", "fail"] as const) {
    const events: CommandRecoveryEvent[] = [];
    const failure = new Error("acknowledgement unavailable");
    const handler = createCommandRecoveryHandler({
      tenantId: "tenant", principal: { subject: "worker" }, authorize: () => "allow",
      commands: { charge: { recover: async () => {
        if (stage === "fail") throw new CommandError("COMMAND_INPUT_EXPIRED");
        return null;
      } } },
      workflows: {
        complete: async () => { throw new Error("unexpected completion"); },
        retry: async () => { throw failure; },
        fail: async () => { throw failure; },
      },
      retryDelaySeconds: 5, observer: (event) => { events.push(event); },
    });
    await expect(handler.run(claim)).rejects.toBe(failure);
    expect(events.at(-1)).toMatchObject({ stage, phase: "failed" });
    expect(events.some((event) => event.stage === stage && event.phase === "succeeded")).toBe(false);
  }
});
