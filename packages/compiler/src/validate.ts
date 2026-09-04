import type {
  ApplicationGraph,
  ControllerNode,
  Diagnostic,
  ModuleBoundaryRule,
  ModuleNode,
  ProviderNode,
  Scope,
  ValidateOptions,
} from "./types";
import { resolveModuleBoundaries } from "./profiles";

const SCOPE_LIFETIME_RANK: Record<Scope, number> = {
  application: 0,
  request: 1,
  job: 1,
};

interface ProviderRef {
  module: ModuleNode;
  provider: ProviderNode;
}

/**
 * Validates ApplicationGraph and produces diagnostics list.
 * In strict mode, warn-level diagnostics are promoted to error.
 */
export function validateGraph(
  graph: ApplicationGraph,
  options: boolean | ValidateOptions = false,
): Diagnostic[] {
  const strict = typeof options === "boolean" ? options : (options.strict ?? false);
  const diagnostics: Diagnostic[] = [];

  let moduleBoundaries: ModuleBoundaryRule[] | undefined;
  if (typeof options === "object") {
    try {
      moduleBoundaries = resolveModuleBoundaries({
        preset: options.moduleBoundaryPreset,
        rules: options.moduleBoundaries,
      });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "invalid-boundary-preset",
        message: err instanceof Error ? err.message : String(err),
        file: graph.modules[0]?.file,
        line: graph.modules[0]?.line,
      });
    }
  }

  // Global token -> provider index (duplicate registrations within same module reported by duplicate-token; index keeps first).
  const globalProviders = new Map<string, ProviderRef>();
  for (const module of graph.modules) {
    for (const provider of module.providers) {
      if (!globalProviders.has(provider.token)) {
        globalProviders.set(provider.token, { module, provider });
      }
    }
  }

  /** Resolves dep token in module visibility scope: own providers > imported module exports. */
  function resolveDep(module: ModuleNode, token: string): ProviderRef | undefined {
    const own = module.providers.find((p) => p.token === token);
    if (own) return { module, provider: own };
    for (const importName of module.imports) {
      const imported = graph.modules.find((m) => m.name === importName);
      if (!imported || !imported.exports.includes(token)) continue;
      const provider = imported.providers.find((p) => p.token === token);
      if (provider) return { module: imported, provider };
    }
    return undefined;
  }

  const error = (
    code: string,
    message: string,
    file?: string,
    line?: number,
  ): void => {
    diagnostics.push({ severity: "error", code, message, file, line });
  };
  const warn = (
    code: string,
    message: string,
    file?: string,
    line?: number,
  ): void => {
    diagnostics.push({ severity: strict ? "error" : "warn", code, message, file, line });
  };

  const modulesByName = new Map<string, ModuleNode>();
  const commandsByName = new Map<string, { module: ModuleNode; className: string }>();
  const routesByKey = new Map<string, { module: ModuleNode; controller: ControllerNode }>();

  for (const module of graph.modules) {
    const previousModule = modulesByName.get(module.name);
    if (previousModule) {
      error(
        "duplicate-module",
        `模块名 ${module.name} 重复（首次声明于 ${previousModule.file}:${previousModule.line}）`,
        module.file,
        module.line,
      );
    } else {
      modulesByName.set(module.name, module);
    }

    for (const command of module.commands) {
      const previousName = commandsByName.get(command.name);
      if (previousName) {
        error(
          "duplicate-command",
          `command 名 ${command.name} 重复（首次由模块 ${previousName.module.name} 的 ${previousName.className} 声明）`,
          module.file,
          module.line,
        );
      } else {
        commandsByName.set(command.name, { module, className: command.className });
      }
    }

  }

  for (const module of graph.modules) {
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const fullPath = joinRoutePaths(controller.path, route.path);
        const key = `${route.method} ${fullPath}`;
        const previous = routesByKey.get(key);
        if (previous) {
          error(
            "duplicate-route",
            `路由 ${key} 重复（首次声明于模块 ${previous.module.name} 的 ${previous.controller.className}）`,
            controller.file,
          );
        } else {
          routesByKey.set(key, { module, controller });
        }

        if (route.command && !module.commands.some((command) => command.className === route.command)) {
          error(
            "route-command-unresolved",
            `路由 ${key} 绑定的 command 类 ${route.command} 未在模块 ${module.name} 声明`,
            controller.file,
          );
        }

        if (typeof options === "object" && options.allowRouteCommandBindings === false && route.command) {
          error(
            "route-command-binding-disallowed",
            `Route ${key} binds command ${route.command}, but route-level command bindings are disabled by policy. Use an application service (${controller.className}.${route.handler}, ${controller.file}).`,
            controller.file,
          );
        }
      }

      if (typeof options === "object" && options.disallowControllerDirectDb) {
        for (const dep of controller.deps) {
          const isDbClient =
            dep === "DB_CLIENT" ||
            dep === "DatabaseClient" ||
            graph.tokenNames?.[dep] === "supacloud.db-client";
          if (isDbClient) {
            error(
              "controller-direct-db-access",
              `Controller ${controller.className} directly injects database client '${dep}', violating presentation layer separation (${controller.file})`,
              controller.file,
            );
          }
        }
      }
    }
  }

  for (const module of graph.modules) {
    // duplicate-token: Same token registered multiple times within the same module.
    const seen = new Map<string, ProviderNode>();
    for (const provider of module.providers) {
      const first = seen.get(provider.token);
      if (first) {
        error(
          "duplicate-token",
          `模块 ${module.name} 重复注册 token ${provider.token}（首次注册于 ${first.file}:${first.line}）`,
          provider.file,
          provider.line,
        );
      } else {
        seen.set(provider.token, provider);
      }
    }

    // scope-violation / module boundary: check dependencies of each provider.
    for (const provider of module.providers) {
      for (const dep of provider.deps) {
        const resolved = resolveDep(module, dep);
        if (!resolved) {
          if (!graph.externalTokens.includes(dep)) {
            if (globalProviders.has(dep)) {
              const owner = globalProviders.get(dep)!;
              error(
                "module-boundary",
                `模块 ${module.name} 的 provider ${provider.token} 依赖 ${dep}，该 token 由模块 ${owner.module.name} 提供但未被 import`,
                provider.file,
                provider.line,
              );
            } else {
              error(
                "unresolved-token",
                `模块 ${module.name} 的 provider ${provider.token} 依赖的 token ${dep} 无法解析`,
                provider.file,
                provider.line,
              );
            }
          }
          continue;
        }
        // Controllers belong to request scope and are not restricted here (can depend on application).
        if (
          SCOPE_LIFETIME_RANK[resolved.provider.scope] > SCOPE_LIFETIME_RANK[provider.scope]
        ) {
          error(
            "scope-violation",
            `模块 ${module.name} 的 ${provider.scope} provider ${provider.token} 不能依赖 ${resolved.provider.scope} provider ${dep}`,
            provider.file,
            provider.line,
          );
        }
      }
    }

    // command-missing-permission: Commands without permission declarations must not generate adoptable applications.
    for (const command of module.commands) {
      if (!command.permission) {
        error(
          "command-missing-permission",
          `模块 ${module.name} 的 command ${command.name} (${command.className}) 未声明 permission`,
          module.file,
          module.line,
        );
      }

      if (typeof options === "object" && options.commandCapabilities) {
        const caps = options.commandCapabilities;
        const location = `${command.className} (${module.file})`;
        if (command.permission && caps.permission === false) {
          error(
            "command-permission-unsupported",
            `Command ${command.name} declares permission, but runtime permission checks are unavailable (${location}).`,
            module.file,
            module.line,
          );
        }
        if (command.audit && caps.audit === false) {
          error(
            "command-audit-unsupported",
            `Command ${command.name} declares audit, but audit persistence is unavailable (${location}).`,
            module.file,
            module.line,
          );
        }
        if (command.idempotency === "required" && caps.idempotency === false) {
          error(
            "command-idempotency-unsupported",
            `Command ${command.name} declares idempotency, but idempotency receipt persistence is unavailable (${location}).`,
            module.file,
            module.line,
          );
        }
        if (command.transaction === "required") {
          if (caps.transaction === "rpc-only") {
            warn(
              "command-transaction-rpc-only",
              `Command ${command.name} declares transaction: 'required', but only DB RPC transactions are available; multi-table writes must use one DB RPC (${location}).`,
              module.file,
              module.line,
            );
          } else if (caps.transaction === false) {
            error(
              "command-transaction-unsupported",
              `Command ${command.name} declares transaction: 'required', but transaction support is unavailable (${location}).`,
              module.file,
              module.line,
            );
          }
        }
      }
    }
  }

  // module-boundary-violation: Architecture layering and dependency flow validation based on module tags and boundary rules.
  if (moduleBoundaries && moduleBoundaries.length > 0) {
    for (const module of graph.modules) {
      const sourceTags = module.tags ?? [];
      for (const importName of module.imports) {
        const targetModule = graph.modules.find((m) => m.name === importName);
        if (!targetModule) continue;
        const targetTags = targetModule.tags ?? [];

        for (const rule of moduleBoundaries) {
          const matchesSource = rule.sourceTag === "*" || sourceTags.includes(rule.sourceTag);
          if (!matchesSource) continue;

          if (rule.bannedDependenciesWithTags) {
            for (const bannedTag of rule.bannedDependenciesWithTags) {
              if (targetTags.includes(bannedTag)) {
                error(
                  "module-boundary-violation",
                  `模块 ${module.name} (tags: [${sourceTags.join(", ")}]) 禁止依赖带有标签 '${bannedTag}' 的模块 ${targetModule.name} (tags: [${targetTags.join(", ")}])`,
                  module.file,
                  module.line,
                );
              }
            }
          }

          if (rule.onlyDependOnLibsWithTags && rule.onlyDependOnLibsWithTags.length > 0) {
            const hasAllowed = targetTags.some((t) => rule.onlyDependOnLibsWithTags!.includes(t));
            if (!hasAllowed && targetTags.length > 0) {
              error(
                "module-boundary-violation",
                `模块 ${module.name} (tags: [${sourceTags.join(", ")}]) 仅允许依赖带有 [${rule.onlyDependOnLibsWithTags.join(", ")}] 标签的模块，但模块 ${targetModule.name} 的标签为 [${targetTags.join(", ")}]`,
                module.file,
                module.line,
              );
            }
          }
        }
      }
    }
  }

  diagnostics.push(...detectCycles(graph, resolveDep));
  diagnostics.push(...detectModuleCycles(graph));
  if (typeof options === "object" && options.detectOrphanModules) {
    diagnostics.push(...detectOrphanModules(graph));
  }
  return diagnostics;
}

