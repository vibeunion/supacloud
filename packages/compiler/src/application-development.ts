import type { Diagnostic } from "./types";
import type { ApplicationGraph } from "./types";
import { createExecutionPlans, type ExecutionPlan } from "./inspect";
import { createDiagnosticRepairPlan } from "./repair-plan";
import { executionSourceFile } from "./execution-snapshot";

/**
 * A stable, read-only projection of the current application graph for developer
 * tooling (Web Console application view and a future Developer MCP). It is a
 * projection of `ApplicationGraph`, never a second source of truth, and it never
 * exports source expressions, diagnostic messages/suggestions, repair replacement
 * values, credentials or business payloads.
 */
export const APPLICATION_DEVELOPMENT_LIMITS: {
  readonly outputBytes: number;
  readonly modules: number;
  readonly providers: number;
  readonly routes: number;
  readonly commands: number;
  readonly jobs: number;
  readonly resources: number;
  readonly resourceUses: number;
  readonly plans: number;
  readonly diagnostics: number;
} = Object.freeze({
  outputBytes: 65_536,
  modules: 64, providers: 128, routes: 256, commands: 128, jobs: 128,
  resources: 64, resourceUses: 128, plans: 128, diagnostics: 64,
});

export const APPLICATION_DEVELOPMENT_SCHEMA = "supacloud.application-development.v1";

export type DevelopmentSchemaKind = "opaque" | "declared";

export interface ApplicationDevelopmentModule {
  name: string;
  className: string;
  file?: string;
  tags?: string[];
  providers: string[];
  controllers: string[];
  commands: string[];
  jobs: string[];
  queries: string[];
  resources: string[];
}

export interface ApplicationDevelopmentRoute {
  module: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  command?: string;
  aspects: string[];
  schemaKinds?: Record<string, DevelopmentSchemaKind>;
}

export interface ApplicationDevelopmentResourceUse {
  resource: string;
  operations: string[];
}

export interface ApplicationDevelopmentCommand {
  module: string;
  name: string;
  permission?: string;
  transaction: "required" | "none";
  idempotency: "required" | "none";
  audit?: string;
  resources: ApplicationDevelopmentResourceUse[];
}

export interface ApplicationDevelopmentJob {
  module: string;
  name: string;
  mode?: string;
  resources: ApplicationDevelopmentResourceUse[];
}

export interface ApplicationDevelopmentResource {
  name: string;
  kind: string;
}

export interface ApplicationDevelopmentResourceUseEntry {
  module: string;
  owner: string;
  ownerKind: "command" | "job";
  resource: string;
  operations: string[];
}

export interface ApplicationDevelopmentDiagnostic {
  code: string;
  severity: "error" | "warn";
  file?: string;
  line?: number;
  repair?: { type: string; readiness: "preview" | "input-required" | "manual" };
}

export interface ApplicationDevelopmentContext {
  schema: typeof APPLICATION_DEVELOPMENT_SCHEMA;
  source: "current-graph";
  deploymentVerified: false;
  modules: ApplicationDevelopmentModule[];
  routes: ApplicationDevelopmentRoute[];
  commands: ApplicationDevelopmentCommand[];
  jobs: ApplicationDevelopmentJob[];
  resources: ApplicationDevelopmentResource[];
  resourceUses: ApplicationDevelopmentResourceUseEntry[];
  executionPlans: ExecutionPlan[];
  diagnostics: ApplicationDevelopmentDiagnostic[];
  omitted: {
    modules: number; providers: number; routes: number; commands: number; jobs: number;
    resources: number; resourceUses: number; plans: number; diagnostics: number;
  };
  limits: typeof APPLICATION_DEVELOPMENT_LIMITS;
}

export class ApplicationDevelopmentError extends Error {
  constructor(readonly code: "APPLICATION_DEVELOPMENT_TOO_LARGE" | "APPLICATION_DEVELOPMENT_INVALID") {
    super(code);
    this.name = "ApplicationDevelopmentError";
  }
}

/**
 * Structural validation for a serialized contract read from an artifact. The
 * producer is hash-verified upstream; this only rejects a document that is not
 * the declared development contract.
 */
