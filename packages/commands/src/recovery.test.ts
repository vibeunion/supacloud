import { expect, test } from "bun:test";
import { CommandError, type CommandAuthorization, type DurableCommandReceipt } from "@supacloud/contracts";
import { createCommandRecoveryHandler, type CommandWorkflowPort, type RecoverableCommand } from "./recovery";

const reference = { tenantId: "tenant", actorId: "actor", command: "remote", operationId: "operation" };
const claim = {
  status: "claimed", workflowName: "supacloud.command.reconcile", workflowVersion: "1",
  stepKey: "reconcile", runId: "command-id", input: { ...reference, commandId: "command-id" },
  stepId: "step", messageId: "9223372036854775807", attempt: 1, workerId: "worker",
};
const receipt: DurableCommandReceipt<unknown> = {
  ...reference, dispatchKey: "command-id", status: "confirmed", audit: "complete", result: true,
};
function fixture(recover: RecoverableCommand["recover"] = async () => receipt) {
  const actions: { name: string; request: unknown }[] = [];
  const workflows: CommandWorkflowPort = {
    complete: async (request) => { actions.push({ name: "complete", request }); },
    retry: async (request) => { actions.push({ name: "retry", request }); },
    fail: async (request) => { actions.push({ name: "fail", request }); },
  };
  const options = { workflows, tenantId: "tenant", principal: { subject: "worker" },
    commands: { remote: { recover } }, authorize: (): CommandAuthorization => "allow", retryDelaySeconds: 30 };
  return { actions, options, handler: createCommandRecoveryHandler(options) };
}
test("one delivered step recovers and acknowledges using the full Workflow attempt", async () => {
  const f = fixture();
  expect(await f.handler.run(claim)).toBe("completed");
  expect(f.actions).toEqual([{ name: "complete", request: {
    stepId: "step", messageId: claim.messageId, attempt: 1, workerId: "worker",
    stepOutput: { commandId: "command-id", status: "confirmed", audit: "complete" },
    runOutput: { commandId: "command-id", status: "confirmed", audit: "complete" },
  } }]);
});
test("unknown and audit-pending states request Workflow retry, never success", async () => {
  for (const raw of [null, { ...receipt, audit: "pending" as const },
    { ...reference, dispatchKey: "command-id", status: "unknown" as const, audit: "pending" as const }]) {
    const f = fixture(async () => raw);
    expect(await f.handler.run(claim)).toBe("retry");
    expect(f.actions[0]).toMatchObject({ name: "retry", request: { delaySeconds: 30, errorMessage: "COMMAND_RECOVERY_REQUIRED" } });
  }
});
test("transient failures are sanitized, invalid receipts and expired input fail the workflow", async () => {
  const transient = fixture(async () => { throw new Error("secret"); });
  expect(await transient.handler.run(claim)).toBe("retry");
  expect(JSON.stringify(transient.actions)).not.toContain("secret");
  for (const recover of [
    async () => ({ ...receipt, dispatchKey: "other" }),
    async () => ({ ...receipt, tenantId: "other" }),
    async () => { throw new CommandError("COMMAND_INPUT_EXPIRED"); },
  ]) {
    const f = fixture(recover);
    expect(await f.handler.run(claim)).toBe("failed");
    expect(f.actions[0]?.name).toBe("fail");
  }
});
test("malformed, foreign and unregistered deliveries never invoke recovery or acknowledgement", async () => {
  let recoveries = 0;
  const f = fixture(async () => { recoveries++; return receipt; });
  for (const value of [null, {}, { ...claim, attempt: 0 }, { ...claim, messageId: 10 },
    { ...claim, workflowName: "other" }, { ...claim, runId: "other" }, { ...claim, workerId: "other" },
    { ...claim, input: { ...claim.input, tenantId: "other" } },
    { ...claim, input: { ...claim.input, command: "unknown" } }]) {
    await expect(f.handler.run(value)).rejects.toThrow();
  }
  expect(recoveries).toBe(0); expect(f.actions).toEqual([]);
});
test("authorization failure does not consume or acknowledge a step", async () => {
  for (const authorize of [(): CommandAuthorization => "deny", (): CommandAuthorization => { throw new Error("offline"); }]) {
    const f = fixture();
    await expect(createCommandRecoveryHandler({ ...f.options, authorize }).run(claim)).rejects.toThrow();
    expect(f.actions).toEqual([]);
  }
});
test("lost acknowledgement propagates and redelivery only calls recovery", async () => {
  let recoveries = 0, acknowledgements = 0;
  const f = fixture(async () => { recoveries++; return receipt; });
  f.options.workflows.complete = async () => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error("lost commit");
  };
  await expect(f.handler.run(claim)).rejects.toThrow("lost commit");
  expect(await f.handler.run({ ...claim, attempt: 2 })).toBe("completed");
  expect(recoveries).toBe(2); expect(f.actions).toEqual([]);
});
test("registration snapshots ownership and rejects invalid retry policy", async () => {
  const f = fixture();
  f.options.tenantId = "other"; f.options.principal.subject = "other";
  f.options.commands.remote = { recover: async () => null };
  expect(await f.handler.run(claim)).toBe("completed");
  for (const retryDelaySeconds of [-1, 86401, NaN, 0.5]) {
    expect(() => createCommandRecoveryHandler({ ...f.options, retryDelaySeconds })).toThrow();
  }
});