function joinRoutePaths(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/");
  const normalized = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  return normalized.replace(/:[^/]+/g, ":param");
}

/** Provider-level circular dependency detection (DFS, reporting cycle path). */
function detectCycles(
  graph: ApplicationGraph,
  resolveDep: (module: ModuleNode, token: string) => ProviderRef | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeId = (ref: ProviderRef) => `${ref.module.name}:${ref.provider.token}`;
  const nodes: ProviderRef[] = graph.modules.flatMap((module) =>
    module.providers.map((provider) => ({ module, provider })),
  );

  const state = new Map<string, "visiting" | "done">();
  const stack: ProviderRef[] = [];
  const reported = new Set<string>();

  const visit = (ref: ProviderRef): void => {
    const id = nodeId(ref);
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.findIndex((item) => nodeId(item) === id);
      const cycle = [...stack.slice(cycleStart), ref];
      const path = cycle.map((item) => item.provider.token).join(" -> ");
      const cycleKey = cycle
        .map((item) => nodeId(item))
        .sort()
        .join("|");
      if (!reported.has(cycleKey)) {
        reported.add(cycleKey);
        diagnostics.push({
          severity: "error",
          code: "circular-dependency",
          message: `provider 循环依赖: ${path}`,
          file: ref.provider.file,
          line: ref.provider.line,
        });
      }
      return;
    }
    state.set(id, "visiting");
    stack.push(ref);
    for (const dep of ref.provider.deps) {
      const resolved = resolveDep(ref.module, dep);
      if (resolved) visit(resolved);
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const ref of nodes) visit(ref);
  return diagnostics;
}

