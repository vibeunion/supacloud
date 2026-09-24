import { CommandError, commandIdentifier, decodeCommandJson, decodeDurableCommandReceipt, type CommandAuthorization, type DurableCommandReceipt } from "@supacloud/contracts";
import { checkAuthorization, type RecoveryPrincipal } from "./context";
import type { OperationReference } from "./store";
import { emitCommandObservation, type CommandObserver } from "./observation";

export interface CommandRecoveryEvent {
  command: string;
  commandId: string;
  stepId: string;
  attempt: number;
  stage: "recover" | "complete" | "retry" | "fail";
  phase: "started" | "succeeded" | "failed";
  /** Fixed reason codes, never raw lookup or transport errors. */
  reason?: "COMMAND_INPUT_EXPIRED" | "COMMAND_RECEIPT_INVALID"
    | "COMMAND_RECOVERY_FAILED" | "COMMAND_RECOVERY_REQUIRED";
}

export interface RecoverableCommand {
  recover(principal: RecoveryPrincipal, reference: OperationReference): Promise<DurableCommandReceipt<unknown> | null>;
}
export interface CommandWorkflowAttempt {
  stepId: string;
  messageId: string;
  attempt: number;
  workerId: string;
}
/** Structurally implemented by supacloud.workflows. Delivery remains host-owned. */
export interface CommandWorkflowPort {
  complete(request: CommandWorkflowAttempt & { stepOutput: Record<string, unknown>; runOutput: Record<string, unknown> }): Promise<unknown>;
  retry(request: CommandWorkflowAttempt & { errorMessage: string; delaySeconds: number }): Promise<unknown>;
  fail(request: CommandWorkflowAttempt & { errorMessage: string }): Promise<unknown>;
}

function decodeClaim(value: unknown) {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== "claimed"
    || !("workflowName" in value)
    || !("workflowVersion" in value) || value.workflowVersion !== "1"
    || !("stepKey" in value) || value.stepKey !== "reconcile"
    || !("runId" in value) || !("input" in value) || !("stepId" in value)
    || !("messageId" in value) || !("attempt" in value) || !("workerId" in value)
    || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || typeof value.messageId !== "string" || !/^[1-9][0-9]*$/.test(value.messageId)) {
    throw new TypeError("Invalid command recovery claim");
  }
  const input = value.input;
  if (!input || typeof input !== "object" || !("tenantId" in input) || !("actorId" in input)
    || !("command" in input) || !("operationId" in input) || !("commandId" in input)) {
    throw new TypeError("Invalid command recovery reference");
  }
  const commandId = commandIdentifier(input.commandId);
  if (value.runId !== commandId) throw new TypeError("Mismatched command workflow");
  const reference: OperationReference = {
    tenantId: commandIdentifier(input.tenantId), actorId: commandIdentifier(input.actorId),
    command: commandIdentifier(input.command), operationId: commandIdentifier(input.operationId),
  };
  if (value.workflowName !== "supacloud.command.reconcile" && value.workflowName !== `command.${reference.command}`) {
    throw new TypeError("Invalid recovery workflow");
  }
  const attempt: CommandWorkflowAttempt = {
    stepId: commandIdentifier(value.stepId), messageId: value.messageId, attempt: value.attempt,
    workerId: commandIdentifier(value.workerId),
  };
  return { commandId, reference, attempt };
}

/** Handles one already-claimed recovery step. No polling, leases or business sends. */
export function createCommandRecoveryHandler(options: {
  workflows: CommandWorkflowPort;
  principal: RecoveryPrincipal;
  tenantId: string;
  commands: Readonly<Record<string, RecoverableCommand>>;
  authorize(): CommandAuthorization | Promise<CommandAuthorization>;
  retryDelaySeconds: number;
  observer?: CommandObserver<CommandRecoveryEvent>;
}) {
  const tenantId = commandIdentifier(options.tenantId);
  const principal = { subject: commandIdentifier(options.principal.subject) };
  const commands = { ...options.commands }, workflows = options.workflows, authorize = options.authorize;
  const observer = options.observer;
  const delaySeconds = options.retryDelaySeconds;
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86400) throw new TypeError("Invalid recovery delay");
  return {
    async run(value: unknown): Promise<"completed" | "retry" | "failed"> {
      const { commandId, reference, attempt } = decodeClaim(value);
      if (reference.tenantId !== tenantId || attempt.workerId !== principal.subject
        || !Object.hasOwn(commands, reference.command)) throw new CommandError("COMMAND_REJECTED");
      await checkAuthorization(authorize);
      const command = commands[reference.command];
      if (!command) throw new CommandError("COMMAND_REJECTED");
      const observe = async <Result>(
        stage: CommandRecoveryEvent["stage"],
        run: () => Promise<Result>,
        reason?: CommandRecoveryEvent["reason"],
      ): Promise<Result> => {
        const emit = (phase: CommandRecoveryEvent["phase"]) => emitCommandObservation(observer, {
          command: reference.command, commandId, stepId: attempt.stepId, attempt: attempt.attempt,
          stage, phase, ...(reason === undefined ? {} : { reason }),
        });
        emit("started");
        try {
          const result = await run();
          emit("succeeded");
          return result;
        } catch (error) {
          emit("failed");
          throw error;
        }
      };
      let receipt: DurableCommandReceipt<unknown> | null;
      try {
        receipt = await observe("recover", async () => {
          const raw = await command.recover({ ...principal }, { ...reference });
          const decoded = raw === null ? null : decodeDurableCommandReceipt(raw, decodeCommandJson);
          if (decoded !== null) {
            if (decoded.dispatchKey !== commandId) throw new CommandError("COMMAND_RECEIPT_INVALID");
            for (const key of ["tenantId", "actorId", "command", "operationId"] as const) {
              if (decoded[key] !== reference[key]) throw new CommandError("COMMAND_RECEIPT_INVALID");
            }
          }
          return decoded;
        });
      } catch (error) {
        if (error instanceof CommandError && (error.code === "COMMAND_INPUT_EXPIRED" || error.code === "COMMAND_RECEIPT_INVALID")) {
          const reason = error.code;
          await observe("fail", () => workflows.fail({ ...attempt, errorMessage: reason }), reason);
          return "failed";
        }
        await observe("retry", () => workflows.retry({
          ...attempt, errorMessage: "COMMAND_RECOVERY_FAILED", delaySeconds,
        }), "COMMAND_RECOVERY_FAILED");
        return "retry";
      }
      // Acknowledgement failures propagate. Redelivery only repeats safe recovery.
      if (receipt?.status === "confirmed" && receipt.audit === "complete") {
        const output = { commandId, status: "confirmed", audit: "complete" };
        await observe("complete", () => workflows.complete({ ...attempt, stepOutput: output, runOutput: output }));
        return "completed";
      }
      await observe("retry", () => workflows.retry({
        ...attempt, errorMessage: "COMMAND_RECOVERY_REQUIRED", delaySeconds,
      }), "COMMAND_RECOVERY_REQUIRED");
      return "retry";
    },
  };
}
