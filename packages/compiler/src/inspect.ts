import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApplicationGraph, AspectRefNode, Diagnostic, ModuleNode, ProviderNode } from "./types";
import { inspectRouteContracts } from "./route-contracts";

export interface ExecutionPlan {
  module: string;
  kind: "route" | "command" | "job";
  name: string;
  command?: string;
  /** Standard governance contract. Audit success follows the handler; custom executors may short-circuit. */
  stages: string[];
}

export interface ContextPack {
  version: 1;
  subject: string;
  modules: ModuleNode[];
  files: string[];
  externalTokens: string[];
  executionPlans: ExecutionPlan[];
  routeContracts: ReturnType<typeof inspectRouteContracts>;
  diagnostics: Diagnostic[];
  relatedModules: {
    importedBy: string[];
    imports: string[];
  };
}

export interface DoctorResult {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  diagnostics: ApplicationGraph["diagnostics"];
  errors: number;
}

export function formatGraph(graph: ApplicationGraph): string {
  const lines: string[] = [];
  for (const module of graph.modules) {
    lines.push(`MODULE ${module.name}`);
    lines.push(`  file: ${module.file}:${module.line}`);
    lines.push(`  imports: ${module.imports.length > 0 ? module.imports.join(", ") : "-"}`);
    lines.push(`  providers: ${module.providers.length > 0 ? module.providers.map((p) => p.token).join(", ") : "-"}`);
    lines.push(`  controllers: ${module.controllers.length > 0 ? module.controllers.map((c) => c.className).join(", ") : "-"}`);
    lines.push(`  commands: ${module.commands.length > 0 ? module.commands.map((c) => c.name).join(", ") : "-"}`);
  }
  lines.push(`EXTERNAL TOKENS ${graph.externalTokens.length > 0 ? graph.externalTokens.join(", ") : "-"}`);
  return lines.join("\n");
}

export function explainGraph(graph: ApplicationGraph, subject: string): string {
  const module = graph.modules.find((candidate) => candidate.name === subject);
  if (module) return explainModule(graph, module);

  const provider = findProvider(graph, subject);
  if (provider) return explainProvider(graph, provider.module, provider.provider);

  if (graph.externalTokens.includes(subject)) {
    const references = graph.modules.flatMap((candidate) => [
      ...candidate.providers.filter((item) => item.deps.includes(subject)).map((item) => `${candidate.name}.${item.token}`),
      ...candidate.controllers.filter((item) => item.deps.includes(subject)).map((item) => `${candidate.name}.${item.className}`),
    ]);
    return [
      `EXTERNAL TOKEN ${subject}`,
      "  provided by: platform runtime",
      `  references: ${references.length > 0 ? references.join(", ") : "-"}`,
    ].join("\n");
  }

  const known = [...graph.modules.map((item) => item.name), ...graph.externalTokens].sort();
  throw new Error(`No module, provider, or external token named "${subject}". Known names: ${known.join(", ") || "(none)"}`);
}

/**
 * Extracts the smallest graph neighborhood that is useful for an agent
 * editing one feature: the subject module, its imports, and its dependents.
 */
