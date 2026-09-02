import type {
  ApplicationGraph,
  ControllerNode,
  Diagnostic,
  ModuleNode,
  ProviderNode,
  Scope,
} from "./types";

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
 * 校验 ApplicationGraph，产出诊断列表。
 * strict 时 warn 级诊断升级为 error。
 */
export function validateGraph(graph: ApplicationGraph, strict = false): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 全局 token → provider 索引（同模块重复注册由 duplicate-token 报告，索引取第一个）。
  const globalProviders = new Map<string, ProviderRef>();
  for (const module of graph.modules) {
    for (const provider of module.providers) {
      if (!globalProviders.has(provider.token)) {
        globalProviders.set(provider.token, { module, provider });
      }
    }
  }

  /** 在 module 的可见域内解析 dep token：本模块 providers > imports 模块的 exports。 */
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

  for (const module of graph.modules) {
    // duplicate-token：同一 token 在同模块重复注册。
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

    // scope-violation / 模块边界：检查每个 provider 的 deps。
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
        // controller 属 request 不受此限（它可依赖 application）。
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

    // command-missing-permission。
    for (const command of module.commands) {
      if (!command.permission) {
        warn(
          "command-missing-permission",
          `模块 ${module.name} 的 command ${command.name} (${command.className}) 未声明 permission`,
          module.file,
          module.line,
        );
      }
    }
  }

  diagnostics.push(...detectCycles(graph, resolveDep));
  return diagnostics;
}

/** provider 级循环依赖检测（DFS，报环路径）。 */
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
