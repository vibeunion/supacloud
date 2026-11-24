import { dirname, relative } from "node:path";
import type { ApplicationGraph, DiagnosticFix, ModuleNode, RouteNode } from "./types";

export type InferenceReadiness = "safe" | "confirm" | "never";

export interface InferenceItem {
  id: string;
  field: string;
  value: unknown;
  readiness: InferenceReadiness;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  action?: "apply" | "confirm" | "manual";
  fix?: DiagnosticFix;
}

export interface InferencePlan {
  version: 1;
  source: "application-graph";
  rootModule?: string;
  rootModuleCandidates: string[];
  items: InferenceItem[];
  explicitInputs: string[];
  commands: Record<string, string>;
  next: string[];
}

export interface InferenceOptions {
  rootDir?: string;
  sourceDir?: string;
  generatedDir?: string;
}

function rootModules(graph: ApplicationGraph): ModuleNode[] {
  const imported = new Set(graph.modules.flatMap((module) => module.imports));
  return graph.modules.filter((module) => !imported.has(module.name));
}

function routeInference(
  controller: ModuleNode["controllers"][number],
  route: RouteNode,
): InferenceItem[] {
  const items: InferenceItem[] = [];
  const pathParams = route.pathParams ?? [];
  const declaredParams = new Set(route.paramBindings ?? []);
  const declaredQueries = new Set(route.queryBindings ?? []);
  for (const parameter of route.handlerParams ?? []) {
    if (parameter.kind !== "unknown") continue;
    if (pathParams.includes(parameter.name) && !declaredParams.has(parameter.name)) {
      items.push({
        id: `route-param:${controller.className}:${route.handler}:${parameter.name}`,
        field: "route.parameterBinding",
        value: { controller: controller.className, route: route.handler, parameter: parameter.name, binding: "param" },
        readiness: "safe",
        confidence: "high",
        evidence: [`${route.method} ${route.path} contains :${parameter.name}`, `handler parameter "${parameter.name}" is unbound`],
        action: "apply",
        fix: {
          type: "add_route_parameter_binding",
          targetFile: controller.file,
          controller: controller.className,
          route: route.handler,
          parameter: parameter.name,
          binding: "param",
        },
      });
    } else if (!pathParams.includes(parameter.name) && !declaredQueries.has(parameter.name)) {
      items.push({
        id: `route-query:${controller.className}:${route.handler}:${parameter.name}`,
        field: "route.parameterBinding",
        value: { controller: controller.className, route: route.handler, parameter: parameter.name, binding: "query" },
        readiness: "confirm",
        confidence: "medium",
        evidence: [`handler parameter "${parameter.name}" is unbound`, "parameter is not present in the route path"],
        action: "confirm",
        fix: {
          type: "add_route_parameter_binding",
          targetFile: controller.file,
          controller: controller.className,
          route: route.handler,
          parameter: parameter.name,
          binding: "query",
        },
      });
    }
  }
  if ((route.method === "POST" || route.method === "PUT" || route.method === "PATCH" || route.method === "DELETE")
    && route.command === undefined) {
    items.push({
      id: `route-write:${controller.className}:${route.handler}`,
      field: "route.writeBoundary",
      value: "command-or-explicit-write-contract",
      readiness: "never",
      confidence: "high",
      evidence: [`${route.method} is a mutating HTTP method`, "no governed Command is bound"],
      action: "manual",
    });
  }
  return items;
}

/**
 * A missing module import is only suggested when exactly one module exports the
 * injected token, that module is not imported and the consumer has no local
 * binding. Composition still changes, so the item stays `confirm`.
 */
