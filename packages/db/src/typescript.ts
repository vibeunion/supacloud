/** Shared development tooling backed exclusively by the TypeScript 7 asynchronous API. */
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { API, type Program as NativeProgram, type Snapshot, type Diagnostic as NativeDiagnostic,
  type RawCompilerOptions, type ProjectReference, type TranspileOptions,
  type Symbol as NativeSymbol, type ParsedCommandLine as NativeParsedCommandLine } from "typescript/async";
import { createFileSystemLayer, serverFS, type FileSystemCallbacks } from "typescript/fs";
import { isDecorator, type SourceFile, type Node, type Declaration } from "typescript/ast";
import { forEachChild } from "./typescript-source.ts";
export * from "typescript/ast";
export * from "typescript/async";
export * as factory from "typescript/ast/factory";
export { createFileSystemLayer, createFileSystemWithLib } from "typescript/fs";
export type { Checker as TypeChecker, RawCompilerOptions as CompilerOptions } from "typescript/async";

export interface Diagnostic {
  category: number;
  code: number;
  messageText: string;
  start: number;
  file?: { fileName: string; getLineAndCharacterOfPosition(position: number): { line: number; character: number } };
  native: NativeDiagnostic;
}

export function diagnosticMessage(diagnostic: NativeDiagnostic): string {
  return [diagnostic.text, ...(diagnostic.messageChain ?? []).map(diagnosticMessage)].join("\n");
}
export function diagnostics(items: readonly NativeDiagnostic[]): Diagnostic[] {
  return items.map(native => ({
    native, category: native.category, code: native.code, messageText: diagnosticMessage(native), start: native.pos,
    ...(native.fileName ? { file: { fileName: native.fileName,
      getLineAndCharacterOfPosition: (position: number) => {
        if (position === native.pos && native.startPosition) return native.startPosition;
        const lines = (sys.readFile(native.fileName!) ?? "").slice(0, position).split(/\r\n|\r|\n/);
        return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
      } } } : {}),
  }));
}
export function flattenDiagnosticMessageText(text: string, _newline = "\n"): string { return text; }

/** A program owns its API process unless it belongs to an incremental session. */
export class Program implements AsyncDisposable {
  readonly native: NativeProgram;
  readonly api: API;
  private readonly sources: Map<string, SourceFile>;
  private readonly owned: boolean;
  private readonly snapshot: Snapshot | undefined;
  private constructor(native: NativeProgram, api: API,
    sources: Map<string, SourceFile>, owned: boolean, snapshot?: Snapshot) {
    this.native = native;
    this.api = api;
    this.sources = sources;
    this.owned = owned;
    this.snapshot = snapshot;
  }
  static async load(native: NativeProgram, api: API, owned = false, snapshot?: Snapshot): Promise<Program> {
    const sources = new Map<string, SourceFile>();
    // Let the native client batch independent AST requests into one RPC round trip.
    const loaded = await Promise.all((await native.getSourceFileNames()).map(async path =>
      [path, await native.getSourceFile(path)] as const));
    for (const [path, source] of loaded) {
      if (source) sources.set(resolve(path), source);
    }
    return new Program(native, api, sources, owned, snapshot);
  }
  getSourceFiles(): SourceFile[] { return [...this.sources.values()]; }
  getSourceFile(path: string): SourceFile | undefined { return this.sources.get(resolve(path)); }
  getTypeChecker() { return this.native.getProject().checker; }
  getCompilerOptions() { return this.native.getCompilerOptions(); }
  async getSyntacticDiagnostics(file?: SourceFile) { return diagnostics(await this.native.getSyntacticDiagnostics(file?.fileName)); }
  async getSemanticDiagnostics(file?: SourceFile) { return diagnostics(await this.native.getSemanticDiagnostics(file?.fileName)); }
  async getGlobalDiagnostics() { return diagnostics(await this.native.getGlobalDiagnostics()); }
  async getOptionsDiagnostics() { return diagnostics(await this.native.getProgramDiagnostics()); }
  async emit() { return this.native.emit(); }
  async emitToString() { return this.native.emitToString(); }
  async resolveModuleName(name: string, containingFile: string) {
    await using resolver = await this.api.createModuleResolver(this.getCompilerOptions());
    return await resolver.resolveModuleName(name, dirname(containingFile));
  }
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.owned) {
      try { await this.native.dispose(); }
      finally { try { await this.snapshot?.dispose(); } finally { await this.api.close(); } }
    }
  }
}
export interface ProgramInputs {
  cwd?: string;
  sources?: ReadonlyMap<string, string>;
  projectReferences?: readonly ProjectReference[];
}
export async function createProgram(rootNames: readonly string[], options: RawCompilerOptions, inputs: ProgramInputs = {}): Promise<Program> {
  const api = new API({ cwd: inputs.cwd ?? process.cwd() });
  try {
    if (inputs.sources) {
      const snapshot = await api.createSnapshot({ fileSystem: createFileSystemLayer([...inputs.sources]),
        createPrograms: [{ rootFiles: rootNames, compilerOptions: options,
          options: { projectReferences: inputs.projectReferences } }] });
      return await Program.load(snapshot.operation.createdPrograms[0], api, true, snapshot);
    }
    return await Program.load(await api.createProgram(rootNames, options, { projectReferences: inputs.projectReferences }), api, true);
  } catch (error) { await api.close(); throw error; }
}
export async function getPreEmitDiagnostics(program: Program): Promise<Diagnostic[]> {
  return [...await program.getGlobalDiagnostics(), ...await program.getOptionsDiagnostics(),
    ...await program.getSyntacticDiagnostics(), ...await program.getSemanticDiagnostics()];
}

