import { expect, test } from "bun:test";
import { decodeCommandStatus, type CommandWorkflowStatus } from "./command_status";
import type { CommandJson, DurableCommandReceipt } from "./receipts";

const workflow = { runId: "operation", status: "completed" } satisfies CommandWorkflowStatus;
test("accepted submissions never become confirmed business effects through workflow completion", () => {
  expect(decodeCommandStatus({ kind: "submission", commandId: "operation", execution: null, workflow }))
    .toEqual({ kind: "submission", commandId: "operation", execution: null, workflow });
});
test("execution and workflow states are independent and share one global identity", () => {
  const execution = { tenantId: "tenant", actorId: "actor", command: "remote", operationId: "local-key",
    dispatchKey: "operation", status: "unknown", audit: "pending" } satisfies DurableCommandReceipt<CommandJson>;
  expect(decodeCommandStatus({ kind: "execution", commandId: "operation", execution, workflow }).execution)
    .toEqual(execution);
  for (const value of [null, {}, { kind: "submission", commandId: "operation", execution: null, workflow: null },
    { kind: "execution", commandId: "other", execution, workflow: null },
    { kind: "execution", commandId: "operation", execution, workflow: { ...workflow, runId: "other" } },
    { kind: "execution", commandId: "operation", execution, workflow: { ...workflow, status: "unknown" } }]) {
    expect(() => decodeCommandStatus(value)).toThrow();
  }
});
