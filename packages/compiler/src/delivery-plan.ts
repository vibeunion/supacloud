import { createHash } from "node:crypto";
import { checkProject } from "./compile";
import {
  DeliveryConfigurationError, parseDeliveryOptions, parseDeliveryPlanResult,
  type DeliveryDiagnostic, type DeliveryOptions, type DeliveryPlanResult, type DeliveryTarget,
} from "./delivery-schema";
import type { ApplicationGraph, CompileOptions, Diagnostic, ModuleNode } from "./types";
import { joinRoutePaths } from "./util";
import { validateGraph } from "./validate";

type TargetDeclaration = NonNullable<DeliveryOptions["targets"]>[number];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

function diagnostic(error: Diagnostic): DeliveryDiagnostic {
  return {
    severity: error.severity, code: error.code, message: error.message,
    ...(error.file === undefined ? {} : { file: error.file }),
    ...(error.line === undefined ? {} : { line: error.line }),
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
  };
}

/** Trusted compiler graph in, validated topology preview out. No file or remote writes. */
export function createDeliveryPlan(
  graph: ApplicationGraph,
  input?: unknown,
): DeliveryPlanResult {
  let options: DeliveryOptions;
  try {
    options = parseDeliveryOptions(input);
  } catch (error) {
    if (!(error instanceof DeliveryConfigurationError)) throw error;
    return { ok: false, plan: null, written: [], diagnostics: [{
      severity: "error", code: error.code, message: error.message,
      suggestion: "Use DeliveryOptionsSchema or defineSupacloudConfig({ delivery: ... }).",
    }] };
  }

  const diagnostics: DeliveryDiagnostic[] = [
    ...(graph.diagnostics ?? []).map(diagnostic),
    ...validateGraph(graph, { strict: true }).map(diagnostic),
  ];
  const fail = (code: string, message: string, suggestion: string): void => {
    diagnostics.push({ severity: "error", code, message, suggestion });
  };
  const modules = new Map(graph.modules.map((module) => [module.name, module]));
  const declarations = new Map<string, TargetDeclaration>();
  const httpOwners = new Map<string, string>();
  const jobOwners = new Map<string, string>();

  for (const target of [...options.targets ?? []].sort((a, b) => compare(a.name, b.name))) {
    if (declarations.has(target.name)) {
      fail("delivery-duplicate-target", `Target "${target.name}" is declared more than once.`, "Give each target a unique name.");
      continue;
    }
    declarations.set(target.name, target);
    if ((target.name === "api" && target.kind !== "api") || (target.name === "jobs" && target.kind !== "jobs")) {
      fail("delivery-reserved-target", `"${target.name}" is reserved for its matching workload kind.`, "Rename the target or use the matching kind.");
    }
    for (const name of sorted(target.modules)) {
      if (!modules.has(name)) {
        fail("delivery-unknown-module", `Target "${target.name}" refers to unknown module "${name}".`, "Select a module name from the compiler graph.");
        continue;
      }
      const owners = target.kind === "jobs" ? jobOwners : httpOwners;
      const existing = owners.get(name);
      if (existing !== undefined) {
        fail("delivery-ownership-conflict", `Module "${name}" has competing ${target.kind === "jobs" ? "job" : "HTTP"} owners "${existing}" and "${target.name}".`,
          "Assign each module's HTTP routes and jobs to at most one target of each workload category.");
      } else owners.set(name, target.name);
    }
  }

  const targets = new Map<string, DeliveryTarget>();
  function getTarget(name: string, fallback: "api" | "jobs"): DeliveryTarget {
    const existing = targets.get(name);
    if (existing) return existing;
    const declaration = declarations.get(name);
    const kind = declaration?.kind ?? fallback;
    const isolation = declaration?.isolation ?? (kind === "jobs" ? "process" : "shared");
    const target: DeliveryTarget = {
      name, kind, isolation, roots: [], modules: [], routes: [], jobs: [], externalTokens: [],
      requirements: {
        processIsolation: isolation === "process",
        durableQueue: kind === "jobs",
        capabilities: sorted(declaration?.capabilities ?? []),
      },
      runtimeStatus: options.runtime === undefined ? "unchecked" : "declared-compatible",
    };
    targets.set(name, target);
    return target;
  }

  const publicRoutes = new Map<string, string>();
  const publicJobs = new Map<string, string>();
  for (const module of [...graph.modules].sort((a, b) => compare(a.name, b.name))) {
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const owner = httpOwners.get(module.name);
        const target = getTarget(owner ?? "api", "api");
        const path = joinRoutePaths(controller.path, route.path);
        // Parameter names must not hide a routing collision across deployment targets.
        const key = `${route.method} ${path.replace(/:[^/]+/g, ":param")}`;
        const existing = publicRoutes.get(key);
        if (existing !== undefined) {
          fail("delivery-route-conflict", `Public route "${key}" is owned by both "${existing}" and "${target.name}".`,
            "Give public routes unambiguous method/path contracts before splitting targets.");
        }
        publicRoutes.set(key, target.name);
        target.roots.push(module.name);
        target.routes.push({
          module: module.name, controller: controller.className, handler: route.handler,
          method: route.method, path,
          ...(route.command === undefined ? {} : { command: route.command }),
          reason: owner === undefined ? "default-http" : "explicit-module",
        });
      }
    }
    for (const job of module.jobs ?? []) {
      const owner = jobOwners.get(module.name);
      const target = getTarget(owner ?? "jobs", "jobs");
      if (publicJobs.has(job.name)) {
        fail("delivery-job-conflict", `Job "${job.name}" is declared more than once.`, "Use globally unique job names.");
      }
      publicJobs.set(job.name, target.name);
      target.roots.push(module.name);
      target.jobs.push({
        module: module.name, name: job.name, className: job.className, serviceKey: job.serviceKey,
        reason: owner === undefined ? "declared-job" : "explicit-module",
      });
    }
  }

  for (const declaration of declarations.values()) {
    if (!targets.has(declaration.name)) {
      fail("delivery-empty-target", `Target "${declaration.name}" owns no ${declaration.kind === "jobs" ? "jobs" : "HTTP routes"}.`,
        "Select modules containing the intended workload or remove the target declaration.");
    }
  }
  if (targets.size === 0 && declarations.size === 0) getTarget("api", "api");

  for (const target of targets.values()) {
    target.roots = sorted(target.roots);
    // Module-granularity closure is deliberately conservative; no provider-level pruning.
    const closure = new Map<string, ModuleNode>();
    const visiting = new Set<string>();
    function visit(name: string): void {
      if (visiting.has(name)) {
        fail("delivery-import-cycle", `Target "${target.name}" contains an import cycle at "${name}".`, "Remove cyclic module imports.");
        return;
      }
      if (closure.has(name)) return;
      const module = modules.get(name);
      if (!module) {
        fail("delivery-missing-import", `Target "${target.name}" requires missing module "${name}".`, "Declare or correct the imported module.");
        return;
      }
      visiting.add(name);
      for (const imported of sorted(module.imports)) visit(imported);
      visiting.delete(name);
      closure.set(name, module);
    }
    for (const root of target.roots) visit(root);
    target.modules = sorted(closure.keys()).map((name) => ({
      name, reason: target.roots.includes(name) ? "owner" : "dependency",
      importedBy: sorted([...closure.values()].filter((module) => module.imports.includes(name)).map((module) => module.name)),
    }));
    const dependencies = new Set([...closure.values()].flatMap((module) => [
      ...module.providers.flatMap((provider) => provider.deps),
      ...module.controllers.flatMap((controller) => controller.deps),
    ]));
    target.externalTokens = sorted(graph.externalTokens.filter((token) => dependencies.has(token)));
    target.routes.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    target.jobs.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    const runtime = options.runtime;
    if (target.requirements.durableQueue && runtime?.durableQueue !== true) {
      fail("delivery-queue-required", `Target "${target.name}" requires a declared durable queue.`,
        "Configure a durable queue adapter and declare runtime.durableQueue; do not run jobs in an HTTP background Promise.");
    }
    if (target.requirements.processIsolation && runtime?.processIsolation !== true) {
      fail("delivery-isolation-required", `Target "${target.name}" requires declared process isolation.`,
        "Select a process-isolated host and declare runtime.processIsolation. A Worker or function name alone is insufficient.");
    }
    for (const capability of target.requirements.capabilities) {
      if (!runtime?.capabilities.includes(capability)) {
        fail("delivery-capability-required", `Target "${target.name}" requires capability reference "${capability}".`,
          "Configure the named adapter or credential boundary and declare its reference, never its secret value.");
      }
    }
  }

  const canonicalDiagnostics = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()]
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  if (canonicalDiagnostics.some((item) => item.severity === "error")) {
    return parseDeliveryPlanResult({ ok: false, plan: null, diagnostics: canonicalDiagnostics, written: [] });
  }
  const topology = {
    schemaVersion: 1, policyVersion: "module-workload-v1", digestScope: "topology-only",
    deploymentReady: false, targets: [...targets.values()].sort((a, b) => compare(a.name, b.name)),
  } as const;
  const topologyDigest = createHash("sha256").update(JSON.stringify(topology)).digest("hex");
  return parseDeliveryPlanResult({
    ok: true, plan: { ...topology, topologyDigest }, diagnostics: canonicalDiagnostics, written: [],
  });
}

