import {
  APPLICATION_DEVELOPMENT_LIMITS as DEVELOPMENT_LIMITS,
  DevelopmentContractError,
  parseDevelopmentContext,
} from "@supacloud/delivery/development";
import type { ApplicationGraph } from "./types";
import { createExecutionPlans, type ExecutionPlan } from "./inspect";
import { createDiagnosticRepairPlan } from "./repair-plan";
import { executionSourceFile } from "./execution-snapshot";
import { joinRoutePaths } from "./util";

/**
 * A stable, read-only projection of the current application graph for developer
 * tooling. Never exports expressions, diagnostic messages, repair replacement
 * values, credentials or business payloads. Readers share the delivery contract.
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
} = DEVELOPMENT_LIMITS;

/** Shared formatted UTF-8 byte budget for archive writers and readers (including the final newline). */
export const APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES = 524_288;
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

/** Keep the compiler API and error identity stable while sharing the wire parser. */
export function parseApplicationDevelopmentContext(input: unknown): ApplicationDevelopmentContext {
  try {
    return parseDevelopmentContext(input);
  } catch (error) {
    throw new ApplicationDevelopmentError(error instanceof DevelopmentContractError
      ? error.code : "APPLICATION_DEVELOPMENT_INVALID");
  }
}

const schemaKinds = (route: ApplicationGraph["modules"][number]["controllers"][number]["routes"][number]): Record<string, DevelopmentSchemaKind> | undefined => {
  if (!route.schemaKinds) return undefined;
  const entries = Object.entries(route.schemaKinds)
    .filter(([key]) => ["body", "params", "query", "headers", "cookie", "response"].includes(key))
    .filter((entry): entry is [string, DevelopmentSchemaKind] => entry[1] === "opaque" || entry[1] === "declared");
  return entries.length > 0 ? Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right, "en"))) : undefined;
};

function bound<T>(values: readonly T[], limit: number): { items: T[]; omitted: number } {
  return { items: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

/** Deterministic projection of the current graph into the versioned contract. */
export interface ApplicationDevelopmentOptions {
  /** Interactive output defaults to 64 KiB; delivery archives allow 512 KiB. Neither mode is unbounded. */
  byteBudget?: "interactive" | "archive";
}

export function createApplicationDevelopmentContext(
  graph: ApplicationGraph, options: ApplicationDevelopmentOptions = {},
): ApplicationDevelopmentContext {
  const modules = [...graph.modules].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const resources = [...(graph.resources ?? [])].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const names = (values: readonly string[]) => [...values].sort((left, right) => left.localeCompare(right, "en"));
  const operationOrder = ["read", "write", "publish", "consume"];
  const resourceUses = (graph.resourceUses ?? []).map(use => ({ ...use,
    operations: [...use.operations].sort((left, right) => operationOrder.indexOf(left) - operationOrder.indexOf(right)),
  })).sort((left, right) =>
    left.module.localeCompare(right.module, "en")
    || Number(left.command === undefined) - Number(right.command === undefined)
    || (left.command ?? left.job ?? "").localeCompare(right.command ?? right.job ?? "", "en")
    || left.resource.localeCompare(right.resource, "en")
    || JSON.stringify(left.operations).localeCompare(JSON.stringify(right.operations), "en"));

  let omittedProviders = 0;
  let remainingProviders = APPLICATION_DEVELOPMENT_LIMITS.providers;
  const developmentModules: ApplicationDevelopmentModule[] = [];
  const routes: ApplicationDevelopmentRoute[] = [];
  const commands: ApplicationDevelopmentCommand[] = [];
  const jobs: ApplicationDevelopmentJob[] = [];

  for (const [moduleIndex, module] of modules.entries()) {
    const providers = bound(names(module.providers.map((provider) => provider.token)),
      moduleIndex < APPLICATION_DEVELOPMENT_LIMITS.modules ? remainingProviders : 0);
    remainingProviders -= providers.items.length;
    omittedProviders += providers.omitted;
    developmentModules.push({
      name: module.name,
      className: module.className,
      ...(executionSourceFile(module.file) ? { file: executionSourceFile(module.file) } : {}),
      ...(module.tags && module.tags.length > 0 ? { tags: names(module.tags) } : {}),
      providers: providers.items,
      controllers: names(module.controllers.map((controller) => controller.className)),
      commands: names(module.commands.map((command) => command.name)),
      jobs: names((module.jobs ?? []).map((job) => job.name)),
      queries: names(module.queries.map((query) => query.name)),
      resources: names(module.resources ?? []),
    });

    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const candidates = module.commands.filter(command => command.className === route.command || command.name === route.command);
        const command = candidates.length === 1 ? candidates[0]?.name : undefined;
        routes.push({
          module: module.name,
          method: route.method,
          path: joinRoutePaths(controller.path, route.path),
          controller: controller.className,
          handler: route.handler,
          ...(command === undefined ? {} : { command }),
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
    || left.path.localeCompare(right.path, "en")
    || left.controller.localeCompare(right.controller, "en")
    || left.handler.localeCompare(right.handler, "en"));
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
      ...(Number.isSafeInteger(diagnostic.line) && diagnostic.line! > 0 ? { line: diagnostic.line } : {}),
      ...(repair ? { repair: { type: repair.type, readiness: repair.readiness } } : {}),
    });
  }

  diagnostics.sort((left, right) =>
    Number(right.severity === "error") - Number(left.severity === "error")
    || (left.file ?? "").localeCompare(right.file ?? "", "en")
    || (left.line ?? 0) - (right.line ?? 0)
    || left.code.localeCompare(right.code, "en")
    || JSON.stringify(left.repair ?? {}).localeCompare(JSON.stringify(right.repair ?? {}), "en"));

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
  const budget = options.byteBudget === "archive" ? APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES : APPLICATION_DEVELOPMENT_LIMITS.outputBytes;
  if (Buffer.byteLength(JSON.stringify(context, null, 2), "utf8") + 1 > budget) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE");
  }
  return context;
}

/** Compact human-readable rendering, used by the `dev-context` CLI command. */
export function formatApplicationDevelopmentContext(context: ApplicationDevelopmentContext): string {
  const lines: string[] = [
    `APPLICATION ${context.schema}`,
    `  source: ${context.source}; deploymentVerified: ${context.deploymentVerified}`,
    `  omitted: ${Object.entries(context.omitted).filter(([, count]) => count > 0).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,
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
