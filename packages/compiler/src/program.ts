import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "@supacloud/db/typescript";
import { compileTraits, type TraitCompilation, type TraitRecord } from "./traits";

export interface IncrementalProgramSession extends AsyncDisposable {
  getProgram(): ts.Program;
  getTypeChecker(): ts.TypeChecker;
  update(rootNames: string[], changedPaths?: string[]): Promise<ProgramUpdate>;
  getTraits(): readonly TraitRecord[];
  getDiagnostics(): Promise<readonly ts.Diagnostic[]>;
  emit(): Promise<ts.EmitOutput>;
  reset(): Promise<void>;
}
export interface ProgramUpdate { changedFiles: string[]; reusedFiles: string[]; program: ts.Program; }

/** Retains native snapshots without Node-only synchronous transport or TS 6 objects. */
export function createIncrementalProgramSession(projectRoot: string): IncrementalProgramSession {
  const rootDir = resolve(projectRoot);
  let api: ts.API | undefined;
  let snapshot: ts.Snapshot | undefined;
  let program: ts.Program | undefined;
  let traits: TraitCompilation | undefined;
  let configuration = "";
  let errors: readonly ts.Diagnostic[] = [];
  let versions = new Map<string, string>();
  const emitted = new Map<string, string>();
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => {});
    return result;
  };
  async function release(): Promise<void> {
    const oldSnapshot = snapshot;
    const oldApi = api;
    snapshot = undefined; api = undefined; program = undefined; traits = undefined;
    versions.clear(); emitted.clear(); configuration = ""; errors = [];
    try { await oldSnapshot?.dispose(); } finally { await oldApi?.close(); }
  }
  const session: IncrementalProgramSession = {
    getProgram() {
      if (!program) throw new Error("incremental TypeScript program has not been initialized");
      return program;
    },
    getTypeChecker() { return session.getProgram().getTypeChecker(); },
    update(rootNames, changedPaths = rootNames) {
      return serialize(async () => {
        api ??= new ts.API({ cwd: rootDir });
        const configPath = join(rootDir, "tsconfig.json");
        const config = existsSync(configPath) ? await api.parseConfigFile(configPath) : {
          options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler, experimentalDecorators: true,
            allowJs: false, skipLibCheck: true }, errors: [], projectReferences: undefined,
        };
        const roots = [...new Set(rootNames.map(path => resolve(rootDir, path)))].sort();
        const nextConfiguration = JSON.stringify([roots, config.options, config.projectReferences, config.errors]);
        const configChanged = configuration !== nextConfiguration;
        const changed = new Set(changedPaths.map(path => resolve(rootDir, path)));
        for (const [path, previous] of versions) if (version(path) !== previous) changed.add(path);
        const previousSnapshot = snapshot;
        let next: ts.Snapshot;
        if (!snapshot || configChanged) {
          next = await api.createSnapshot({ createPrograms: [{ rootFiles: roots, compilerOptions: config.options,
            options: { projectReferences: config.projectReferences, configFileParsingDiagnostics: config.errors } }] });
        } else {
          const notifications: ts.FileNotifications = { changed: [], created: [], deleted: [] };
          for (const path of changed) {
            if (!existsSync(path)) notifications.deleted!.push(path);
            else if (!versions.has(path)) notifications.created!.push(path);
            else notifications.changed!.push(path);
          }
          next = await snapshot.update({ fileNotifications: notifications, ensurePrograms: [session.getProgram().native.id] });
        }
        try {
          const native = configChanged || !program ? next.operation.createdPrograms?.[0]
            : next.getProgram(program.native.id);
          if (!native) throw new Error("Updated TypeScript program is missing");
          const loaded = await ts.Program.load(native, api);
          const changedFiles: string[] = [];
          const reusedFiles: string[] = [];
          const nextVersions = new Map<string, string>();
          for (const source of loaded.getSourceFiles()) {
            const hash = digest(source.text);
            nextVersions.set(source.fileName, hash);
            if (source.isDeclarationFile) continue;
            if (!configChanged && versions.get(source.fileName) === hash) reusedFiles.push(source.fileName);
            else changedFiles.push(source.fileName);
          }
          for (const source of program?.getSourceFiles() ?? []) {
            if (!source.isDeclarationFile && !nextVersions.has(source.fileName)) changedFiles.push(source.fileName);
          }
          const nextTraits = compileTraits(loaded, configChanged ? undefined : traits, new Set(changedFiles));
          snapshot = next; program = loaded; versions = nextVersions; traits = nextTraits;
          configuration = nextConfiguration; errors = ts.diagnostics(config.errors);
          if (configChanged) emitted.clear();
          return { changedFiles, reusedFiles, program: loaded };
        } catch (error) { await next.dispose(); throw error; }
        finally { if (snapshot === next) await previousSnapshot?.dispose(); }
      });
    },
    getTraits() { return traits?.all ?? []; },
    getDiagnostics() { return serialize(async () => [...errors, ...(program ? await program.getSyntacticDiagnostics() : [])]); },
    emit() {
      return serialize(async () => {
        const result = await session.getProgram().native.emitToString();
        if (!result.emitSkipped) {
          for (const [fileName, file] of result.outputFiles) {
            const hash = digest(file.text);
            if (emitted.get(fileName) === hash) continue;
            mkdirSync(dirname(fileName), { recursive: true });
            writeFileSync(fileName, file.text);
            emitted.set(fileName, hash);
          }
        }
        return result;
      });
    },
    reset() { return serialize(release); },
    async [Symbol.asyncDispose]() { return (await session.reset()); },
  };
  return session;
}
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function version(path: string): string {
  try { return digest(readFileSync(path, "utf8")); } catch { return "missing"; }
}
