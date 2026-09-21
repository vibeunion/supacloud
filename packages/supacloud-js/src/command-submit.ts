import { SupaCloudApiError } from "./api-error.js";
import { captureCommandId, commandActor, commandKey, commandTarget, decodeCommandRead } from "./command-read.js";
import { workflowRequestFields } from "./workflow-attempt.js";
import { workflowJsonEqual, workflowJsonObject } from "./workflow-json.js";
import type { SupaCloudCommandReceipt, SupaCloudCommandSubmitRequest } from "./commands.js";

export class SupaCloudCommandSubmitError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Command submission could not be validated", 0, {
      code: mutationMayHaveApplied ? "COMMAND_SUBMIT_UNCONFIRMED" : "COMMAND_SUBMIT_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudCommandSubmitError";
  }
}

type CapturedCommand = Omit<Required<SupaCloudCommandSubmitRequest>, "actorId"> & { actorId: string | null };
function trim(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  return value.replace(/^ +| +$/g, "");
}

export function captureCommandSubmit(value: unknown): CapturedCommand {
  try {
    const fields = workflowRequestFields(value, [
      "commandId", "commandType", "targetType", "targetId", "actorId", "payload", "maxAttempts",
    ]);
    const commandType = commandKey(trim(fields.commandType));
    // The generated workflow name adds the eight-character "command." prefix.
    if (commandType.length > 112) throw new Error();
    const maxAttempts = fields.maxAttempts === undefined ? 3 : fields.maxAttempts;
    if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts)
      || maxAttempts < 1 || maxAttempts > 100) throw new Error();
    let actorId: string | null = null;
    if (fields.actorId !== undefined) {
      if (typeof fields.actorId !== "string") throw new Error();
      actorId = commandActor(fields.actorId.toLowerCase());
    }
    return {
      commandId: captureCommandId(fields.commandId), commandType,
      targetType: commandKey(trim(fields.targetType)), targetId: commandTarget(trim(fields.targetId)),
      actorId, payload: workflowJsonObject(fields.payload), maxAttempts,
    };
  } catch {
    throw new SupaCloudCommandSubmitError();
  }
}

export function decodeCommandSubmit(value: unknown, request: CapturedCommand): SupaCloudCommandReceipt {
  try {
    const receipt = decodeCommandRead(value, request.commandId, true);
    if (!receipt || receipt.commandType !== request.commandType || receipt.targetType !== request.targetType
      || receipt.targetId !== request.targetId || receipt.actorId !== request.actorId
      || !workflowJsonEqual(receipt.workflow.input.payload, request.payload)) throw new Error();
    if (!receipt.idempotent) {
      const first = receipt.workflow.steps[0];
      if (receipt.workflow.status !== "queued" || receipt.workflow.rowVersion !== "1"
        || receipt.workflow.steps.length !== 1 || !first || first.status !== "queued"
        || first.attempts !== 0 || first.maxAttempts !== request.maxAttempts) throw new Error();
    }
    return receipt;
  } catch {
    throw new SupaCloudCommandSubmitError(true);
  }
}
