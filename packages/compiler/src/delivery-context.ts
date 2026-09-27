import type { DeliveryObject } from "./delivery-build-schema";
import { readDeliverySelection, readVerifiedDeliveryFiles } from "./delivery-artifact";
import { executionContextFromSnapshot, EXECUTION_CONTEXT_LIMITS, ExecutionContextError, type ExecutionContextPack } from "./execution-context";
import { parseExecutionSnapshot } from "./execution-snapshot";

export class DeliveryContextError extends Error {
  constructor(readonly code: "DELIVERY_CONTEXT_INVALID" | "DELIVERY_CONTEXT_IDENTITY_MISMATCH"
    | "DELIVERY_CONTEXT_INTEGRITY_FAILED") {
    super(code);
    this.name = "DeliveryContextError";
  }
}

export interface DeliveryExecutionContextPack extends Omit<ExecutionContextPack, "correlation"> {
  correlation: "verified-build-snapshot";
  delivery: { target: string; objectId: string; artifactVerified: true };
}

/** Local artifact integrity only. Caller-supplied events do not attest execution or deployment. */
export async function createDeliveryExecutionContextPack(
  manifestPath: string, target: string, subject: string, observations: unknown, requestId: string,
): Promise<DeliveryExecutionContextPack> {
  const invalid = () => new DeliveryContextError("DELIVERY_CONTEXT_INVALID");
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) throw invalid();
  const envelope = observations as Record<string, unknown>;
  if (Object.keys(envelope).some(key => !["version", "events", "delivery"].includes(key))
    || !envelope.delivery || typeof envelope.delivery !== "object" || Array.isArray(envelope.delivery)) throw invalid();
  const identity = envelope.delivery as Record<string, unknown>;
  if (Object.keys(identity).length !== 2 || typeof identity.target !== "string"
    || typeof identity.objectId !== "string" || !/^[a-f0-9]{64}$/.test(identity.objectId)) throw invalid();
  let object: DeliveryObject;
  let snapshot: ReturnType<typeof parseExecutionSnapshot>;
  try {
    const { root, object: found, planned } = await readDeliverySelection(manifestPath, target);
    if (!found || identity.target !== target || identity.objectId !== found.objectId) {
      throw new DeliveryContextError("DELIVERY_CONTEXT_IDENTITY_MISMATCH");
    }
    object = found;
    if (!planned) throw invalid();
    const path = "bundle/execution-context.json";
    const content = (await readVerifiedDeliveryFiles(root, object, planned, new Set([path]))).get(path);
    if (!content || content.length > EXECUTION_CONTEXT_LIMITS.inputBytes) throw new Error("Invalid snapshot.");
    snapshot = parseExecutionSnapshot(JSON.parse(content.toString("utf8")));
  } catch (error) {
    if (error instanceof DeliveryContextError) throw error;
    throw new DeliveryContextError("DELIVERY_CONTEXT_INTEGRITY_FAILED");
  }
  const pack: DeliveryExecutionContextPack = {
    ...executionContextFromSnapshot(snapshot, subject, { version: envelope.version, events: envelope.events }, requestId),
    correlation: "verified-build-snapshot",
    delivery: { target, objectId: object.objectId, artifactVerified: true },
  };
  if (Buffer.byteLength(JSON.stringify(pack, null, 2), "utf8") + 1 > EXECUTION_CONTEXT_LIMITS.outputBytes) {
    throw new ExecutionContextError("EXECUTION_CONTEXT_TOO_LARGE");
  }
  return pack;
}
