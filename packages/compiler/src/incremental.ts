import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { compileProject } from "./compile";
import { graphqlInputPaths } from "./graphql-inputs";
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
    generatedHashes: new Map(),
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
  let previousCache: DependencyGraphCache | undefined;
  const cache: DependencyGraphCache = createDependencyGraphCache();

  return {
    async compile(options, changedPaths): Promise<IncrementalCompileResult> {
      const optionsKey = optionsKeyOf(options);
      const snapshot = !options.graphql && changedPaths && previousSnapshot && previousSnapshot.optionsKey === optionsKey
        ? await updateSnapshot(previousSnapshot, options, changedPaths)
        : await createSnapshot(options);
      const changedFiles = changedPaths && previousSnapshot
        ? diffFiles(previousSnapshot.files, snapshot.files)
        : diffFiles(previousSnapshot?.files, snapshot.files);
      const activeCache = options.cache ?? cache;
      // Type gates may depend on enclosing configs and imports outside the watched root.
      const cacheHit = Boolean(
        previousSnapshot
        && previousSnapshot.optionsKey === snapshot.optionsKey
        && previousCache === activeCache
        && changedFiles.length === 0,
      ) && !(options.typeSafety?.scanProductionSource ?? options.strict ?? false);

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

      if (!activeCache.dependencyGraph && previousResult) {
        activeCache.dependencyGraph = new ModuleDependencyGraph(previousResult.graph.modules);
      }
      const result = await compileProject({
        ...options,
        cache: activeCache,
        changedPaths: changedFiles,
      });
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
      previousCache = activeCache;
      return { ...result, stats };
    },
    reset(): void {
      previousSnapshot = undefined;
      previousResult = undefined;
      previousCache = undefined;
      cache.modules.clear();
      cache.fileHashes.clear();
      cache.generatedHashes?.clear();
      delete cache.dependencyGraph;
      cache.programSession?.reset();
    },
    getCache(): DependencyGraphCache {
      return cache;
    },
  };
}

async function readSourceBytes(path: string): Promise<Uint8Array | Buffer> {
  if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
    return Bun.file(path).bytes();
  }
  return readFile(path);
}

async function updateSnapshot(previous: Snapshot, options: CompileOptions, changedPaths: string[]): Promise<Snapshot> {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const files = { ...previous.files };
  await Promise.all(
    changedPaths.map(async (changedPath) => {
      const absolutePath = isAbsolute(changedPath) ? resolve(changedPath) : resolve(rootDir, changedPath);
      const relativeChangedPath = relative(rootDir, absolutePath);
      if (relativeChangedPath === ".." || relativeChangedPath.startsWith(`..${sep}`)) return;
      if (absolutePath === outDir || absolutePath.startsWith(`${outDir}/`)) return;
      const relativePath = relative(rootDir, absolutePath).split(sep).join("/");
      try {
        await access(absolutePath);
        const content = await readSourceBytes(absolutePath);
        files[relativePath] = createHash("sha256").update(content).digest("hex");
      } catch {
        delete files[relativePath];
      }
    }),
  );
  return { files, optionsKey: optionsKeyOf(options) };
}

async function createSnapshot(options: CompileOptions): Promise<Snapshot> {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const paths = await listSourceFiles(rootDir, outDir);
  const files: Record<string, string> = {};
  const entries = await Promise.all(
    paths.map(async (path) => {
      const content = await readSourceBytes(path);
      const key = relative(rootDir, path).split(sep).join("/");
      return [key, createHash("sha256").update(content).digest("hex")] as const;
    }),
  );
  for (const [key, hash] of entries) files[key] = hash;
  for (const path of graphqlInputPaths(options)) {
    const key = relative(rootDir, path).split(sep).join("/");
    try {
      const content = await readSourceBytes(path);
      files[key] = createHash("sha256").update(content).digest("hex");
    } catch {
      files[key] = "missing";
    }
  }
  return { files, optionsKey: optionsKeyOf(options) };
}

function optionsKeyOf(options: CompileOptions): string {
  return JSON.stringify({
    rootDir: resolve(options.rootDir),
    outDir: resolve(options.outDir),
    include: options.include,
    strict: options.strict,
    writeOnError: options.writeOnError,
    moduleBoundaryPreset: options.moduleBoundaryPreset,
    moduleBoundaries: options.moduleBoundaries,
    allowRouteCommandBindings: options.allowRouteCommandBindings,
    commandCapabilities: options.commandCapabilities,
    disallowControllerDirectDb: options.disallowControllerDirectDb,
    requireRouteContracts: options.requireRouteContracts,
    detectOrphanModules: options.detectOrphanModules,
    generateClient: options.generateClient,
    generatePermissions: options.generatePermissions,
    typeSafety: options.typeSafety,
    treeShakeUnusedProviders: options.treeShakeUnusedProviders,
    graphql: options.graphql,
  });
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
        const dependents = this.dependents.get(imp);
        if (dependents) dependents.add(modName);
      }
    }
  }

  private indexFile(path: string | undefined, moduleName: string): void {
    if (!path) return;
    const normalized = path.replace(/\.(tsx?|mts|cts)$/, "");
    if (!this.fileOwners.has(normalized)) {
      this.fileOwners.set(normalized, new Set());
    }
    const owners = this.fileOwners.get(normalized);
    if (owners) owners.add(moduleName);
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
      // An unrelated source file is not a graph dependency. Shared semantic
      // files are indexed by their provider/controller import paths above;
      // unknown files therefore remain outside the module closure.
      return [];
    }

    const affected = new Set(directlyAffected);
    const queue = Array.from(directlyAffected);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (!current) continue;
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
