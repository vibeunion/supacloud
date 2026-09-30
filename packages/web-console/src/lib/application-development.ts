import {
  APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES,
  APPLICATION_DEVELOPMENT_LIMITS,
  parseDevelopmentContext,
  type DevelopmentContext,
} from "../../../delivery/src/application-development";
import { requestValidatedJson } from "./validated-json";
import { validApplicationScope, type ApplicationScope } from "./application-dashboard";

// The private console is built with the repository's browser-safe delivery contract.
export { type DevelopmentContext };
export const developmentLimits = APPLICATION_DEVELOPMENT_LIMITS;
export const developmentCorrelation = "verified-build-snapshot";
export type DevelopmentModule = DevelopmentContext["modules"][number];
export type DevelopmentRoute = DevelopmentContext["routes"][number];
export type DevelopmentCommand = DevelopmentContext["commands"][number];
export type DevelopmentJob = DevelopmentContext["jobs"][number];
export type DevelopmentResource = DevelopmentContext["resources"][number];
export type DevelopmentResourceUse = DevelopmentCommand["resources"][number];
export type DevelopmentResourceUseEntry = DevelopmentContext["resourceUses"][number];
export type DevelopmentDiagnostic = DevelopmentContext["diagnostics"][number];
export interface ApplicationDevelopmentResponse {
  project_ref: string; application_id: string; release_id: string;
  target: string; object_id: string;
  correlation: typeof developmentCorrelation;
  context: DevelopmentContext;
}

function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid application development response");
}
function hash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function validTarget(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value) && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function validScope(scope: ApplicationScope): boolean {
  return validApplicationScope(scope)
    && [scope.ref, scope.application, scope.environment].every(value => !/[\u0000-\u001f\u007f]/.test(value));
}

export function parseApplicationDevelopment(
  value: unknown, scope: ApplicationScope, releaseId: string, target: string, expectedObjectId?: string,
): ApplicationDevelopmentResponse {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  requireValue(validScope(scope) && validTarget(target) && hash(releaseId)
    && row.project_ref === scope.ref && row.application_id === scope.application
    && row.release_id === releaseId && row.target === target
    && hash(row.object_id) && row.correlation === developmentCorrelation
    && (expectedObjectId === undefined || (hash(expectedObjectId) && row.object_id === expectedObjectId)));
  const context = parseDevelopmentContext(row.context);
  // Return only validated fields and a detached contract, never the raw response.
  return {
    project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
    target, object_id: row.object_id, correlation: developmentCorrelation, context,
  };
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
export function loadApplicationDevelopment(
  scope: ApplicationScope, releaseId: string, target: string, request: Request, signal: AbortSignal,
  expectedObjectId?: string,
) {
  const selected = { ref: scope.ref, application: scope.application, environment: scope.environment };
  requireValue(validScope(selected) && hash(releaseId) && validTarget(target)
    && (expectedObjectId === undefined || hash(expectedObjectId)));
  const url = `/v1/projects/${encodeURIComponent(selected.ref)}/applications/${encodeURIComponent(selected.application)}`
    + `/releases/${encodeURIComponent(releaseId)}/development?target=${encodeURIComponent(target)}`;
  return requestValidatedJson(url, request,
    value => parseApplicationDevelopment(value, selected, releaseId, target, expectedObjectId),
    { signal, cache: "no-store" }, { maxBytes: APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES + 4096 });
}
