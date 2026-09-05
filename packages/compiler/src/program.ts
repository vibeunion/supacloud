import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { compileTraits, type TraitCompilation, type TraitRecord } from "./traits";

export interface IncrementalProgramSession {
  /** The current TypeScript program used as the semantic compilation boundary. */
  getProgram(): ts.Program;
  /** The current TypeScript type checker. */
  getTypeChecker(): ts.TypeChecker;
  /** Update the program while preserving TypeScript's incremental state. */
  update(rootNames: string[], changedPaths?: string[]): ProgramUpdate;
  /** Local Angular-style metadata records compiled from the current Program. */
  getTraits(): readonly TraitRecord[];
  /** TypeScript syntactic diagnostics for the current Program. */
  getDiagnostics(): readonly ts.Diagnostic[];
  /** Emit the current TypeScript program using the builder's incremental state. */
  emit(): ts.EmitResult;
  /** Drop the retained builder and source versions. */
  reset(): void;
}

export interface ProgramUpdate {
  changedFiles: string[];
  reusedFiles: string[];
  program: ts.Program;
}

interface ProjectConfig {
  options: ts.CompilerOptions;
  errors: readonly ts.Diagnostic[];
  projectReferences?: readonly ts.ProjectReference[];
  configFingerprint: string;
}

interface CachedSourceFile {
  sourceFile: ts.SourceFile;
  version: string;
  parseKey: string;
}

/**
 * Angular-style semantic boundary around TypeScript's incremental program.
 *
 * This deliberately owns only TypeScript program state. SupaCloud metadata
 * handlers and ApplicationGraph linking remain separate layers.
 */
export function createIncrementalProgramSession(projectRoot: string): IncrementalProgramSession {
  const rootDir = resolve(projectRoot);
  let projectConfig = readProjectConfig(rootDir);
  let projectConfigKey = configKey(projectConfig);
  let builder: ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
  let traits: TraitCompilation | undefined;
  const sourceFileCache = new Map<string, CachedSourceFile>();

  return {
    getProgram(): ts.Program {
      if (!builder) {
        throw new Error("incremental TypeScript program has not been initialized");
      }
      return builder.getProgram();
    },

    getTypeChecker(): ts.TypeChecker {
      return this.getProgram().getTypeChecker();
    },

    update(rootNames, changedPaths = rootNames): ProgramUpdate {
      const oldProgram = builder?.getProgram();
      const oldSourceFiles = new Map(
        oldProgram?.getSourceFiles().map((sourceFile) => [canonical(sourceFile.fileName), sourceFile]) ?? [],
      );

      const nextProjectConfig = readProjectConfig(rootDir);
      const nextProjectConfigKey = configKey(nextProjectConfig);
      const configChanged = nextProjectConfigKey !== projectConfigKey;
      const previousBuilder = configChanged ? undefined : builder;
      if (configChanged) {
        sourceFileCache.clear();
        traits = undefined;
      }
      projectConfig = nextProjectConfig;
      projectConfigKey = nextProjectConfigKey;

      const normalizedRoots = [...new Set(rootNames.map((file) => resolve(rootDir, file)))].sort();
      const normalizedChanged = [...new Set(changedPaths.map((file) => resolve(rootDir, file)))];
      const invalidatedPaths = new Set(normalizedChanged.map(canonical));
      for (const sourceFile of oldSourceFiles.values()) {
        if (sourceVersion(sourceFile.fileName) !== sourceFileVersion(sourceFile)) {
          invalidatedPaths.add(canonical(sourceFile.fileName));
        }
      }
      const invalidateAllResolutions = configChanged || [...invalidatedPaths].some((fileName) => {
        const wasInProgram = oldSourceFiles.has(fileName);
        return wasInProgram !== existsSync(fileName);
      });
      for (const fileName of normalizedChanged) {
        if (!existsSync(fileName)) sourceFileCache.delete(canonical(fileName));
      }

      const host = createHost(
        projectConfig.options,
        rootDir,
        sourceFileCache,
        invalidatedPaths,
        invalidateAllResolutions,
      );
      builder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
        normalizedRoots,
        projectConfig.options,
        host,
        previousBuilder,
        projectConfig.errors,
        projectConfig.projectReferences,
      );

      const program = builder.getProgram();
      const changedFiles: string[] = [];
      const reusedFiles: string[] = [];
      const currentPaths = new Set(program.getSourceFiles().map((file) => canonical(file.fileName)));
      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        const previous = oldSourceFiles.get(canonical(sourceFile.fileName));
        if (previous && previous === sourceFile) {
          reusedFiles.push(sourceFile.fileName);
        } else {
          changedFiles.push(sourceFile.fileName);
        }
      }
      for (const [path, sourceFile] of oldSourceFiles) {
        if (!sourceFile.isDeclarationFile && !currentPaths.has(path)) {
          changedFiles.push(sourceFile.fileName);
        }
      }
      for (const path of sourceFileCache.keys()) {
        if (!currentPaths.has(path)) sourceFileCache.delete(path);
      }

      traits = compileTraits(program, traits, new Set(changedFiles));
      return { changedFiles, reusedFiles, program };
    },

    getTraits(): readonly TraitRecord[] {
      return traits?.all ?? [];
    },

    getDiagnostics(): readonly ts.Diagnostic[] {
      if (!builder) return projectConfig.errors;
      const program = builder.getProgram();
      return [
        ...projectConfig.errors,
        ...program.getSyntacticDiagnostics(),
      ];
    },

    emit(): ts.EmitResult {
      if (!builder) {
        throw new Error("incremental TypeScript program has not been initialized");
      }
      return builder.emit();
    },

    reset(): void {
      builder = undefined;
      projectConfig = readProjectConfig(rootDir);
      projectConfigKey = configKey(projectConfig);
      traits = undefined;
      sourceFileCache.clear();
    },
  };
}

