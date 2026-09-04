import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { compileProject } from "./compile";
import type { CompileOptions, CompileResult, CompileStats, ModuleNode } from "./types";

export interface IncrementalCompileResult extends CompileResult {
  stats: CompileStats;
}

export interface IncrementalCompiler {
  compile(options: CompileOptions, changedPaths?: string[]): Promise<IncrementalCompileResult>;
  reset(): void;
}

interface Snapshot {
  files: Record<string, string>;
  optionsKey: string;
}

/** Keeps a process-local source snapshot and reuses the last result on cache hits. */
export function createIncrementalCompiler(): IncrementalCompiler {
  let previousSnapshot: Snapshot | undefined;
  let previousResult: CompileResult | undefined;

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
          stats: { cacheHit: true, changedFiles: [], affectedModules: [] },
        };
      }

      if (previousResult && previousSnapshot && changedFiles.length > 0 && !(await requiresGraphRebuild(options.rootDir, changedFiles))) {
        const stats: CompileStats = {
          cacheHit: true,
          changedFiles,
          affectedModules: findAffectedModules(previousResult.graph.modules, previousResult.graph.modules, changedFiles),
        };
        previousSnapshot = snapshot;
        return { ...previousResult, written: [], stats };
      }

      const result = await compileProject(options);
      const affectedModules = previousResult
        ? findAffectedModules(previousResult.graph.modules, result.graph.modules, changedFiles)
        : result.graph.modules.map((module) => module.name);
      const stats: CompileStats = { cacheHit: false, changedFiles, affectedModules };
      previousSnapshot = snapshot;
      previousResult = result;
      return { ...result, stats };
    },
    reset(): void {
      previousSnapshot = undefined;
      previousResult = undefined;
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

function findAffectedModules(previous: ModuleNode[], current: ModuleNode[], changedFiles: string[]): string[] {
  if (changedFiles.length === 0) return [];
  const changedSet = new Set(changedFiles);
  const matchesChanged = (path: string | undefined): boolean => {
    if (!path) return false;
    const normalized = path.replace(/\.(tsx?|mts|cts)$/, "");
    return [...changedSet].some((file) => file.replace(/\.(tsx?|mts|cts)$/, "") === normalized);
  };
  const affected = new Set<string>();
  const markIfOwned = (module: ModuleNode): void => {
    const ownsChangedFile = [
      module.file,
      ...module.providers.map((provider) => provider.importPath),
      ...module.controllers.map((controller) => controller.importPath),
    ].some((path) => matchesChanged(path));
    if (ownsChangedFile) affected.add(module.name);
  };
  for (const module of current) markIfOwned(module);
  if (affected.size === 0) return current.map((module) => module.name);

  const modules = new Map(current.map((module) => [module.name, module]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules.values()) {
      if (module.imports.some((dependency) => affected.has(dependency)) && !affected.has(module.name)) {
        affected.add(module.name);
        changed = true;
      }
    }
  }
  return current.filter((module) => affected.has(module.name)).map((module) => module.name);
}