/** Module-level circular import detection (DFS, reporting import cycle). */
function detectModuleCycles(graph: ApplicationGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const moduleMap = new Map<string, ModuleNode>(graph.modules.map((m) => [m.name, m]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (name: string): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart), name];
      const cycleKey = [...cycle].sort().join("|");
      if (!reported.has(cycleKey)) {
        reported.add(cycleKey);
        const mod = moduleMap.get(name);
        diagnostics.push({
          severity: "error",
          code: "circular-module-import",
          message: `Module circular import detected: ${cycle.join(" -> ")}`,
          file: mod?.file,
          line: mod?.line,
        });
      }
      return;
    }

    state.set(name, "visiting");
    stack.push(name);
    const mod = moduleMap.get(name);
    if (mod) {
      for (const importName of mod.imports) {
        if (moduleMap.has(importName)) {
          visit(importName);
        }
      }
    }
    stack.pop();
    state.set(name, "done");
  };

  for (const mod of graph.modules) {
    visit(mod.name);
  }
  return diagnostics;
}

/** Detects modules declared in the application that are unreachable from root modules. */
function detectOrphanModules(graph: ApplicationGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const rootModules = graph.modules.filter(
    (m) =>
      (m.tags && (m.tags.includes("type:root") || m.tags.includes("type:app"))) ||
      m.name === "app" ||
      m.name === "root",
  );
  if (rootModules.length === 0) return diagnostics;

  const reachable = new Set<string>();
  const moduleMap = new Map<string, ModuleNode>(graph.modules.map((m) => [m.name, m]));
  const queue: string[] = rootModules.map((m) => m.name);
  for (const root of rootModules) {
    reachable.add(root.name);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const mod = moduleMap.get(current);
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (!reachable.has(imp)) {
        reachable.add(imp);
        queue.push(imp);
      }
    }
  }

  for (const mod of graph.modules) {
    if (!reachable.has(mod.name)) {
      diagnostics.push({
        severity: "warn",
        code: "orphan-module",
        message: `Module '${mod.name}' is declared but not reachable from any root module (${rootModules.map((r) => r.name).join(", ")})`,
        file: mod.file,
        line: mod.line,
      });
    }
  }
  return diagnostics;
}