function createHost(
  options: ts.CompilerOptions,
  rootDir: string,
  sourceFileCache: Map<string, CachedSourceFile>,
  invalidatedPaths: Set<string>,
  invalidateAllResolutions: boolean,
): ts.CompilerHost {
  const host = ts.createIncrementalCompilerHost(options, {
    ...ts.sys,
    getCurrentDirectory: () => rootDir,
  });
  host.hasInvalidatedResolutions = (filePath) =>
    invalidateAllResolutions || invalidatedPaths.has(canonical(filePath));
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = canonical(fileName);
    const text = host.readFile(fileName);
    if (text === undefined) {
      sourceFileCache.delete(key);
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }

    const version = hashText(text);
    const parseKey = sourceFileParseKey(languageVersion);
    const cached = sourceFileCache.get(key);
    if (!shouldCreateNewSourceFile && cached?.version === version && cached.parseKey === parseKey) {
      return cached.sourceFile;
    }

    const sourceFile = originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (sourceFile) {
      sourceFileCache.set(key, { sourceFile, version: hashText(sourceFile.text), parseKey });
    } else {
      sourceFileCache.delete(key);
    }
    return sourceFile;
  };
  return host;
}

function canonical(fileName: string): string {
  const normalized = resolve(fileName);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function sourceFileParseKey(
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): string {
  return typeof languageVersion === "number"
    ? `target:${languageVersion}`
    : JSON.stringify({
        languageVersion: languageVersion.languageVersion,
        impliedNodeFormat: languageVersion.impliedNodeFormat,
        jsDocParsingMode: languageVersion.jsDocParsingMode,
      });
}

function configKey(config: ProjectConfig): string {
  return JSON.stringify({
    options: config.options,
    projectReferences: config.projectReferences,
    configFingerprint: config.configFingerprint,
  });
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function sourceVersion(fileName: string): string {
  try {
    return hashText(readFileSync(fileName, "utf8"));
  } catch {
    return "missing";
  }
}

function sourceFileVersion(sourceFile: ts.SourceFile): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(sourceFile, "version");
  return typeof descriptor?.value === "string" ? descriptor.value : undefined;
}

function readProjectConfig(rootDir: string): ProjectConfig {
  const configPath = join(rootDir, "tsconfig.json");
  if (!existsSync(configPath)) {
    return {
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        experimentalDecorators: true,
        allowJs: false,
        skipLibCheck: true,
      },
      errors: [],
      projectReferences: undefined,
      configFingerprint: "defaults",
    };
  }

  const configReads = new Map<string, string>();
  const readConfig = (fileName: string): string | undefined => {
    const text = ts.sys.readFile(fileName);
    configReads.set(canonical(fileName), text === undefined ? "missing" : hashText(text));
    return text;
  };
  const config: ReturnType<typeof ts.readConfigFile> = ts.readConfigFile(
    configPath,
    readConfig,
  );
  if (config.error) {
    return {
      options: {},
      errors: [config.error],
      configFingerprint: JSON.stringify([...configReads]),
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readFile: readConfig },
    dirname(configPath),
  );
  return {
    options: parsed.options,
    errors: parsed.errors,
    projectReferences: parsed.projectReferences,
    configFingerprint: JSON.stringify([...configReads]),
  };
}
