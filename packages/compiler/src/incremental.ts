import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { compileProject } from "./compile";
import type {
  CompileOptions,
  CompileResult,
  CompileStats,
  DependencyGraphCache,
  ModuleNode,
} from "./types";

export interface IncrementalCompileResult extends CompileResult {
  stats: CompileStats;
}

export interface IncrementalCompiler {
  compile(options: CompileOptions, changedPaths?: string[]): Promise<IncrementalCompileResult>;
  reset(): void;
  getCache?(): DependencyGraphCache;
}

export function createDependencyGraphCache(): DependencyGraphCache {
  return {
    modules: new Map(),
    fileHashes: new Map(),
  };
}

interface Snapshot {
  files: Record<string, string>;
  optionsKey: string;
}

/** Keeps a process-local source snapshot and reuses the last result on cache hits. */
export function createIncrementalCompiler(): IncrementalCompiler {
  let previousSnapshot: Snapshot | undefined;
  let previousResult: CompileResult | undefined;
  const cache: DependencyGraphCache = createDependencyGraphCache();

  return {
    async compile(options, changedPaths): Promise<IncrementalCompileResult> {
      const snapshot = changedPaths && previousSnapshot
        ? await updateSnapshot(previousSnapshot, options, changedPaths)
        : await createSnapshot(options);
      const changedFiles = changedPaths && previousSnapshot
        ? diffFiles(previousSnapshot.files, snapshot.files)
        : diffFiles(previousSnapshot?.files, snapshot.files);
      const cacheHit = Boolean(previousSnapshot && previousSnapshot.optionsKey === snapshot.optionsKey && changedFiles.length === 0);

      if (cacheHit && previousResult) {
        return {
          ...previousResult,
          stats: {
            cacheHit: true,
            changedFiles: [],
            affectedModules: [],
            reusedModules: previousResult.graph.modules.map((m) => m.name),
            reanalyzedModules: [],
          },
        };
      }

      if (previousResult && previousSnapshot && changedFiles.length > 0 && !(await requiresGraphRebuild(options.rootDir, changedFiles))) {
        const stats: CompileStats = {
          cacheHit: true,
          changedFiles,
          affectedModules: findAffectedModules(previousResult.graph.modules, previousResult.graph.modules, changedFiles),
          reusedModules: previousResult.graph.modules.map((m) => m.name),
          reanalyzedModules: [],
        };
        previousSnapshot = snapshot;
        return { ...previousResult, written: [], stats };
      }

      const activeCache = options.cache ?? cache;
      if (!activeCache.dependencyGraph && previousResult) {
        activeCache.dependencyGraph = new ModuleDependencyGraph(previousResult.graph.modules);
      }
      const result = await compileProject({ ...options, cache: activeCache });
      const affectedModules = previousResult
        ? findAffectedModules(previousResult.graph.modules, result.graph.modules, changedFiles)
        : result.graph.modules.map((module) => module.name);
      const reusedModules = result.graph.cacheStats?.reusedModules ?? [];
      const reanalyzedModules = result.graph.cacheStats?.reanalyzedModules ?? affectedModules;
      if (activeCache) {
        activeCache.dependencyGraph = new ModuleDependencyGraph(result.graph.modules);
      }
      const stats: CompileStats = {
        cacheHit: false,
        changedFiles,
        affectedModules,
        reusedModules,
        reanalyzedModules,
      };
      previousSnapshot = snapshot;
      previousResult = result;
      return { ...result, stats };
    },
    reset(): void {
      previousSnapshot = undefined;
      previousResult = undefined;
      cache.modules.clear();
      cache.fileHashes.clear();
      cache.dependencyGraph = undefined;
    },
    getCache(): DependencyGraphCache {
      return cache;
    },
  };
}

async function updateSnapshot(previous: Snapshot, options: CompileOptions, changedPaths: string[]): Promise<Snapshot> {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const files = { ...previous.files };
  for (const changedPath of changedPaths) {
    const absolutePath = resolve(rootDir, changedPath);
    if (absolutePath === outDir || absolutePath.startsWith(`${outDir}/`)) continue;
    const relativePath = relative(rootDir, absolutePath).split(sep).join("/");
    try {
      await access(absolutePath);
      const content = await readFile(absolutePath);
      files[relativePath] = createHash("sha256").update(content).digest("hex");
    } catch {
      delete files[relativePath];
    }
  }
  return { files, optionsKey: optionsKeyOf(options) };
}

async function createSnapshot(options: CompileOptions): Promise<Snapshot> {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const paths = await listSourceFiles(rootDir, outDir);
  const files: Record<string, string> = {};
  for (const path of paths) {
    const content = await readFile(path);
    files[relative(rootDir, path).split(sep).join("/")] = createHash("sha256").update(content).digest("hex");
  }
  return { files, optionsKey: optionsKeyOf(options) };
}