export { createSourceFile } from "./typescript-source.ts";
export async function declarationsOf(symbol: NativeSymbol | undefined): Promise<Declaration[]> {
  const result: Declaration[] = [];
  for (const handle of symbol?.declarations ?? []) {
    const declaration = await handle.resolve();
    if (declaration) result.push(declaration);
  }
  return result;
}
export async function valueDeclarationOf(symbol: NativeSymbol): Promise<Declaration | undefined> {
  return await symbol.valueDeclaration?.resolve() ?? (await declarationsOf(symbol))[0];
}
export async function forEachChildAsync(node: Node, visit: (child: Node) => Promise<void>): Promise<void> {
  const children: Node[] = [];
  forEachChild(node, child => { children.push(child); });
  for (const child of children) await visit(child);
}

export const sys = {
  useCaseSensitiveFileNames: process.platform !== "win32" && process.platform !== "darwin",
  getCurrentDirectory: () => process.cwd(),
  fileExists: (path: string) => { try { return statSync(path).isFile(); } catch { return false; } },
  readFile: (path: string): string | undefined => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  readDirectory(rootDir: string, extensions?: readonly string[], excludes: readonly string[] = [], includes: readonly string[] = ["**/*"]): string[] {
    const patterns = includes.map(pattern => /[*?]|\.[^/]+$/.test(pattern) ? pattern : `${pattern}/**/*`);
    const excluded = excludes.map(pattern => isAbsolute(pattern) ? relative(rootDir, pattern) : pattern)
      .flatMap(pattern => /[*?]|\.[^/]+$/.test(pattern) ? [pattern] : [pattern, `${pattern}/**/*`, `**/${pattern}/**/*`]);
    const paths = globSync(patterns, { cwd: rootDir, exclude: excluded });
    return [...new Set(paths.map(path => resolve(rootDir, path)))].filter(path => sys.fileExists(path)
      && (!extensions || extensions.some(extension => path.endsWith(extension)))).sort();
  },
};
export function findConfigFile(root: string, fileExists = sys.fileExists): string | undefined {
  let current = resolve(root);
  for (;;) {
    const path = join(current, "tsconfig.json");
    if (fileExists(path)) return path;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
interface ConfigHost { readFile?: (path: string) => string | undefined; getCurrentDirectory?: () => string;
  onUnRecoverableConfigFileDiagnostic?: (diagnostic: Diagnostic) => void; }
function configAPI(host: ConfigHost): API {
  const fs: FileSystemCallbacks = { directoryExists: serverFS.useOS, fileExists: serverFS.useOS,
    getAccessibleEntries: serverFS.useOS, readFile: host.readFile ?? serverFS.useOS,
    realpath: serverFS.useOS, stat: serverFS.useOS, writeFile: serverFS.useOS, removeFile: serverFS.useOS };
  return new API({ cwd: host.getCurrentDirectory?.() ?? process.cwd(), fs });
}
export async function readConfigFile(path: string, readFile = sys.readFile) {
  await using api = configAPI({ readFile });
  const result = await api.readConfigFile(path);
  return { config: result.config, error: result.error ? diagnostics([result.error])[0] : undefined };
}
export type ParsedProjectConfig = Omit<NativeParsedCommandLine, "errors" | "options"> & {
  errors: Diagnostic[];
  options: RawCompilerOptions;
};
export async function parseJsonConfigFileContent(config: unknown, host: ConfigHost, rootDir: string): Promise<ParsedProjectConfig> {
  await using api = configAPI(host);
  const parsed = await api.parseJsonConfigFileContent(config, { configDirectory: rootDir });
  return { ...parsed, errors: diagnostics(parsed.errors) };
}
export async function getParsedCommandLineOfConfigFile(path: string, options: RawCompilerOptions, host: ConfigHost): Promise<ParsedProjectConfig> {
  await using api = configAPI(host);
  const parsed = await api.parseConfigFile(path);
  return { ...parsed, options: { ...parsed.options, ...options }, errors: diagnostics(parsed.errors) };
}
export async function transpileModule(source: string, options: TranspileOptions) {
  await using api = new API();
  const result = await api.transpileModule(source, options);
  return { ...result, diagnostics: result.diagnostics ? diagnostics(result.diagnostics) : undefined };
}
export async function transpileDeclaration(source: string, options: TranspileOptions) {
  await using api = new API();
  const result = await api.transpileDeclaration(source, options);
  return { ...result, diagnostics: result.diagnostics ? diagnostics(result.diagnostics) : undefined };
}
export async function printNode(node: Node): Promise<string> {
  await using api = new API();
  return await api.printer.printNode(node);
}

export { forEachChild } from "./typescript-source.ts";

export function canHaveDecorators(node: Node): node is Node & { modifiers?: readonly import("typescript/ast").ModifierLike[] } {
  return "modifiers" in node;
}
export function getDecorators(node: Node): readonly import("typescript/ast").Decorator[] | undefined {
  return canHaveDecorators(node) ? node.modifiers?.filter(isDecorator) : undefined;
}
export async function asyncMap<T, U>(items: readonly T[], visit: (item: T, index: number) => U | Promise<U>): Promise<U[]> {
  const result: U[] = [];
  for (const [index, item] of items.entries()) result.push(await visit(item, index));
  return result;
}
export async function asyncSome<T>(items: readonly T[], visit: (item: T, index: number) => unknown): Promise<boolean> {
  for (const [index, item] of items.entries()) if (await visit(item, index)) return true;
  return false;
}
export async function asyncEvery<T>(items: readonly T[], visit: (item: T, index: number) => unknown): Promise<boolean> {
  for (const [index, item] of items.entries()) if (!await visit(item, index)) return false;
  return true;
}
export async function asyncFilter<T>(items: readonly T[], visit: (item: T, index: number) => unknown): Promise<T[]> {
  const result: T[] = [];
  for (const [index, item] of items.entries()) if (await visit(item, index)) result.push(item);
  return result;
}
export async function asyncForEach<T>(items: readonly T[], visit: (item: T, index: number) => unknown): Promise<void> {
  for (const [index, item] of items.entries()) await visit(item, index);
}
export async function asyncReduce<T, U>(items: readonly T[], visit: (result: U, item: T, index: number) => U | Promise<U>, initial: U): Promise<U> {
  let result = initial;
  for (const [index, item] of items.entries()) result = await visit(result, item, index);
  return result;
}
export async function asyncFlatMap<T, U>(items: readonly T[], visit: (item: T, index: number) => readonly U[] | Promise<readonly U[]>): Promise<U[]> {
  return (await asyncMap(items, visit)).flat();
}