function dependencyInference(graph: ApplicationGraph): InferenceItem[] {
  const exporters = new Map<string, ModuleNode[]>();
  for (const module of graph.modules) {
    for (const token of module.exports) {
      const owners = exporters.get(token) ?? [];
      owners.push(module);
      exporters.set(token, owners);
    }
  }
  const items: InferenceItem[] = [];
  for (const module of graph.modules) {
    const imported = new Set(module.imports);
    const local = new Set(module.providers.map((provider) => provider.token));
    const consumed = new Set<string>();
    for (const provider of module.providers) {
      for (const token of provider.deps) consumed.add(token);
      for (const inject of provider.functionalInjects ?? []) consumed.add(inject.token);
    }
    for (const controller of module.controllers) {
      for (const token of controller.deps) consumed.add(token);
      for (const inject of controller.functionalInjects ?? []) consumed.add(inject.token);
    }
    for (const token of consumed) {
      if (local.has(token)) continue;
      const owners = (exporters.get(token) ?? []).filter((owner) => owner.name !== module.name);
      if (owners.length !== 1) continue;
      const owner = owners[0]!;
      if (imported.has(owner.name)) continue;
      const target = relative(dirname(module.file), owner.file)
        .replace(/\.(tsx?|mts|cts)$/, "")
        .replaceAll("\\", "/");
      items.push({
        id: `module-dependency:${module.name}:${owner.name}:${token}`,
        field: "module.imports",
        value: { module: module.name, imports: owner.name, token },
        readiness: "confirm",
        confidence: "medium",
        evidence: [
          `${module.name} injects ${token}`,
          `${owner.name} is the only module exporting ${token}`,
          `${module.name} does not import ${owner.name}`,
        ],
        action: "confirm",
        fix: {
          type: "add_module_import",
          targetFile: module.file,
          module: owner.name,
          provider: token,
          symbol: owner.className,
          targetModule: module.name,
          importPath: target.startsWith(".") ? target : `./${target}`,
        },
      });
    }
  }
  return items.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

/**
 * Table operation ownership is declared per table operation in the database
 * module. It is never derived from an application Command or route name.
 */
function ownershipInference(graph: ApplicationGraph): InferenceItem | undefined {
  if (!graph.modules.some((module) => module.commands.length > 0 || module.controllers.length > 0)) {
    return undefined;
  }
  return {
    id: "database.operation-ownership",
    field: "database.operationOwnership",
    value: "declared-per-table-operation",
    readiness: "never",
    confidence: "high",
    evidence: [
      "table operation ownership is declared in db/modules.ts operationOwnership",
      "the application graph never asserts which table operations a Command or route may perform",
    ],
    action: "manual",
  };
}

/**
 * Derive only facts that are structural or directly evidenced by the graph.
 * Business policy is deliberately represented as `never`, not guessed.
 */
export function createInferencePlan(
  graph: ApplicationGraph,
  options: InferenceOptions = {},
): InferencePlan {
  const candidates = rootModules(graph).sort((left, right) => left.name.localeCompare(right.name, "en"));
  const items: InferenceItem[] = [];
  if (candidates.length === 1) {
    const root = candidates[0]!;
    items.push({
      id: "application.root-module",
      field: "application.rootModule",
      value: root.name,
      readiness: "safe",
      confidence: "high",
      evidence: ["module is not imported by another declared module"],
      action: "apply",
    });
  } else if (candidates.length > 1) {
    items.push({
      id: "application.root-module",
      field: "application.rootModule",
      value: candidates.map((module) => module.name),
      readiness: "confirm",
      confidence: "medium",
      evidence: ["multiple top-level modules are present"],
      action: "confirm",
    });
  }

  for (const module of graph.modules) {
    for (const controller of module.controllers) {
      for (const route of controller.routes) items.push(...routeInference(controller, route));
    }
    for (const command of module.commands) {
      if (command.permission === undefined) {
        items.push({
          id: `command-permission:${module.name}:${command.name}`,
          field: "command.permission",
          value: `${module.name}.${command.name.split(".").at(-1) ?? command.name}`,
          readiness: "never",
          confidence: "low",
          evidence: ["Command has no explicit permission"],
          action: "manual",
        });
      }
    }
  }
  items.push(...dependencyInference(graph));
  const ownership = ownershipInference(graph);
  if (ownership !== undefined) items.push(ownership);

  const explicitInputs = [
    "business permissions",
    "tenant and RLS policy",
    "table operation ownership in db/modules.ts",
    "database source/table/type for feature scaffolds",
    "external side-effect retry and reconciliation policy",
  ];
  const root = candidates.length === 1 ? candidates[0]!.name : undefined;
  const sourceDir = options.sourceDir ?? "src";
  const generatedDir = options.generatedDir ?? "generated";
  const commands = {
    infer: "supacloud app infer --format json",
    context: "supacloud app context --format json",
    check: "supacloud app check --format json",
    doctor: "supacloud app doctor --format json",
    verifyPlan: root
      ? `supacloud app verify-plan --target ${root}`
      : "supacloud app verify-plan --target <module>",
    ownershipSuggest: "supacloud db operation-ownership suggest",
    ownershipAdopt: "supacloud db operation-ownership adopt",
  };
  const next = [
    commands.infer,
    commands.context,
    commands.verifyPlan,
    commands.check,
    commands.ownershipSuggest,
  ];
  return {
    version: 1,
    source: "application-graph",
    ...(root === undefined ? {} : { rootModule: root }),
    rootModuleCandidates: candidates.map((module) => module.name),
    items: [
      {
        id: "project.source-layout",
        field: "project.layout",
        value: { sourceDir, generatedDir, rootDir: options.rootDir ?? "." },
        readiness: "safe",
        confidence: "high",
        evidence: ["resolved compiler configuration"],
        action: "apply",
      },
      ...items,
    ],
    explicitInputs,
    commands,
    next,
  };
}

export function formatInferencePlan(plan: InferencePlan): string {
  const lines = [
    `INFERENCE v${plan.version}`,
    `  root module: ${plan.rootModule ?? "(ambiguous)"}`,
    `  candidates: ${plan.rootModuleCandidates.join(", ") || "-"}`,
  ];
  for (const item of plan.items) {
    const value = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
    lines.push(`  ${item.readiness.toUpperCase()} ${item.field} = ${value}`);
    lines.push(`    evidence: ${item.evidence.join("; ")}`);
  }
  lines.push(`  explicit inputs: ${plan.explicitInputs.join("; ")}`);
  lines.push(`  next: ${plan.next.join(" -> ")}`);
  lines.push(`  ownership: ${plan.commands["ownershipSuggest"]} -> ${plan.commands["ownershipAdopt"]}`);
  return lines.join("\n");
}