function optionsKeyOf(options: CompileOptions): string {
  return JSON.stringify({
    include: options.include,
    strict: options.strict,
    moduleBoundaryPreset: options.moduleBoundaryPreset,
    moduleBoundaries: options.moduleBoundaries,
    allowRouteCommandBindings: options.allowRouteCommandBindings,
    commandCapabilities: options.commandCapabilities,
    disallowControllerDirectDb: options.disallowControllerDirectDb,
    detectOrphanModules: options.detectOrphanModules,
    generateClient: options.generateClient,
    generatePermissions: options.generatePermissions,
  });
}

async function requiresGraphRebuild(rootDir: string, changedFiles: string[]): Promise<boolean> {
  for (const relativePath of changedFiles) {
    const path = resolve(rootDir, relativePath);
    try {
      const source = await readFile(path, "utf8");
      if (/@(?:Module|Injectable|Inject|Controller|Command|Query)\b|new\s+InjectionToken\b|\bdefineModule\s*\(/.test(source)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function listSourceFiles(rootDir: string, outDir: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || path === outDir) continue;
        await visit(path);
      } else if (/\.(tsx?|mts|cts)$/.test(entry.name)) {
        result.push(path);
      }
    }
  };
  await visit(rootDir);
  return result.sort();
}

function diffFiles(previous: Record<string, string> | undefined, current: Record<string, string>): string[] {
  if (!previous) return Object.keys(current);
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...names].filter((name) => previous[name] !== current[name]).sort();
}

/**
 * Angular Ivy-inspired module dependency graph.
 * Tracks forward module imports, reverse dependent relationships, and file ownership
 * to compute precise affected module subgraphs during incremental compilation.
 */
export class ModuleDependencyGraph {
  private readonly imports = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly fileOwners = new Map<string, Set<string>>();
  private readonly moduleMap = new Map<string, ModuleNode>();

  constructor(modules: ModuleNode[] = []) {
    this.rebuild(modules);
  }

  rebuild(modules: ModuleNode[]): void {
    this.imports.clear();
    this.dependents.clear();
    this.fileOwners.clear();
    this.moduleMap.clear();

    for (const mod of modules) {
      this.moduleMap.set(mod.name, mod);
      this.imports.set(mod.name, new Set(mod.imports));
      if (!this.dependents.has(mod.name)) {
        this.dependents.set(mod.name, new Set());
      }
      this.indexFile(mod.file, mod.name);
      for (const p of mod.providers) {
        if (p.importPath) this.indexFile(p.importPath, mod.name);
        if (p.file) this.indexFile(p.file, mod.name);
      }
      for (const c of mod.controllers) {
        if (c.importPath) this.indexFile(c.importPath, mod.name);
        if (c.file) this.indexFile(c.file, mod.name);
      }
    }

    for (const [modName, imps] of this.imports.entries()) {
      for (const imp of imps) {
        if (!this.dependents.has(imp)) {
          this.dependents.set(imp, new Set());
        }
        this.dependents.get(imp)!.add(modName);
      }
    }
  }

  private indexFile(path: string | undefined, moduleName: string): void {
    if (!path) return;
    const normalized = path.replace(/\.(tsx?|mts|cts)$/, "");
    if (!this.fileOwners.has(normalized)) {
      this.fileOwners.set(normalized, new Set());
    }
    this.fileOwners.get(normalized)!.add(moduleName);
  }

  getModulesOwningFile(filePath: string): string[] {
    const normalized = filePath.replace(/\.(tsx?|mts|cts)$/, "");
    return Array.from(this.fileOwners.get(normalized) ?? []);
  }

  getAffectedModules(changedFiles: string[]): string[] {
    if (changedFiles.length === 0) return [];
    const directlyAffected = new Set<string>();
    for (const file of changedFiles) {
      for (const modName of this.getModulesOwningFile(file)) {
        directlyAffected.add(modName);
      }
    }
    if (directlyAffected.size === 0) {
      return Array.from(this.moduleMap.keys());
    }

    const affected = new Set(directlyAffected);
    const queue = Array.from(directlyAffected);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = this.dependents.get(current);
      if (dependents) {
        for (const dep of dependents) {
          if (!affected.has(dep)) {
            affected.add(dep);
            queue.push(dep);
          }
        }
      }
    }
    return Array.from(this.moduleMap.keys()).filter((name) => affected.has(name));
  }

  getDirectImports(moduleName: string): string[] {
    return Array.from(this.imports.get(moduleName) ?? []);
  }

  getDirectDependents(moduleName: string): string[] {
    return Array.from(this.dependents.get(moduleName) ?? []);
  }
}

function findAffectedModules(previous: ModuleNode[], current: ModuleNode[], changedFiles: string[]): string[] {
  const depGraph = new ModuleDependencyGraph(current);
  return depGraph.getAffectedModules(changedFiles);
}