export function parseApplicationDevelopmentContext(input: unknown): ApplicationDevelopmentContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
  }
  const row = input as Record<string, unknown>;
  if (row.schema !== APPLICATION_DEVELOPMENT_SCHEMA || row.source !== "current-graph"
    || row.deploymentVerified !== false
    || !Array.isArray(row.modules) || !Array.isArray(row.routes) || !Array.isArray(row.commands)
    || !Array.isArray(row.jobs) || !Array.isArray(row.resources) || !Array.isArray(row.resourceUses)
    || !Array.isArray(row.executionPlans) || !Array.isArray(row.diagnostics)
    || !row.omitted || typeof row.omitted !== "object"
    || !row.limits || typeof row.limits !== "object") {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
  }
  return row as unknown as ApplicationDevelopmentContext;
}

const schemaKinds = (route: ApplicationGraph["modules"][number]["controllers"][number]["routes"][number]): Record<string, DevelopmentSchemaKind> | undefined => {
  if (!route.schemaKinds) return undefined;
  const entries = Object.entries(route.schemaKinds)
    .filter((entry): entry is [string, DevelopmentSchemaKind] => entry[1] === "opaque" || entry[1] === "declared");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

function bound<T>(values: readonly T[], limit: number): { items: T[]; omitted: number } {
  return { items: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

export interface ApplicationDevelopmentOptions {
  /**
   * Enforce the formatted-output byte budget. CLI/console consumers keep the
   * default; immutable build artifacts may disable it because the projection
   * caps already bound the document and a build must not fail on document size.
   */
  enforceByteBudget?: boolean;
}

/**
 * Project the current application graph into the versioned development contract.
 * Ordering is deterministic so two runs over the same source produce the same
 * document.
 */
export function createApplicationDevelopmentContext(
  graph: ApplicationGraph,
  options: ApplicationDevelopmentOptions = {},
): ApplicationDevelopmentContext {
  const modules = [...graph.modules].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const resources = [...(graph.resources ?? [])].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const resourceUses = [...(graph.resourceUses ?? [])];

  let omittedProviders = 0;
  const developmentModules: ApplicationDevelopmentModule[] = [];
  const routes: ApplicationDevelopmentRoute[] = [];
  const commands: ApplicationDevelopmentCommand[] = [];
  const jobs: ApplicationDevelopmentJob[] = [];

  for (const module of modules) {
    const providers = bound(module.providers.map((provider) => provider.token), APPLICATION_DEVELOPMENT_LIMITS.providers);
    omittedProviders += providers.omitted;
    developmentModules.push({
      name: module.name,
      className: module.className,
      ...(executionSourceFile(module.file) ? { file: executionSourceFile(module.file) } : {}),
      ...(module.tags && module.tags.length > 0 ? { tags: [...module.tags] } : {}),
      providers: providers.items,
      controllers: module.controllers.map((controller) => controller.className),
      commands: module.commands.map((command) => command.name),
      jobs: (module.jobs ?? []).map((job) => job.name),
      queries: module.queries.map((query) => query.name),
      resources: [...(module.resources ?? [])],
    });

    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        routes.push({
          module: module.name,
          method: route.method,
          path: route.path,
          controller: controller.className,
          handler: route.handler,
          ...(route.command === undefined ? {} : { command: route.command }),
          aspects: (route.aspects ?? []).map((aspect) => aspect.name),
          ...(schemaKinds(route) ? { schemaKinds: schemaKinds(route) } : {}),
        });
      }
    }

    for (const command of module.commands) {
      const uses = resourceUses.filter((use) => use.module === module.name && use.command === command.name);
      commands.push({
        module: module.name,
        name: command.name,
        ...(command.permission === undefined ? {} : { permission: command.permission }),
        transaction: command.transaction,
        idempotency: command.idempotency,
        ...(command.audit === undefined ? {} : { audit: command.audit }),
        resources: uses.map((use) => ({ resource: use.resource, operations: [...use.operations] })),
      });
    }

    for (const job of module.jobs ?? []) {
      const uses = resourceUses.filter((use) => use.module === module.name && use.job === job.name);
      jobs.push({
        module: module.name,
        name: job.name,
        ...(job.mode === undefined ? {} : { mode: job.mode }),
        resources: uses.map((use) => ({ resource: use.resource, operations: [...use.operations] })),
      });
    }
  }

  routes.sort((left, right) =>
    left.module.localeCompare(right.module, "en")
    || left.method.localeCompare(right.method, "en")
    || left.path.localeCompare(right.path, "en"));
  commands.sort((left, right) =>
    left.module.localeCompare(right.module, "en") || left.name.localeCompare(right.name, "en"));
  jobs.sort((left, right) =>
    left.module.localeCompare(right.module, "en") || left.name.localeCompare(right.name, "en"));

  const plans = [...createExecutionPlans(graph)].sort((left, right) =>
    left.module.localeCompare(right.module, "en")
    || left.kind.localeCompare(right.kind, "en")
    || left.name.localeCompare(right.name, "en"));

  const diagnostics: ApplicationDevelopmentDiagnostic[] = [];
  for (const diagnostic of (graph.diagnostics ?? [])) {
    const repair = createDiagnosticRepairPlan([diagnostic])[0];
    diagnostics.push({
      code: diagnostic.code,
      severity: diagnostic.severity,
      ...(executionSourceFile(diagnostic.file) ? { file: executionSourceFile(diagnostic.file) } : {}),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(repair ? { repair: { type: repair.type, readiness: repair.readiness } } : {}),
    });
  }

  const boundedModules = bound(developmentModules, APPLICATION_DEVELOPMENT_LIMITS.modules);
  const boundedRoutes = bound(routes, APPLICATION_DEVELOPMENT_LIMITS.routes);
  const boundedCommands = bound(commands, APPLICATION_DEVELOPMENT_LIMITS.commands);
  const boundedJobs = bound(jobs, APPLICATION_DEVELOPMENT_LIMITS.jobs);
  const boundedResources = bound(resources, APPLICATION_DEVELOPMENT_LIMITS.resources);
  const boundedUses = bound(resourceUses, APPLICATION_DEVELOPMENT_LIMITS.resourceUses);
  const boundedPlans = bound(plans, APPLICATION_DEVELOPMENT_LIMITS.plans);
  const boundedDiagnostics = bound(diagnostics, APPLICATION_DEVELOPMENT_LIMITS.diagnostics);

  const context: ApplicationDevelopmentContext = {
    schema: APPLICATION_DEVELOPMENT_SCHEMA,
    source: "current-graph",
    deploymentVerified: false,
    modules: boundedModules.items,
    routes: boundedRoutes.items,
    commands: boundedCommands.items,
    jobs: boundedJobs.items,
    resources: boundedResources.items.map((resource) => ({ name: resource.name, kind: resource.kind })),
    resourceUses: boundedUses.items.map((use) => ({
      module: use.module,
      owner: use.command ?? use.job ?? "",
      ownerKind: use.command === undefined ? "job" : "command",
      resource: use.resource,
      operations: [...use.operations],
    })),
    executionPlans: boundedPlans.items,
    diagnostics: boundedDiagnostics.items,
    omitted: {
      modules: boundedModules.omitted,
      providers: omittedProviders,
      routes: boundedRoutes.omitted,
      commands: boundedCommands.omitted,
      jobs: boundedJobs.omitted,
      resources: boundedResources.omitted,
      resourceUses: boundedUses.omitted,
      plans: boundedPlans.omitted,
      diagnostics: boundedDiagnostics.omitted,
    },
    limits: APPLICATION_DEVELOPMENT_LIMITS,
  };
  if (options.enforceByteBudget !== false
    && Buffer.byteLength(JSON.stringify(context, null, 2), "utf8") + 1 > APPLICATION_DEVELOPMENT_LIMITS.outputBytes) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE");
  }
  return context;
}

/** Compact human-readable rendering, used by the `dev-context` CLI command. */
export function formatApplicationDevelopmentContext(context: ApplicationDevelopmentContext): string {
  const lines: string[] = [
    `APPLICATION ${context.schema}`,
    `  modules: ${context.modules.map((module) => module.name).join(", ") || "-"}`,
    `  resources: ${context.resources.map((resource) => `${resource.name}:${resource.kind}`).join(", ") || "-"}`,
    `  routes: ${context.routes.length}`,
    `  commands: ${context.commands.length}`,
    `  jobs: ${context.jobs.length}`,
  ];
  for (const route of context.routes) {
    lines.push(`  ${route.method} ${route.path} -> ${route.controller}.${route.handler} (${route.module})`);
  }
  for (const diagnostic of context.diagnostics) {
    lines.push(`  ${diagnostic.severity} ${diagnostic.code}${diagnostic.file ? ` ${diagnostic.file}` : ""}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}`);
  }
  return lines.join("\n");
}