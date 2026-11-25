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

interface IncrementalProgramSessionOptions {
  /** Server current directory. Defaults to the project root. */
  cwd?: string;
  /**
   * Compiler options used instead of tsconfig.json. The production type gate
   * passes the options it already merged so project settings cannot weaken it.
   */
  compilerOptions?: ts.CompilerOptions;
}

/** Retains native snapshots without Node-only synchronous transport or TS 6 objects. */
export function createIncrementalProgramSession(projectRoot: string): IncrementalProgramSession {
  return openIncrementalProgramSession(projectRoot);
}

function openIncrementalProgramSession(
  projectRoot: string,
  sessionOptions: IncrementalProgramSessionOptions = {},
): IncrementalProgramSession {
  const rootDir = resolve(projectRoot);
  const cwd = resolve(sessionOptions.cwd ?? rootDir);
  const fixedOptions = sessionOptions.compilerOptions
    ? canonicalizeOptions(sessionOptions.compilerOptions)
    : undefined;
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
    // Omitted hints still notice edits: loaded files are hashed below.
    // Marking every root changed would drop the retained library ASTs.
    update(rootNames, changedPaths = []) {
      return serialize(async () => {
        api ??= new ts.API({ cwd });
        const configPath = join(rootDir, "tsconfig.json");
        const config = fixedOptions
          ? { options: fixedOptions, errors: [], projectReferences: undefined }
          : existsSync(configPath) ? await api.parseConfigFile(configPath) : {
            options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
              moduleResolution: ts.ModuleResolutionKind.Bundler, experimentalDecorators: true,
              allowJs: false, skipLibCheck: true }, errors: [], projectReferences: undefined,
          };
        const options = canonicalizeOptions(config.options);
        const roots = [...new Set(rootNames.map(path => resolve(rootDir, path)))].sort();
        const nextConfiguration = JSON.stringify([roots, options, config.projectReferences, config.errors]);
        const configChanged = configuration !== nextConfiguration;
        const changed = new Set(changedPaths.map(path => resolve(rootDir, path)));
        for (const [path, previous] of versions) if (version(path) !== previous) changed.add(path);
        const previousSnapshot = snapshot;
        let next: ts.Snapshot;
        if (!snapshot || configChanged) {
          next = await api.createSnapshot({ createPrograms: [{ rootFiles: roots, compilerOptions: options,
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

/**
 * Analysis and the production type gate each need their own program, because the
 * gate forces strict options. A new server for every compile copies lib.dom.d.ts
 * again, and that transfer stalls the 10s CI timeout. Keep those two servers and
 * close the oldest when a different project or option set needs the slot.
 */
const retainedSessions = new Map<string, IncrementalProgramSession>();
const RETAINED_SESSION_LIMIT = 2;

export async function acquireIncrementalProgramSession(
  projectRoot: string,
  identity: string,
  options?: IncrementalProgramSessionOptions,
): Promise<IncrementalProgramSession> {
  const root = resolve(projectRoot);
  const cwd = resolve(options?.cwd ?? root);
  const optionKey = options?.compilerOptions ? stableOptionsKey(options.compilerOptions) : "";
  const key = `${root}\0${cwd}\0${identity}\0${optionKey}`;
  const retained = retainedSessions.get(key);
  if (retained) {
    retainedSessions.delete(key);
    retainedSessions.set(key, retained);
    return retained;
  }
  while (retainedSessions.size >= RETAINED_SESSION_LIMIT) {
    const oldest = retainedSessions.keys().next().value;
    if (oldest === undefined) break;
    const session = retainedSessions.get(oldest);
    retainedSessions.delete(oldest);
    await session?.reset();
  }
  const session = openIncrementalProgramSession(root, { ...options, cwd });
  retainedSessions.set(key, session);
  return session;
}

function stableOptionsKey(options: ts.CompilerOptions): string {
  return JSON.stringify(canonicalizeOptions(options));
}
function canonicalizeOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return canonicalize(options) as ts.CompilerOptions;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) result[key] = canonicalize(source[key]);
  }
  return result;
}
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function version(path: string): string {
  try { return digest(readFileSync(path, "utf8")); } catch { return "missing"; }
}