export function createContextPack(graph: ApplicationGraph, subject: string): ContextPack {
  const subjectModule = graph.modules.find((module) => module.name === subject);
  if (!subjectModule) {
    throw new Error(`No module named "${subject}". Context packs require a module name.`);
  }

  const byName = new Map(graph.modules.map((module) => [module.name, module]));
  const selected = new Set<string>([subjectModule.name]);
  // Traverse each direction independently. Switching direction at a shared
  // infrastructure module pulls unrelated sibling features into the pack.
  for (const direction of ["imports", "dependents"] as const) {
    const visited = new Set<string>([subjectModule.name]);
    const queue = [subjectModule.name];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      const module = byName.get(current);
      if (!module) continue;
      const neighbors = direction === "imports" ? module.imports : graph.modules
        .filter((candidate) => candidate.imports.includes(module.name))
        .map((candidate) => candidate.name);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && byName.has(neighbor)) {
          visited.add(neighbor);
          selected.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  const modules = graph.modules.filter((module) => selected.has(module.name));
  const files = [...new Set(modules.flatMap((module) => [
    module.file,
    ...module.providers.map((provider) => provider.file),
    ...module.controllers.map((controller) => controller.file),
    ...allAspects(module).flatMap((aspect) => aspect.file ? [aspect.file] : []),
  ]))].sort();
  const referencedTokens = new Set<string>();
  for (const module of modules) {
    for (const provider of module.providers) {
      for (const token of provider.deps) referencedTokens.add(token);
    }
    for (const controller of module.controllers) {
      for (const token of controller.deps) referencedTokens.add(token);
    }
  }

  return {
    version: 1,
    subject: subjectModule.name,
    modules,
    files,
    externalTokens: graph.externalTokens.filter((token) => referencedTokens.has(token)),
    executionPlans: createExecutionPlans({ ...graph, modules }),
    routeContracts: inspectRouteContracts({ ...graph, modules }),
    diagnostics: (graph.diagnostics ?? []).filter((diagnostic) =>
      diagnostic.file === undefined || files.includes(diagnostic.file)),
    relatedModules: {
      imports: subjectModule.imports.filter((name) => selected.has(name)),
      importedBy: graph.modules
        .filter((module) => module.imports.includes(subjectModule.name))
        .map((module) => module.name)
        .sort(),
    },
  };
}

function allAspects(module: ModuleNode): AspectRefNode[] {
  return [
    ...(module.aspects ?? []),
    ...module.controllers.flatMap((controller) => controller.routes.flatMap((route) => route.aspects ?? [])),
    ...module.commands.flatMap((command) => command.aspects ?? []),
    ...(module.jobs ?? []).flatMap((job) => job.aspects ?? []),
  ];
}

/** Static plan, not runtime discovery; custom executors remain explicit boundaries. */
export function createExecutionPlans(graph: ApplicationGraph): ExecutionPlan[] {
  const aspects = (boundary: string, refs: AspectRefNode[] = []) =>
    refs.map((ref, index) => `${boundary}.aspect[${index}]:${ref.name}`);
  return graph.modules.flatMap((module): ExecutionPlan[] => [
    ...module.controllers.flatMap((controller) => controller.routes.map((route): ExecutionPlan => {
      const command = module.commands.find((item) => item.className === route.command);
      const path = `${controller.path}/${route.path}`.replace(/\/+/g, "/");
      return {
        module: module.name,
        kind: "route",
        name: `${route.method} ${path.length > 1 ? path.replace(/\/+$/, "") : path}`,
        ...(command ? { command: command.name } : {}),
        stages: [
          ...aspects(`module:${module.name}`, module.aspects),
          ...aspects("route", route.aspects),
          ...aspects("command", command?.aspects),
          ...(command ? [
            "commandExecutor",
            "authorize",
            ...(command.rpc ? [`rpc:${command.rpc}`] : [
              ...(command.idempotency === "required" ? ["idempotency"] : []),
              ...(command.transaction === "required" ? ["transaction"] : []),
            ]),
          ] : []),
          "handler",
          ...(command?.audit && !command.rpc ? ["audit"] : []),
        ],
      };
    })),
    ...module.commands.map((command): ExecutionPlan => ({
      module: module.name, kind: "command", name: command.name, command: command.name,
      stages: ["authorize",
        ...(command.rpc ? [`rpc:${command.rpc}`] : [
          ...(command.idempotency === "required" ? ["idempotency"] : []),
          ...(command.transaction === "required" ? ["transaction"] : []),
        ]),
        ...aspects(`module:${module.name}`, module.aspects), ...aspects("command", command.aspects),
        "handler", ...(command.audit && !command.rpc ? ["audit"] : [])],
    })),
    ...(module.jobs ?? []).map((job): ExecutionPlan => ({
      module: module.name,
      kind: "job",
      name: job.name,
      stages: [...aspects(`module:${module.name}`, module.aspects), ...aspects("job", job.aspects), "jobExecutor", "handler"],
    })),
  ]);
}

export function doctorProject(
  rootDir: string,
  outDir: string,
  graph: ApplicationGraph,
  upToDate: boolean,
  diagnostics: Diagnostic[] = [],
): DoctorResult {
  const checks = [
    {
      name: "project-root",
      ok: existsSync(rootDir),
      detail: existsSync(rootDir) ? rootDir : `missing: ${rootDir}`,
    },
    {
      name: "tsconfig",
      ok: existsSync(join(rootDir, "tsconfig.json")),
      detail: existsSync(join(rootDir, "tsconfig.json")) ? "tsconfig.json found" : "tsconfig.json missing",
    },
    {
      name: "modules",
      ok: graph.modules.length > 0,
      detail: `${graph.modules.length} module(s) discovered`,
    },
    {
      name: "generated-artifacts",
      ok: upToDate,
      detail: upToDate ? "application.ts and app.manifest.json are up to date" : "generated artifacts are missing or stale",
    },
  ];
  const allDiagnostics = [...(graph.diagnostics ?? []), ...diagnostics];
  return {
    checks,
    diagnostics: allDiagnostics,
    errors: allDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length + checks.filter((check) => !check.ok).length,
  };
}

function explainModule(graph: ApplicationGraph, module: ModuleNode): string {
  const dependents = graph.modules.filter((candidate) => candidate.imports.includes(module.name)).map((candidate) => candidate.name);
  return [
    `MODULE ${module.name}`,
    `  file: ${module.file}:${module.line}`,
    `  imports: ${module.imports.length > 0 ? module.imports.join(", ") : "-"}`,
    `  imported by: ${dependents.length > 0 ? dependents.join(", ") : "-"}`,
    `  providers: ${module.providers.length > 0 ? module.providers.map((provider) => provider.token).join(", ") : "-"}`,
    `  controllers: ${module.controllers.length > 0 ? module.controllers.map((controller) => controller.className).join(", ") : "-"}`,
    `  commands: ${module.commands.length > 0 ? module.commands.map((command) => command.name).join(", ") : "-"}`,
    ...createExecutionPlans({ ...graph, modules: [module] })
      .map((plan) => `  execution ${plan.name}: ${plan.stages.join(" -> ")}`),
  ].join("\n");
}

function explainProvider(graph: ApplicationGraph, module: ModuleNode, provider: ProviderNode): string {
  const dependents = graph.modules.flatMap((candidate) => [
    ...candidate.providers.filter((item) => item.deps.includes(provider.token)).map((item) => `${candidate.name}.${item.token}`),
    ...candidate.controllers.filter((item) => item.deps.includes(provider.token)).map((item) => `${candidate.name}.${item.className}`),
  ]);
  return [
    `PROVIDER ${provider.token}`,
    `  module: ${module.name}`,
    `  file: ${provider.file}:${provider.line}`,
    `  kind: ${provider.kind}`,
    `  scope: ${provider.scope}`,
    `  exported: ${provider.exported ? "yes" : "no"}`,
    `  deps: ${provider.deps.length > 0 ? provider.deps.join(", ") : "-"}`,
    `  depended on by: ${dependents.length > 0 ? dependents.join(", ") : "-"}`,
  ].join("\n");
}

function findProvider(graph: ApplicationGraph, subject: string): { module: ModuleNode; provider: ProviderNode } | undefined {
  for (const module of graph.modules) {
    const provider = module.providers.find((candidate) => candidate.token === subject || candidate.useClass === subject || candidate.useFactoryName === subject);
    if (provider) return { module, provider };
  }
  return undefined;
}

/**
 * Exports the application module architecture as a Mermaid graph diagram.
 */
export function exportGraphMermaid(graph: ApplicationGraph): string {
  const lines: string[] = ["graph TD"];
  for (const mod of graph.modules) {
    const safeId = mod.name.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`  ${safeId}["${mod.className ?? mod.name}"]`);
    for (const imp of mod.imports) {
      const safeImp = imp.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${safeId} --> ${safeImp}`);
    }
  }
  return lines.join("\n");
}

/**
 * Exports the application module architecture as a Graphviz DOT script.
 */
export function exportGraphDot(graph: ApplicationGraph): string {
  const lines: string[] = [
    'digraph ApplicationGraph {',
    '  rankdir=LR;',
    '  node [shape=box, fontname="Helvetica"];',
  ];
  for (const mod of graph.modules) {
    lines.push(`  "${mod.name}" [label="${mod.className ?? mod.name}"];`);
    for (const imp of mod.imports) {
      lines.push(`  "${mod.name}" -> "${imp}";`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}
