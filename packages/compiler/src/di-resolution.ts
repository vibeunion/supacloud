import type { ApplicationGraph, ControllerNode, Diagnostic, ModuleNode, ProviderNode, Scope } from "./types";
import { isJobContextToken, isRequestContextToken } from "./util";

export interface DependencyFlags { self?: boolean; skipSelf?: boolean }
export interface StaticProvider { module: ModuleNode; provider: ProviderNode }
export type DependencyResolution =
  | { kind: "provider"; relation: "local" | "imported" | "root"; target: StaticProvider }
  | { kind: "context"; scope: "request" | "job" }
  | { kind: "external" }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: StaticProvider[] };

export function dependencyFlags(
  owner: Pick<ProviderNode | ControllerNode, "dependencyOptions" | "optionalDeps" | "selfDeps" | "skipSelfDeps" | "hostDeps">,
  token: string, index = 0,
): { optional: boolean; self: boolean; skipSelf: boolean; host: boolean } {
  const parameter = owner.dependencyOptions?.[index];
  return parameter ? { optional: parameter.optional === true, self: parameter.self === true, skipSelf: parameter.skipSelf === true, host: parameter.host === true }
    : { optional: owner.optionalDeps?.includes(token) === true, self: owner.selfDeps?.includes(token) === true,
        skipSelf: owner.skipSelfDeps?.includes(token) === true, host: owner.hostDeps?.includes(token) === true };
}

function uniqueProviders(providers: StaticProvider[]): StaticProvider[] {
  return [...new Map(providers.map(item => [`${item.module.name}:${item.provider.token}`, item])).values()];
}

/** Follow only explicit public exports; a diamond preserves the original instance. */
export function exportedProviders(graph: ApplicationGraph, module: ModuleNode, token: string, seen = new Set<string>()): StaticProvider[] {
  if (seen.has(module.name)) return [];
  const ancestry = new Set(seen).add(module.name);
  const direct = module.exports.includes(token);
  const own = direct ? module.providers.find(provider => provider.token === token) : undefined;
  if (own) return [{ module, provider: own }];
  return uniqueProviders(module.imports.flatMap(name => {
    const imported = graph.modules.find(candidate => candidate.name === name);
    return imported && (direct || module.exports.includes(imported.name) || module.exports.includes(imported.className))
      ? exportedProviders(graph, imported, token, ancestry) : [];
  }));
}

/** One compile-time resolution rule for validation, generated factories and manifests. */
export function resolveDependency(
  graph: ApplicationGraph, module: ModuleNode, token: string, scope: Scope = "application", flags: DependencyFlags = {},
): DependencyResolution {
  if (flags.self && flags.skipSelf) return { kind: "missing" };
  const contextScope = isRequestContextToken(token, graph.tokenNames) ? "request"
    : isJobContextToken(token, graph.tokenNames) ? "job" : undefined;
  if (contextScope) return flags.skipSelf ? { kind: "missing" } : { kind: "context", scope: contextScope };
  const own = module.providers.find(provider => provider.token === token);
  if (own && (!flags.self || own.scope === scope) && (!flags.skipSelf || (scope !== "application" && own.scope === "application"))) {
    return { kind: "provider", relation: "local", target: { module, provider: own } };
  }
  if (flags.self) return { kind: "missing" };
  const imported = uniqueProviders(module.imports.flatMap(name => {
    const dependency = graph.modules.find(candidate => candidate.name === name);
    return dependency ? exportedProviders(graph, dependency, token) : [];
  }));
  if (imported.length > 1) return { kind: "ambiguous", candidates: imported };
  if (imported[0]) return { kind: "provider", relation: "imported", target: imported[0] };
  const roots = uniqueProviders(graph.modules.flatMap(candidate => candidate.providers
    .filter(provider => provider.token === token && provider.providedIn === "root"
      && !(flags.skipSelf && scope === "application" && candidate === module))
    .map(provider => ({ module: candidate, provider }))));
  if (roots.length > 1) return { kind: "ambiguous", candidates: roots };
  if (roots[0]) return { kind: "provider", relation: "root", target: roots[0] };
  return graph.externalTokens.includes(token) ? { kind: "external" } : { kind: "missing" };
}

/** Includes implicit root dependencies required before a module factory can run. */
export function moduleDependencies(graph: ApplicationGraph, module: ModuleNode): string[] {
  const dependencies = new Set(module.imports);
  for (const owner of [...module.providers, ...module.controllers].filter(item => item.scope === "application")) {
    for (const [index, token] of owner.deps.entries()) {
      const resolution = resolveDependency(graph, module, token, owner.scope, dependencyFlags(owner, token, index));
      if (resolution.kind === "provider" && resolution.target.module !== module) dependencies.add(resolution.target.module.name);
    }
  }
  return [...dependencies];
}

export function scopeCanDependOn(owner: Scope, dependency: Scope): boolean {
  return dependency === "application" || owner === dependency;
}

const blockingCodes = new Set([
  "runtime-injection-disallowed", "command-executor-bypass", "circular-dependency", "circular-existing-alias",
  "circular-module-import", "scope-violation", "module-boundary", "module-boundary-violation", "duplicate-token", "duplicate-module",
  "unresolved-token", "missing-deps", "provider-type-mismatch", "unsupported-provider-helper", "missing-token-factory", "unresolved-alias-target", "self-dependency-violation", "skip-self-dependency-violation", "export-unprovided-token", "self-referencing-alias",
  "ambiguous-dependency", "conflicting-injection-flags", "cross-module-scoped-dependency", "mixed-multi-provider-scopes",
  "dynamic-aspect-reference", "invalid-aspect-reference", "aspect-operation-mismatch",
]);
/** Invalid static wiring never becomes an executable artifact, including writeOnError. */
export function blocksStaticCompilation(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === "error" && blockingCodes.has(diagnostic.code);
}