/** Reuse all compiler gates without requiring generated files to already exist. */
export async function planDeliveryProject(
  options: CompileOptions,
  delivery?: unknown,
): Promise<DeliveryPlanResult> {
  // Reject malformed configuration before reading or evaluating project sources.
  try {
    parseDeliveryOptions(delivery);
  } catch (error) {
    if (!(error instanceof DeliveryConfigurationError)) throw error;
    return createDeliveryPlan({ modules: [], externalTokens: [] }, delivery);
  }
  const checked = await checkProject(options);
  return createDeliveryPlan({ ...checked.graph, diagnostics: checked.diagnostics }, delivery);
}

export function formatDeliveryPlan(result: DeliveryPlanResult): string {
  const lines = result.ok
    ? [
      `DELIVERY PLAN ${result.plan.topologyDigest}`,
      "Preview only: topology digest is not a build hash or deployment approval.",
      ...result.plan.targets.flatMap((target) => [
        `${target.name} (${target.kind}, ${target.isolation}): ${target.routes.length} route(s), ${target.jobs.length} job(s)`,
        `  modules: ${target.modules.map((module) => module.name).join(", ") || "-"}`,
        ...target.routes.map((route) => `  ${route.method} ${route.path} [${route.reason}]`),
        ...target.jobs.map((job) => `  job ${job.name} [${job.reason}]`),
      ]),
    ]
    : ["Delivery planning failed; no files written."];
  return [...lines, ...result.diagnostics.map((item) => `${item.severity} ${item.code}: ${item.message}`)].join("\n");
}
