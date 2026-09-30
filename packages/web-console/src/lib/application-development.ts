import { requestValidatedJson } from "./validated-json";
import { validApplicationScope, type ApplicationScope } from "./application-dashboard";

/**
 * Read-only view of the `supacloud.application-development.v1` contract served
 * from one immutable release target. The console and the Developer MCP read the
 * same bytes, so this parser only checks the declared shape.
 */
export const developmentLimits = {
  modules: 64, providers: 128, routes: 256, commands: 128, jobs: 128,
  resources: 64, resourceUses: 128, plans: 128, diagnostics: 64,
} as const;
export const developmentCorrelation = "verified-build-snapshot";

export interface DevelopmentResourceUse { resource: string; operations: string[] }
export interface DevelopmentModule {
  name: string; className: string; providers: string[]; controllers: string[];
  commands: string[]; jobs: string[]; queries: string[]; resources: string[];
}
export interface DevelopmentRoute {
  module: string; method: string; path: string; controller: string; handler: string; aspects: string[];
}
export interface DevelopmentCommand {
  module: string; name: string; transaction: "required" | "none"; idempotency: "required" | "none";
  resources: DevelopmentResourceUse[];
}
export interface DevelopmentJob { module: string; name: string; resources: DevelopmentResourceUse[] }
export interface DevelopmentResource { name: string; kind: "database" | "bucket" | "queue" | "config" | "secret" }
export interface DevelopmentResourceUseEntry {
  module: string; owner: string; ownerKind: "command" | "job"; resource: string; operations: string[];
}
export interface DevelopmentDiagnostic { code: string; severity: "error" | "warn"; file?: string; line?: number }
export interface DevelopmentContext {
  schema: "supacloud.application-development.v1";
  source: "current-graph";
  deploymentVerified: false;
  modules: DevelopmentModule[];
  routes: DevelopmentRoute[];
  commands: DevelopmentCommand[];
  jobs: DevelopmentJob[];
  resources: DevelopmentResource[];
  resourceUses: DevelopmentResourceUseEntry[];
  diagnostics: DevelopmentDiagnostic[];
  omitted: Record<string, number>;
  limits: Record<string, number>;
}
export interface ApplicationDevelopmentResponse {
  project_ref: string; application_id: string; release_id: string;
  target: string; object_id: string;
  correlation: typeof developmentCorrelation;
  context: DevelopmentContext;
}

const id = /^[A-Za-z0-9_-]{1,64}$/;
const hash = /^[a-f0-9]{64}$/;
const targetPattern = /^[a-z][a-z0-9-]{0,62}$/;
const operations = ["read", "write", "publish", "consume"] as const;
const resourceKinds = ["database", "bucket", "queue", "config", "secret"] as const;
function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid application development response");
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(text);
}
function bounded(value: unknown, limit: number): value is unknown[] {
  return Array.isArray(value) && value.length <= limit;
}
function resourceUses(value: unknown): value is DevelopmentResourceUse[] {
  return Array.isArray(value) && value.length <= 128 && value.every(entry => {
    const row = record(entry);
    return text(row.resource) && Array.isArray(row.operations)
      && row.operations.every(operation => operations.includes(operation as typeof operations[number]));
  });
}
function counts(value: unknown): value is Record<string, number> {
  const row = record(value);
  return Object.values(row).every(count => Number.isSafeInteger(count) && (count as number) >= 0);
}

export function parseApplicationDevelopment(
  value: unknown, scope: ApplicationScope, releaseId: string, target: string,
): ApplicationDevelopmentResponse {
  const row = record(value);
  requireValue(validApplicationScope(scope)
    && targetPattern.test(target) && hash.test(releaseId)
    && row.project_ref === scope.ref && row.application_id === scope.application
    && row.release_id === releaseId && row.target === target
    && typeof row.object_id === "string" && hash.test(row.object_id)
    && row.correlation === developmentCorrelation);
  const context = record(row.context);
  requireValue(context.schema === "supacloud.application-development.v1"
    && context.source === "current-graph" && context.deploymentVerified === false
    && bounded(context.modules, developmentLimits.modules)
    && bounded(context.routes, developmentLimits.routes)
    && bounded(context.commands, developmentLimits.commands)
    && bounded(context.jobs, developmentLimits.jobs)
    && bounded(context.resources, developmentLimits.resources)
    && bounded(context.resourceUses, developmentLimits.resourceUses)
    && bounded(context.executionPlans, developmentLimits.plans)
    && bounded(context.diagnostics, developmentLimits.diagnostics)
    && counts(context.omitted) && counts(context.limits));
  for (const entry of context.modules as unknown[]) {
    const module = record(entry);
    requireValue(text(module.name) && text(module.className)
      && texts(module.providers) && texts(module.controllers) && texts(module.commands)
      && texts(module.jobs) && texts(module.queries) && texts(module.resources));
  }
  for (const entry of context.routes as unknown[]) {
    const route = record(entry);
    requireValue(text(route.module) && text(route.method) && text(route.path)
      && text(route.controller) && text(route.handler) && texts(route.aspects));
  }
  for (const entry of context.commands as unknown[]) {
    const command = record(entry);
    requireValue(text(command.module) && text(command.name)
      && (command.transaction === "required" || command.transaction === "none")
      && (command.idempotency === "required" || command.idempotency === "none")
      && resourceUses(command.resources));
  }
  for (const entry of context.jobs as unknown[]) {
    const job = record(entry);
    requireValue(text(job.module) && text(job.name) && resourceUses(job.resources));
  }
  for (const entry of context.resources as unknown[]) {
    const resource = record(entry);
    requireValue(text(resource.name) && resourceKinds.includes(resource.kind as typeof resourceKinds[number]));
  }
  for (const entry of context.resourceUses as unknown[]) {
    const use = record(entry);
    requireValue(text(use.module) && text(use.owner)
      && (use.ownerKind === "command" || use.ownerKind === "job")
      && text(use.resource) && Array.isArray(use.operations)
      && use.operations.every(operation => operations.includes(operation as typeof operations[number])));
  }
  for (const entry of context.diagnostics as unknown[]) {
    const diagnostic = record(entry);
    requireValue(text(diagnostic.code)
      && (diagnostic.severity === "error" || diagnostic.severity === "warn")
      && (diagnostic.file === undefined || text(diagnostic.file))
      && (diagnostic.line === undefined || Number.isSafeInteger(diagnostic.line)));
  }
  return row as unknown as ApplicationDevelopmentResponse;
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
export function loadApplicationDevelopment(
  scope: ApplicationScope, releaseId: string, target: string, request: Request, signal: AbortSignal,
) {
  requireValue(validApplicationScope(scope) && hash.test(releaseId) && targetPattern.test(target));
  const url = `/v1/projects/${encodeURIComponent(scope.ref)}/applications/${encodeURIComponent(scope.application)}`
    + `/releases/${encodeURIComponent(releaseId)}/development?target=${encodeURIComponent(target)}`;
  return requestValidatedJson(url, request,
    value => parseApplicationDevelopment(value, scope, releaseId, target),
    { signal, cache: "no-store" }, { maxBytes: 512 * 1024 });
}