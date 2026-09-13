import { commandIdentifier, decodeCommandJson, decodeDurableCommandReceipt, type CommandJson, type DurableCommandReceipt } from "./receipts.js";
import type { OperationReference } from "./command_store.js";

export type CommandLookup = { commandId: string } | OperationReference;
export interface CommandWorkflowStatus {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
}
export type CommandStatus =
  | { kind: "submission"; commandId: string; execution: null; workflow: CommandWorkflowStatus }
  | { kind: "execution"; commandId: string; execution: DurableCommandReceipt<CommandJson>; workflow: CommandWorkflowStatus | null };

export function decodeCommandStatus(value: unknown): CommandStatus {
  if (!value || typeof value !== "object" || !("kind" in value) || !("commandId" in value)
    || !("execution" in value) || !("workflow" in value)) throw new TypeError("Invalid command status");
  const commandId = commandIdentifier(value.commandId);
  let workflow: CommandWorkflowStatus | null = null;
  if (value.workflow !== null) {
    const raw = value.workflow;
    if (!raw || typeof raw !== "object" || !("runId" in raw) || !("status" in raw)
      || raw.runId !== commandId) throw new TypeError("Invalid command workflow");
    const status = raw.status;
    if (status !== "queued" && status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new TypeError("Invalid command workflow status");
    }
    workflow = { runId: commandId, status };
  }
  if (value.kind === "submission" && value.execution === null && workflow !== null) {
    return { kind: "submission", commandId, execution: null, workflow };
  }
  if (value.kind === "execution") {
    const execution = decodeDurableCommandReceipt(value.execution, decodeCommandJson);
    if (execution.dispatchKey !== commandId) throw new TypeError("Mismatched command identity");
    return { kind: "execution", commandId, execution, workflow };
  }
  throw new TypeError("Invalid command status kind");
}
