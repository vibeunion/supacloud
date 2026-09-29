import type { DeliveryObject } from "./delivery-build-schema";
import { readDeliverySelection, readVerifiedDeliveryFiles } from "./delivery-artifact";
import { executionContextFromSnapshot, EXECUTION_CONTEXT_LIMITS, ExecutionContextError, type ExecutionContextPack } from "./execution-context";
import { parseExecutionSnapshot } from "./execution-snapshot";
import {
  APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES,
  parseApplicationDevelopmentContext,
  type ApplicationDevelopmentContext,
} from "./application-development";

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

export interface DeliveredApplicationDevelopmentContext {
  correlation: "verified-build-snapshot";
  delivery: { target: string; objectId: string; artifactVerified: true };
  context: ApplicationDevelopmentContext;
}

/**
 * Read the application development contract from an immutable delivered object.
 * Local artifact integrity only: this does not attest deployment, runtime state
 * or account identity. It never falls back to the current source checkout.
 */
export async function readApplicationDevelopmentContext(
  manifestPath: string, target: string,
): Promise<DeliveredApplicationDevelopmentContext> {
  const invalid = () => new DeliveryContextError("DELIVERY_CONTEXT_INVALID");
  let object: DeliveryObject;
  let context: ApplicationDevelopmentContext;
  try {
    const { root, object: found, planned } = await readDeliverySelection(manifestPath, target);
    if (!found) throw new DeliveryContextError("DELIVERY_CONTEXT_IDENTITY_MISMATCH");
    object = found;
    if (!planned) throw invalid();
    const path = "bundle/application-development.json";
    const metadata = object.files.find(file => file.path === path);
    if (!metadata || metadata.bytes > APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES) throw new Error("Invalid development context.");
    const content = (await readVerifiedDeliveryFiles(root, object, planned, new Set([path]))).get(path);
    if (!content || content.length > APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES) throw new Error("Invalid development context.");
    context = parseApplicationDevelopmentContext(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
    // Projection caps allow omissions, but never an entry belonging to another target.
    const modules = new Set(planned.modules.map(module => module.name));
    if (context.modules.some(module => !modules.has(module.name))
      || [...context.commands, ...context.resourceUses, ...context.executionPlans].some(item => !modules.has(item.module))
      || context.routes.some(route => !planned.routes.some(owned => owned.module === route.module
        && owned.method === route.method && owned.path === route.path
        && owned.controller === route.controller && owned.handler === route.handler))
      || context.jobs.some(job => !planned.jobs.some(owned => owned.module === job.module && owned.name === job.name))
      || context.resourceUses.some(use => use.ownerKind === "job"
        && !planned.jobs.some(job => job.module === use.module && job.name === use.owner))
      || context.executionPlans.some(plan => plan.kind === "job"
        ? !planned.jobs.some(job => job.module === plan.module && job.name === plan.name)
        : plan.kind === "route" && !planned.routes.some(route => route.module === plan.module
          && `${route.method} ${route.path}` === plan.name))) {
      throw new Error("Development context target mismatch.");
    }
  } catch (error) {
    if (error instanceof DeliveryContextError) throw error;
    throw new DeliveryContextError("DELIVERY_CONTEXT_INTEGRITY_FAILED");
  }
  return { correlation: "verified-build-snapshot", delivery: { target, objectId: object.objectId, artifactVerified: true }, context };
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
