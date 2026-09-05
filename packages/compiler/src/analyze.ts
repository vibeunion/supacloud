import { createHash } from "node:crypto";
import { relative, resolve as resolvePath, sep } from "node:path";
import * as ts from "@typescript/typescript6";
import { createIncrementalProgramSession } from "./program";
import type {
  ApplicationGraph,
  CachedModuleEntry,
  CommandNode,
  ControllerNode,
  DependencyGraphCache,
  Diagnostic,
  HandlerParamNode,
  FunctionalInjectNode,
  ModuleNode,
  ProviderNode,
  QueryNode,
  RouteNode,
  Scope,
  TokenKind,
} from "./types";

const DEFAULT_INCLUDE = ["**/*.module.ts", "**/*.ts"];
const ROUTE_DECORATORS: Record<string, RouteNode["method"]> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
};
const SCOPES: Scope[] = ["application", "request", "job"];

function isScope(value: string): value is Scope {
  return SCOPES.some((scope) => scope === value);
}

interface TokenInfo {
  /** Variable name, e.g. CASE_REPOSITORY. */
  name: string;
  /** InjectionToken string name, e.g. "supacloud.case-repository". */
  stringName?: string;
  scope?: Scope;
  providedIn?: "root";
  hasFactory?: boolean;
  file: string;
  line?: number;
}

type AstNode = ts.Node;
type CallExpression = ts.CallExpression;
type ClassDeclaration = ts.ClassDeclaration;
type Decorator = ts.Decorator;
type Expression = ts.Expression;
type Identifier = ts.Identifier;
type ObjectLiteralExpression = ts.ObjectLiteralExpression;
type ParameterDeclaration = ts.ParameterDeclaration;
type SourceFile = ts.SourceFile;
type TsSymbol = ts.Symbol;
type VariableDeclaration = ts.VariableDeclaration;

interface ClassInfo {
  name: string;
  decl: ClassDeclaration;
  file: string;
}

/** Analysis context: project-wide symbol index + diagnostics collection. */
interface AnalysisContext {
  rootDir: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  tokensByName: Map<string, TokenInfo>;
  classesByName: Map<string, ClassInfo>;
  diagnostics: Diagnostic[];
}

function nodeText(node: ts.Node): string {
  return node.getText(node.getSourceFile());
}

function lineOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function variableName(decl: ts.VariableDeclaration): string {
  return ts.isIdentifier(decl.name) ? decl.name.text : nodeText(decl.name);
}

function propertyName(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return nodeText(name);
}

function parameterName(param: ts.ParameterDeclaration): string {
  return ts.isIdentifier(param.name) ? param.name.text : nodeText(param.name);
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function decoratorArguments(dec: ts.Decorator): readonly ts.Expression[] {
  return ts.isCallExpression(dec.expression) ? dec.expression.arguments : [];
}

function hasMethod(cls: ts.ClassDeclaration, name: string): boolean {
  return cls.members.some((member) =>
    (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
    member.name !== undefined &&
    propertyName(member.name) === name,
  );
}

function hasDestroyHook(cls: ts.ClassDeclaration): boolean {
  return hasMethod(cls, "onDestroy") || hasMethod(cls, "ngOnDestroy");
}

function descendantsOfKind<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

/**
 * Analyzes source code under rootDir via the native TypeScript Program API.
 * Decorators are matched by name only (Module/Injectable/Inject/Command/Query/Controller/Get/...),
 * without checking import origins, so this package does not need to depend on @supacloud/app.
 */
export async function analyzeProject(
  rootDir: string,
  include?: string[],
  cache?: DependencyGraphCache,
  changedPaths?: string[],
): Promise<ApplicationGraph> {
  const session = cache?.programSession ?? createIncrementalProgramSession(rootDir);
  if (cache) cache.programSession = session;
  const rootNames = ts.sys.readDirectory(
    rootDir,
    [".ts", ".tsx"],
    ["node_modules", "dist"],
    include ?? DEFAULT_INCLUDE,
  );
  const update = session.update(rootNames, changedPaths);
  const program = update.program;
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles()
    .filter((sf) =>
      !sf.isDeclarationFile &&
      !sf.fileName.includes("/node_modules/") &&
      !sf.fileName.includes("/dist/") &&
      isProjectSourceFile(sf, rootDir),
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName));

  const ctx: AnalysisContext = {
    rootDir,
    program,
    checker,
    tokensByName: new Map(),
    classesByName: new Map(),
    diagnostics: [],
  };
  const nativeTraitFiles = new Map<string, Set<string>>();
  for (const diagnostic of session.getDiagnostics()) {
    ctx.diagnostics.push(toCompilerDiagnostic(diagnostic, rootDir));
  }
  for (const trait of session.getTraits()) {
    const kinds = nativeTraitFiles.get(trait.file) ?? new Set<string>();
    kinds.add(trait.kind);
    nativeTraitFiles.set(trait.file, kinds);
  }
  for (const sf of sourceFiles) {
    indexFile(sf, ctx);
  }

  // First pass: Discover all module candidates (@Module class / defineModule calls), register names first
  // so that imports can resolve module class references to module names.
  interface ModuleCandidate {
    node: ClassDeclaration | VariableDeclaration;
    options: ObjectLiteralExpression;
    className: string;
    file: string;
    line: number;
  }
  const candidates: ModuleCandidate[] = [];
  for (const sf of sourceFiles) {
    const traits = nativeTraitFiles.get(sf.fileName);
    if (!cache || traits?.has("module")) {
      for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
        const moduleDec = findDecorator(cls, "Module");
        if (!moduleDec) continue;
        const options = decoratorObjectArg(moduleDec);
        if (!options) continue;
        candidates.push({
          node: cls,
          options,
          className: cls.name?.text ?? "<anonymous>",
          file: sf.fileName,
          line: lineOf(cls),
        });
      }
    }
    if (!cache || traits?.has("defineModule")) {
      for (const call of descendantsOfKind<CallExpression>(sf, ts.isCallExpression)) {
        if (nodeText(call.expression) !== "defineModule") continue;
        const parent = call.parent;
        if (!parent || !ts.isVariableDeclaration(parent)) continue;
        const arg = call.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
        candidates.push({
          node: parent,
          options: arg,
          className: variableName(parent),
          file: sf.fileName,
          line: lineOf(parent),
        });
      }
    }
  }
  const nameByNode = new Map<AstNode, string>();
  for (const c of candidates) {
    nameByNode.set(c.node, stringLiteralProp(c.options, "name") ?? c.className);
  }

  let modules: ModuleNode[] = [];
  let reusedModules: string[] = [];
  let reanalyzedModules: string[] = [];

  if (cache) {
    const currentFileHashes = new Map<string, string>();
    for (const sf of sourceFiles) {
      const rel = sourcePath(rootDir, sf.fileName);
      const hash = createHash("sha256").update(sf.getFullText()).digest("hex");
      currentFileHashes.set(rel, hash);
    }

    const changedFiles = new Set<string>();
    for (const [file, hash] of currentFileHashes.entries()) {
      if (cache.fileHashes.get(file) !== hash) {
        changedFiles.add(file);
      }
    }
    for (const file of cache.fileHashes.keys()) {
      if (!currentFileHashes.has(file)) {
        changedFiles.add(file);
      }
    }

    const modulesToKeep = new Map<string, CachedModuleEntry>();
    const finalModules: ModuleNode[] = [];
    const finalDiagnostics: Diagnostic[] = [...ctx.diagnostics];
    const affectedModuleNames = (cache.dependencyGraph && typeof cache.dependencyGraph.getAffectedModules === "function")
      ? new Set<string>(cache.dependencyGraph.getAffectedModules(Array.from(changedFiles)))
      : new Set<string>();

    for (const [modName, entry] of cache.modules.entries()) {
      const hasChangedFile = entry.ownedFiles.some((f) => changedFiles.has(f));
      const moduleFileExists = currentFileHashes.has(entry.module.file);
      const isAffectedByDep = affectedModuleNames.has(modName);
      if (!hasChangedFile && !isAffectedByDep && moduleFileExists) {
        modulesToKeep.set(modName, entry);
        reusedModules.push(modName);
        finalModules.push(entry.module);
        if (entry.diagnostics) finalDiagnostics.push(...entry.diagnostics);
      }
    }

    for (const c of candidates) {
      const modName = nameByNode.get(c.node) ?? c.className;
      if (modulesToKeep.has(modName)) {
        continue;
      }
      const diagBefore = ctx.diagnostics.length;
      const parsed = parseModule(c, nameByNode, ctx);
      const moduleDiagnostics = ctx.diagnostics.slice(diagBefore);

      const ownedFiles = collectModuleSourceClosure(parsed, ctx);

      const fileHashes: Record<string, string> = {};
      for (const f of ownedFiles) {
        fileHashes[f] = currentFileHashes.get(f) ?? "";
      }

      cache.modules.set(parsed.name, {
        module: parsed,
        ownedFiles: [...ownedFiles],
        fileHashes,
        diagnostics: moduleDiagnostics,
      });
      reanalyzedModules.push(parsed.name);
      finalModules.push(parsed);
      finalDiagnostics.push(...moduleDiagnostics);
    }

    for (const modName of [...cache.modules.keys()]) {
      if (!modulesToKeep.has(modName) && !reanalyzedModules.includes(modName)) {
        cache.modules.delete(modName);
      }
    }

    cache.fileHashes = currentFileHashes;
    cache.lastStats = { reusedModules, reanalyzedModules };
    ctx.diagnostics = finalDiagnostics;
    modules = finalModules;
  } else {
    modules = candidates.map((c) => parseModule(c, nameByNode, ctx));
  }
  modules.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Auto-collect standalone @Injectable({ providedIn: 'root' }) services
  // standalone @Controller({ standalone: true }) controllers,
  // and standalone @Command({ standalone: true }) commands.
  const allRegisteredClasses = new Set<string>();
  const allRegisteredControllers = new Set<string>();
  const allRegisteredCommands = new Set<string>();
  for (const m of modules) {
    for (const p of m.providers) {
      if (p.useClass) allRegisteredClasses.add(p.useClass);
      if (p.kind === "class") allRegisteredClasses.add(p.token);
    }
    for (const c of m.controllers) {
      allRegisteredControllers.add(c.className);
    }
    for (const cmd of m.commands) {
      allRegisteredCommands.add(cmd.className);
    }
  }
  const rootProviders: ProviderNode[] = [];
  const standaloneControllers: ControllerNode[] = [];
  const standaloneCommands: CommandNode[] = [];

  for (const [name, classInfo] of ctx.classesByName.entries()) {
    if (!allRegisteredClasses.has(name)) {
      const injectable = parseInjectableOptions(classInfo.decl, ctx);
      if (injectable?.providedIn === "root") {
        const { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, functionalInjects, missing } = classDeps(classInfo.decl, ctx);
        const file = sourcePath(ctx.rootDir, classInfo.file);
        const line = lineOf(classInfo.decl);
        if (missing) {
          warn(ctx, "missing-deps", `root provider ${name} 的部分构造依赖无法静态解析`, file, line);
        }
        rootProviders.push({
          token: name,
          tokenKind: "class",
          kind: "class",
          useClass: name,
          scope: injectable.scope ?? "application",
          deps,
          optionalDeps: optionalDeps.length > 0 ? optionalDeps : undefined,
          selfDeps: selfDeps.length > 0 ? selfDeps : undefined,
          skipSelfDeps: skipSelfDeps.length > 0 ? skipSelfDeps : undefined,
          hostDeps: hostDeps.length > 0 ? hostDeps : undefined,
          functionalInjects: functionalInjects.length > 0 ? functionalInjects : undefined,
          providedIn: "root",
          hasOnDestroy: hasDestroyHook(classInfo.decl) || undefined,
          exported: true,
          file,
          line,
          importPath: modulePath(ctx.rootDir, classInfo.file),
        });
      }
    }

    if (!allRegisteredControllers.has(name)) {
      const controllerDec = findDecorator(classInfo.decl, "Controller");
      if (controllerDec) {
        const arg = decoratorArguments(controllerDec)[0];
        const isStandalone = arg && ts.isObjectLiteralExpression(arg) && booleanProp(arg, "standalone");
        if (isStandalone) {
          const ctrl = parseController(classInfo.decl, ctx);
          if (ctrl) standaloneControllers.push(ctrl);
        }
      }
    }

    if (!allRegisteredCommands.has(name)) {
      const commandDec = findDecorator(classInfo.decl, "Command");
      if (commandDec) {
        const meta = decoratorObjectArg(commandDec);
        if (meta && booleanProp(meta, "standalone")) {
          standaloneCommands.push({
            className: classInfo.decl.name?.text ?? name,
            name: stringLiteralProp(meta, "name") ?? classInfo.decl.name?.text ?? name,
            permission: stringLiteralProp(meta, "permission"),
            transaction: commandModeProp(meta, "transaction") ?? "none",
            audit: stringLiteralProp(meta, "audit"),
            idempotency: commandModeProp(meta, "idempotency") ?? "none",
            standalone: true,
          });
        }
      }
    }
  }

  for (const [name, tokenInfo] of ctx.tokensByName.entries()) {
    if (tokenInfo.providedIn === "root" && !allRegisteredClasses.has(name)) {
      rootProviders.push({
        token: name,
        tokenKind: "injection-token",
        kind: "factory",
        scope: tokenInfo.scope ?? "application",
        deps: [],
        providedIn: "root",
        exported: true,
        file: sourcePath(ctx.rootDir, tokenInfo.file),
        line: tokenInfo.line ?? 1,
        importPath: modulePath(ctx.rootDir, tokenInfo.file),
      });
    }
  }

  if (rootProviders.length > 0 || standaloneControllers.length > 0 || standaloneCommands.length > 0) {
    const existingRoot = modules.find((m) => m.name === "root" || m.name === "app");
    if (existingRoot) {
      modules = modules.map((module) => module === existingRoot ? {
        ...module,
        providers: [...module.providers, ...rootProviders],
        controllers: [...module.controllers, ...standaloneControllers],
        commands: [...module.commands, ...standaloneCommands],
        exports: [...new Set([...module.exports, ...rootProviders.map((provider) => provider.token)])],
      } : module);
    } else {
      const fallbackFile = rootProviders[0]?.file ?? standaloneControllers[0]?.file ?? "root.ts";
      modules.unshift({
        name: "root",
        className: "RootModule",
        file: fallbackFile,
        line: 1,
        imports: [],
        providers: rootProviders,
        controllers: standaloneControllers,
        commands: standaloneCommands,
        queries: [],
        exports: rootProviders.map((p) => p.token),
      });
    }
  }

  const providedTokens = new Set(
    modules.flatMap((m) => m.providers.map((p) => p.token)),
  );
  const referenced = new Set<string>();
  for (const m of modules) {
    for (const p of m.providers) p.deps.forEach((d) => referenced.add(d));
    for (const c of m.controllers) c.deps.forEach((d) => referenced.add(d));
  }
  const externalTokens = [...referenced]
    .filter((token) => !providedTokens.has(token))
    .sort();

  const tokenNames: Record<string, string> = {};
  for (const info of ctx.tokensByName.values()) {
    if (info.stringName) tokenNames[info.name] = info.stringName;
  }

  return {
    modules,
    externalTokens,
    diagnostics: ctx.diagnostics,
    tokenNames,
    cacheStats: cache ? { reusedModules, reanalyzedModules } : undefined,
  };
}

/**
 * A module's semantic inputs include imported tokens, schemas, factories, and
 * transitive local imports, not only the declaration files of its providers.
 * Keeping this closure in the cache prevents shared source edits from being
 * incorrectly treated as cache hits.
 */
function collectModuleSourceClosure(module: ModuleNode, ctx: AnalysisContext): Set<string> {
  const seeds = new Set<string>();
  const addRelativeModule = (path: string | undefined): void => {
    if (!path) return;
    const withExtension = /\.(tsx?|mts|cts|js)$/.test(path) ? path : `${path}.ts`;
    seeds.add(resolveSourcePath(ctx.rootDir, withExtension));
  };

  addRelativeModule(module.file);
  for (const provider of module.providers) addRelativeModule(provider.importPath);
  for (const controller of module.controllers) addRelativeModule(controller.importPath);

  const ownedFiles = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (!fileName) continue;
    const sourceFile = ctx.program.getSourceFile(fileName);
    if (!sourceFile || sourceFile.isDeclarationFile || !isProjectSourceFile(sourceFile, ctx.rootDir)) continue;
    const relativeFile = sourcePath(ctx.rootDir, sourceFile.fileName);
    if (ownedFiles.has(relativeFile)) continue;
    ownedFiles.add(relativeFile);

    for (const statement of sourceFile.statements) {
      let moduleName: string | undefined;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        moduleName = statement.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        moduleName = statement.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(statement)
        && ts.isExternalModuleReference(statement.moduleReference)
        && ts.isStringLiteral(statement.moduleReference.expression)) {
        moduleName = statement.moduleReference.expression.text;
      }
      if (!moduleName || moduleName.startsWith("node:")) continue;
      const resolved = ts.resolveModuleName(
        moduleName,
        sourceFile.fileName,
        ctx.program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (resolved && isProjectSourcePath(resolved, ctx.rootDir)) queue.push(resolved);
    }
  }
  return ownedFiles;
}

function resolveSourcePath(rootDir: string, file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return resolvePath(rootDir, normalized);
}

function isProjectSourcePath(fileName: string, rootDir: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === root || normalized.startsWith(`${root}/`);
}

function isProjectSourceFile(sourceFile: SourceFile, rootDir: string): boolean {
  return isProjectSourcePath(sourceFile.fileName, rootDir)
    && /\.(tsx?|mts|cts)$/.test(sourceFile.fileName);
}

/** Indexes InjectionToken variables and class declarations in the file. */
function indexFile(sf: SourceFile, ctx: AnalysisContext): void {
  for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
    const name = cls.name?.text;
    if (name && !ctx.classesByName.has(name)) {
      ctx.classesByName.set(name, { name, decl: cls, file: sf.fileName });
    }
  }
  for (const statement of sf.statements.filter(ts.isVariableStatement)) {
    for (const decl of statement.declarationList.declarations) {
      const info = parseTokenVariable(decl, sf.fileName);
      if (info && !ctx.tokensByName.has(info.name)) {
        ctx.tokensByName.set(info.name, info);
      }
    }
  }
}

/** Parses `const X = new InjectionToken("name", { scope })` variable declaration. */
function parseTokenVariable(decl: VariableDeclaration, file: string): TokenInfo | undefined {
  const init = decl.initializer;
  if (!init || !ts.isNewExpression(init)) return undefined;
  if (nodeText(init.expression) !== "InjectionToken") return undefined;
  const [nameArg, optionsArg] = init.arguments ?? [];
  const info: TokenInfo = { name: variableName(decl), file, line: lineOf(decl) };
  if (nameArg && ts.isStringLiteral(nameArg)) {
    info.stringName = nameArg.text;
  }
  if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
    const scope = stringLiteralProp(optionsArg, "scope");
    if (scope && isScope(scope)) {
      info.scope = scope;
    }
    const providedIn = stringLiteralProp(optionsArg, "providedIn");
    if (providedIn === "root") {
      info.providedIn = "root";
    }
    const factory = getProp(optionsArg, "factory");
    if (factory) {
      info.hasFactory = true;
    }
  }
  return info;
}

function parseModule(
  candidate: { node: AstNode; options: ObjectLiteralExpression; className: string; file: string; line: number },
  nameByNode: Map<AstNode, string>,
  ctx: AnalysisContext,
): ModuleNode {
  const { options, className, file, line } = candidate;
  const name = nameByNode.get(candidate.node) ?? className;

  const tags = arrayProp(options, "tags")
    .map((el) => (ts.isStringLiteral(el) ? el.text : nodeText(el).replace(/['"]/g, "")))
    .filter(Boolean);

  const imports = arrayProp(options, "imports")
    .map((el) => {
      const unwrapped = unwrapForwardRef(el);
      const decl = ts.isIdentifier(unwrapped) ? resolveDeclaration(unwrapped, ctx)[0] : undefined;
      if (decl) {
        const known = nameByNode.get(decl);
        if (known) return known;
        if (ts.isClassDeclaration(decl)) {
          const dec = findDecorator(decl, "Module");
          const decOptions = dec && decoratorObjectArg(dec);
          const decName = decOptions && stringLiteralProp(decOptions, "name");
          return decName ?? decl.name?.text ?? nodeText(el);
        }
        if (ts.isVariableDeclaration(decl)) return variableName(decl);
      }
      return nodeText(el);
    })
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const exports = arrayProp(options, "exports").map((el) => tokenNameOf(el, ctx).name);
  const exportsSet = new Set(exports);

  const providers: ProviderNode[] = [];
  for (const el of expandProviderExpressions(arrayProp(options, "providers"), ctx)) {
    const parsedProviders = parseFunctionalProvider(el, exportsSet, ctx);
    if (parsedProviders) {
      providers.push(...parsedProviders);
      continue;
    }
    if (ts.isCallExpression(el)) {
      const helper = nodeText(el.expression).split(".").pop() ?? nodeText(el.expression);
      warn(
        ctx,
        "unsupported-provider-helper",
        `无法静态展开 provider helper '${helper}'；请改用显式 Provider 或实现编译器支持的 helper`,
        sourcePath(ctx.rootDir, el.getSourceFile().fileName),
        lineOf(el),
      );
      continue;
    }
    const provider = parseProvider(el, exportsSet, ctx);
    if (provider) providers.push(provider);
  }

  const controllers: ControllerNode[] = [];
  for (const el of arrayProp(options, "controllers")) {
    const controller = parseController(el, ctx);
    if (controller) controllers.push(controller);
  }

  // @Command/@Query: providers (bare class or useClass) + decorated classes in commands/queries array.
  const handlerClasses: ClassDeclaration[] = [];
  const seenHandlers = new Set<string>();
  const collectHandler = (expr: Expression) => {
    if (!ts.isIdentifier(expr)) return;
    const decl = resolveDeclaration(expr, ctx)[0];
    if (decl && ts.isClassDeclaration(decl) && !seenHandlers.has(decl.name?.text ?? "")) {
      seenHandlers.add(decl.name?.text ?? "");
      handlerClasses.push(decl);
    }
  };
  for (const el of arrayProp(options, "providers")) {
    if (ts.isIdentifier(el)) collectHandler(el);
    if (ts.isObjectLiteralExpression(el)) {
      const useClass = getProp(el, "useClass");
      if (useClass) collectHandler(useClass);
    }
  }
  arrayProp(options, "commands").forEach(collectHandler);
  arrayProp(options, "queries").forEach(collectHandler);

  const commands: CommandNode[] = [];
  const queries: QueryNode[] = [];
  for (const cls of handlerClasses) {
    const commandDec = findDecorator(cls, "Command");
    if (commandDec) {
      const meta = decoratorObjectArg(commandDec);
      if (meta) {
        commands.push({
          className: cls.name?.text ?? "<anonymous>",
          name: stringLiteralProp(meta, "name") ?? cls.name?.text ?? "<anonymous>",
          permission: stringLiteralProp(meta, "permission"),
          transaction: commandModeProp(meta, "transaction") ?? "none",
          audit: stringLiteralProp(meta, "audit"),
          idempotency: commandModeProp(meta, "idempotency") ?? "none",
          standalone: booleanProp(meta, "standalone") || undefined,
        });
      }
    }
    const queryDec = findDecorator(cls, "Query");
    if (queryDec) {
      const meta = decoratorObjectArg(queryDec);
      if (meta) {
        queries.push({
          className: cls.name?.text ?? "<anonymous>",
          name: stringLiteralProp(meta, "name") ?? cls.name?.text ?? "<anonymous>",
        });
      }
    }
  }

  return {
    name,
    className,
    tags: tags.length > 0 ? tags : undefined,
    file: sourcePath(ctx.rootDir, file),
    line,
    imports,
    providers,
    controllers,
    commands,
    queries,
    exports,
  };
}

function commandModeProp(
  object: ObjectLiteralExpression,
  name: string,
): "required" | "none" | undefined {
  const value = stringLiteralProp(object, name);
  return value === "required" || value === "none" ? value : undefined;
}

function parseProvider(
  el: Expression,
  exportsSet: Set<string>,
  ctx: AnalysisContext,
): ProviderNode | undefined {
  const file = sourcePath(ctx.rootDir, el.getSourceFile().fileName);
  const line = lineOf(el);

  const unwrappedEl = unwrapForwardRef(el);
  // Bare class reference -> class provider, token = class name
  if (ts.isIdentifier(unwrappedEl)) {
    const decl = resolveDeclaration(unwrappedEl, ctx)[0];
    const cls = decl && ts.isClassDeclaration(decl) ? decl : undefined;
    const className = cls?.name?.text ?? unwrappedEl.text;
    const { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, functionalInjects, missing } = cls
      ? classDeps(cls, ctx)
      : { deps: [], optionalDeps: [], selfDeps: [], skipSelfDeps: [], hostDeps: [], functionalInjects: [], missing: false };
    const injectable = cls ? parseInjectableOptions(cls, ctx) : undefined;
    if (missing) {
      warn(ctx, "missing-deps", `provider ${className} 的部分构造依赖无法静态解析`, file, line);
    }
    return {
      token: className,
      tokenKind: "class",
      kind: "class",
      useClass: className,
      scope: resolveScope({ cls, tokenName: className }, ctx),
      deps,
      optionalDeps: optionalDeps.length > 0 ? optionalDeps : undefined,
      selfDeps: selfDeps.length > 0 ? selfDeps : undefined,
      skipSelfDeps: skipSelfDeps.length > 0 ? skipSelfDeps : undefined,
      hostDeps: hostDeps.length > 0 ? hostDeps : undefined,
      functionalInjects: functionalInjects.length > 0 ? functionalInjects : undefined,
      providedIn: injectable?.providedIn,
      hasOnDestroy: cls ? hasDestroyHook(cls) || undefined : undefined,
      exported: exportsSet.has(className),
      file,
      line,
      importPath: cls ? modulePath(ctx.rootDir, cls.getSourceFile().fileName) : undefined,
    };
  }

  if (!ts.isObjectLiteralExpression(el)) return undefined;
  const provideExpr = getProp(el, "provide");
  if (!provideExpr) return undefined;
  const { name: token, kind: tokenKind } = tokenNameOf(provideExpr, ctx);
  const explicitScope = parseScopeProp(el);
  const explicitDeps = arrayProp(el, "deps").map((d) => tokenNameOf(d, ctx).name);
  const multi = booleanProp(el, "multi");

  const useClassExpr = getProp(el, "useClass");
  const useValueExpr = getProp(el, "useValue");
  const useFactoryExpr = getProp(el, "useFactory");
  const useExistingExpr = getProp(el, "useExisting");

  if (useClassExpr) {
    const unwrappedClass = unwrapForwardRef(useClassExpr);
    const decl = ts.isIdentifier(unwrappedClass) ? resolveDeclaration(unwrappedClass, ctx)[0] : undefined;
    const cls = decl && ts.isClassDeclaration(decl) ? decl : undefined;
    const useClass = cls?.name?.text ?? nodeText(unwrappedClass);
    let deps = explicitDeps;
    let optionalDeps: string[] = [];
    let selfDeps: string[] = [];
    let skipSelfDeps: string[] = [];
    let hostDeps: string[] = [];
    let functionalInjects: FunctionalInjectNode[] = [];
    if (cls) {
      const result = classDeps(cls, ctx);
      if (deps.length === 0) {
        deps = result.deps;
        optionalDeps = result.optionalDeps;
        selfDeps = result.selfDeps;
        skipSelfDeps = result.skipSelfDeps;
        hostDeps = result.hostDeps;
      } else {
        optionalDeps = result.optionalDeps.filter((dep) => deps.includes(dep));
        selfDeps = result.selfDeps.filter((dep) => deps.includes(dep));
        skipSelfDeps = result.skipSelfDeps.filter((dep) => deps.includes(dep));
        hostDeps = result.hostDeps.filter((dep) => deps.includes(dep));
      }
      functionalInjects = result.functionalInjects;
      if (result.missing) {
        warn(ctx, "missing-deps", `provider ${token} (useClass ${useClass}) 的部分构造依赖无法静态解析`, file, line);
      }
    }
    const injectable = cls ? parseInjectableOptions(cls, ctx) : undefined;
    validateProviderCompatibility(provideExpr, useClassExpr, "class", token, ctx, file, line);
    return {
      token,
      tokenKind,
      kind: "class",
      useClass,
      scope: resolveScope({ explicit: explicitScope, cls, tokenName: token }, ctx),
      deps,
      optionalDeps: optionalDeps.length > 0 ? optionalDeps : undefined,
      selfDeps: selfDeps.length > 0 ? selfDeps : undefined,
      skipSelfDeps: skipSelfDeps.length > 0 ? skipSelfDeps : undefined,
      hostDeps: hostDeps.length > 0 ? hostDeps : undefined,
      functionalInjects: functionalInjects.length > 0 ? functionalInjects : undefined,
      multi: multi ?? undefined,
      providedIn: injectable?.providedIn,
      hasOnDestroy: cls ? hasMethod(cls, "onDestroy") || undefined : undefined,
      exported: exportsSet.has(token),
      file,
      line,
      importPath: cls ? modulePath(ctx.rootDir, cls.getSourceFile().fileName) : undefined,
    };
  }

  if (useValueExpr) {
    validateProviderCompatibility(provideExpr, useValueExpr, "value", token, ctx, file, line);
    return {
      token,
      tokenKind,
      kind: "value",
      useValueExpr: nodeText(useValueExpr),
      scope: resolveScope({ explicit: explicitScope, tokenName: token }, ctx),
      deps: [],
      multi: multi ?? undefined,
      exported: exportsSet.has(token),
      file,
      line,
      importPath: ts.isIdentifier(useValueExpr)
        ? importPathOf(useValueExpr, ctx)
        : undefined,
    };
  }

  if (useFactoryExpr) {
    const factoryName = ts.isIdentifier(useFactoryExpr)
      ? (() => {
          const decl = resolveDeclaration(useFactoryExpr, ctx)[0];
          return decl && (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl))
            ? (ts.isFunctionDeclaration(decl) ? decl.name?.text : variableName(decl)) ?? useFactoryExpr.text
            : useFactoryExpr.text;
        })()
      : nodeText(useFactoryExpr);
    validateProviderCompatibility(provideExpr, useFactoryExpr, "factory", token, ctx, file, line);
    return {
      token,
      tokenKind,
      kind: "factory",
      useFactoryName: factoryName,
      scope: resolveScope({ explicit: explicitScope, tokenName: token }, ctx),
      deps: explicitDeps,
      multi: multi ?? undefined,
      exported: exportsSet.has(token),
      file,
      line,
      importPath: ts.isIdentifier(useFactoryExpr)
        ? importPathOf(useFactoryExpr, ctx)
        : undefined,
    };
  }

  if (useExistingExpr) {
    const target = tokenNameOf(useExistingExpr, ctx).name;
    validateProviderCompatibility(provideExpr, useExistingExpr, "existing", token, ctx, file, line);
    return {
      token,
      tokenKind,
      kind: "existing",
      useExisting: target,
      scope: resolveScope({ explicit: explicitScope, tokenName: token }, ctx),
      deps: [target],
      multi: multi ?? undefined,
      exported: exportsSet.has(token),
      file,
      line,
    };
  }

  return undefined;
}

/**
 * Expands Angular-style standalone provider helpers into ordinary provider
 * expressions before graph analysis. The generated application still contains
 * only direct static providers.
 */
function expandProviderExpressions(
  expressions: readonly Expression[],
  ctx: AnalysisContext,
  seen = new Set<string>(),
): Expression[] {
  const result: Expression[] = [];
  for (const expression of expressions) {
    if (ts.isSpreadElement(expression)) {
      result.push(...expandProviderExpressions([expression.expression], ctx, seen));
      continue;
    }
    if (ts.isIdentifier(expression)) {
      const declaration = resolveDeclaration(expression, ctx)[0];
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const key = `${declaration.getSourceFile().fileName}:${declaration.pos}`;
        if (seen.has(key)) continue;
        const initializer = declaration.initializer;
        if (ts.isCallExpression(initializer) && isProviderHelper(initializer, "makeEnvironmentProviders")) {
          const nested = initializer.arguments[0];
          if (nested && ts.isArrayLiteralExpression(nested)) {
            seen.add(key);
            result.push(...expandProviderExpressions([...nested.elements], ctx, seen));
            seen.delete(key);
            continue;
          }
        }
      }
    }
    if (ts.isCallExpression(expression) && isProviderHelper(expression, "makeEnvironmentProviders")) {
      const nested = expression.arguments[0];
      if (nested && ts.isArrayLiteralExpression(nested)) {
        result.push(...expandProviderExpressions([...nested.elements], ctx, seen));
        continue;
      }
    }
    result.push(expression);
  }
  return result;
}

function isProviderHelper(expression: ts.CallExpression, name: string): boolean {
  return nodeText(expression.expression).split(".").pop() === name;
}

function parseFunctionalProvider(
  expression: Expression,
  exportsSet: Set<string>,
  ctx: AnalysisContext,
): ProviderNode[] | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  const helper = nodeText(expression.expression).split(".").pop();
  const args = expression.arguments;
  const file = sourcePath(ctx.rootDir, expression.getSourceFile().fileName);
  const line = lineOf(expression);

  if (helper === "provideToken") {
    const tokenExpr = args[0];
    const valueExpr = args[1];
    if (!tokenExpr || !valueExpr) return [];
    const { name: token, kind: tokenKind } = tokenNameOf(tokenExpr, ctx);
    validateProviderCompatibility(tokenExpr, valueExpr, "value", token, ctx, file, line);
    return [{
      token,
      tokenKind,
      kind: "value",
      useValueExpr: nodeText(valueExpr),
      scope: resolveScope({ tokenName: token }, ctx),
      deps: [],
      exported: exportsSet.has(token),
      file,
      line,
      importPath: ts.isIdentifier(valueExpr) ? importPathOf(valueExpr, ctx) : undefined,
    }];
  }

  if (helper === "provideAppInitializer" || helper === "provideEnvironmentInitializer") {
    const initializer = args[0];
    if (!initializer) return [];
    const token = helper === "provideAppInitializer" ? "APP_INITIALIZER" : "ENVIRONMENT_INITIALIZER";
    return [{
      token,
      tokenKind: "injection-token",
      kind: "value",
      useValueExpr: nodeText(initializer),
      scope: "application",
      deps: [],
      multi: true,
      exported: false,
      file,
      line,
      importPath: ts.isIdentifier(initializer) ? importPathOf(initializer, ctx) : undefined,
    }];
  }

  if (helper === "provideRouter") {
    const providers: ProviderNode[] = [];
    const routes = args[0];
    if (routes) {
      providers.push({
        token: "ROUTE_CONFIG",
        tokenKind: "injection-token",
        kind: "value",
        useValueExpr: nodeText(routes),
        scope: "application",
        deps: [],
        exported: false,
        file,
        line,
        importPath: ts.isIdentifier(routes) ? importPathOf(routes, ctx) : undefined,
      });
    }
    for (const feature of args.slice(1)) {
      if (!ts.isCallExpression(feature)) continue;
      const featureName = nodeText(feature.expression).split(".").pop();
      if (featureName === "withRouterConfig" && feature.arguments[0]) {
        providers.push({
          token: "ROUTER_CONFIGURATION",
          tokenKind: "injection-token",
          kind: "value",
          useValueExpr: nodeText(feature.arguments[0]),
          scope: "application",
          deps: [],
          exported: false,
          file,
          line,
        });
      } else if (featureName === "withTitleStrategy" && feature.arguments[0]) {
        const strategy = feature.arguments[0];
        const isClass = ts.isIdentifier(strategy) && Boolean(resolveDeclaration(strategy, ctx)
          .find((declaration) => ts.isClassDeclaration(declaration)));
        providers.push({
          token: "TITLE_STRATEGY",
          tokenKind: "injection-token",
          kind: isClass ? "class" : "value",
          ...(isClass ? { useClass: nodeText(strategy) } : { useValueExpr: nodeText(strategy) }),
          scope: "application",
          deps: [],
          exported: false,
          file,
          line,
          importPath: ts.isIdentifier(strategy) ? importPathOf(strategy, ctx) : undefined,
        });
      }
    }
    return providers;
  }

  if (helper === "provideHttpClient") {
    const providers: ProviderNode[] = [{
      token: "HttpClient",
      tokenKind: "class",
      kind: "class",
      useClass: "HttpClient",
      scope: "application",
      deps: ["HTTP_CLIENT_CONFIG", "HTTP_INTERCEPTORS"],
      optionalDeps: ["HTTP_CLIENT_CONFIG", "HTTP_INTERCEPTORS"],
      exported: false,
      file,
      line,
      importModule: "@supacloud/app",
    }];
    for (const feature of args) {
      if (!ts.isCallExpression(feature)) continue;
      const featureName = nodeText(feature.expression).split(".").pop();
      if (featureName === "withInterceptors") {
        for (const interceptorArg of feature.arguments) {
          const values = ts.isArrayLiteralExpression(interceptorArg)
            ? [...interceptorArg.elements]
            : [interceptorArg];
          for (const value of values) {
            providers.push({
              token: "HTTP_INTERCEPTORS",
              tokenKind: "injection-token",
              kind: "value",
              useValueExpr: nodeText(value),
              scope: "application",
              deps: [],
              multi: true,
              exported: false,
              file,
              line,
              importPath: ts.isIdentifier(value) ? importPathOf(value, ctx) : undefined,
            });
          }
        }
      } else if (featureName === "withFetch" && feature.arguments.length > 0) {
        warn(
          ctx,
          "unsupported-provider-helper",
          "provideHttpClient(withFetch(customFetch)) 需要显式声明 HTTP_CLIENT_CONFIG provider 才能保持静态生成",
          file,
          line,
        );
      }
    }
    return providers;
  }

  return undefined;
}

/**
 * Validates Angular-style provider contracts during compilation. The emitted
 * application still uses static factories and never performs runtime type
 * inspection or dynamic dependency resolution.
 */
function validateProviderCompatibility(
  provideExpr: Expression,
  implementationExpr: Expression,
  kind: "class" | "value" | "factory" | "existing",
  tokenName: string,
  ctx: AnalysisContext,
  file: string,
  line: number,
): void {
  const expected = providerTokenValueType(provideExpr, ctx);
  const actual = providerImplementationType(implementationExpr, kind, ctx);
  if (!expected || !actual || isUnknownOrAny(expected) || isUnknownOrAny(actual)) return;
  if (ctx.checker.isTypeAssignableTo(actual, expected)) return;

  const providerKind = kind === "class" ? "useClass" : `use${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  ctx.diagnostics.push({
    severity: "error",
    code: "provider-type-mismatch",
    message: `Provider '${tokenName}' 的 ${providerKind} 类型不满足 Token 契约：需要 ${ctx.checker.typeToString(expected, provideExpr)}，实际为 ${ctx.checker.typeToString(actual, implementationExpr)}`,
    file,
    line,
    errorCode: "SC2010",
    docsUrl: "https://supacloud.dev/errors/SC2010",
  });
}

function providerTokenValueType(expr: Expression, ctx: AnalysisContext): ts.Type | undefined {
  const type = ctx.checker.getTypeAtLocation(expr);
  const typeArguments = typeArgumentsOf(type, ctx);
  if (typeArguments.length > 0) return typeArguments[0];

  if (ts.isIdentifier(expr)) {
    const declaration = resolveDeclaration(expr, ctx)[0];
    if (declaration && ts.isClassDeclaration(declaration)) {
      return declaredClassType(declaration, ctx);
    }
  }
  return undefined;
}

function providerImplementationType(
  expr: Expression,
  kind: "class" | "value" | "factory" | "existing",
  ctx: AnalysisContext,
): ts.Type | undefined {
  if (kind === "class" || kind === "existing") {
    if (ts.isIdentifier(expr)) {
      const declaration = resolveDeclaration(expr, ctx)[0];
      if (declaration && ts.isClassDeclaration(declaration)) {
        return declaredClassType(declaration, ctx);
      }
    }
    const type = ctx.checker.getTypeAtLocation(expr);
    const typeArguments = typeArgumentsOf(type, ctx);
    return typeArguments.length > 0 ? typeArguments[0] : undefined;
  }

  if (kind === "factory") {
    const type = ctx.checker.getTypeAtLocation(expr);
    const signature = ctx.checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
    return signature?.getReturnType();
  }

  return ctx.checker.getTypeAtLocation(expr);
}

function declaredClassType(declaration: ClassDeclaration, ctx: AnalysisContext): ts.Type | undefined {
  const name = declaration.name;
  if (!name) return undefined;
  const symbol = ctx.checker.getSymbolAtLocation(name);
  return symbol ? ctx.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
}

function typeArgumentsOf(type: ts.Type, ctx: AnalysisContext): readonly ts.Type[] {
  return isTypeReference(type) ? ctx.checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

function isUnknownOrAny(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function parseController(
  input: Expression | ClassDeclaration,
  ctx: AnalysisContext,
): ControllerNode | undefined {
  let decl: ClassDeclaration | undefined;
  if (ts.isClassDeclaration(input)) {
    decl = input;
  } else {
    const unwrapped = unwrapForwardRef(input);
    const resolved = ts.isIdentifier(unwrapped) ? resolveDeclaration(unwrapped, ctx)[0] : undefined;
    if (resolved && ts.isClassDeclaration(resolved)) {
      decl = resolved;
    }
  }
  if (!decl) return undefined;
  const controllerDec = findDecorator(decl, "Controller");
  if (!controllerDec) return undefined;
  let path: string = "/";
  let standalone: boolean | undefined;
  const pathArg = decoratorArguments(controllerDec)[0];
  if (pathArg) {
    if (ts.isStringLiteral(pathArg)) {
      path = pathArg.text;
    } else if (ts.isObjectLiteralExpression(pathArg)) {
      const p = stringLiteralProp(pathArg, "path");
      if (p) path = p;
      standalone = booleanProp(pathArg, "standalone");
    }
  }

  const { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, functionalInjects, missing } = classDeps(decl, ctx);
  const file = sourcePath(ctx.rootDir, decl.getSourceFile().fileName);
  if (missing) {
    warn(ctx, "missing-deps", `controller ${decl.name?.text} 的部分构造依赖无法静态解析`, file, lineOf(decl));
  }

  const injectable = parseInjectableOptions(decl, ctx);
  const routes: RouteNode[] = [];
  const schemaImports: Record<string, string> = {};
  const classGuards: string[] = [];
  for (const dec of decoratorsOf(decl)) {
    if (decoratorName(dec) === "UseGuards") {
      for (const gArg of decoratorArguments(dec)) {
        classGuards.push(tokenText(gArg, ctx));
      }
    }
  }

  for (const method of decl.members.filter(ts.isMethodDeclaration)) {
    for (const dec of decoratorsOf(method)) {
      const name = decoratorName(dec);
      const httpMethod = name ? ROUTE_DECORATORS[name] : undefined;
      if (!httpMethod) continue;
      const args = decoratorArguments(dec);
      const pathArg = args[0];
      const routePath = pathArg && ts.isStringLiteral(pathArg) ? pathArg.text : "/";
      const route: RouteNode = {
        method: httpMethod,
        path: routePath,
        handler: propertyName(method.name),
      };
      const pathParams: string[] = [];
      const paramRegex = /:([a-zA-Z0-9_]+)/g;
      let match: RegExpExecArray | null;
      while ((match = paramRegex.exec(routePath)) !== null) {
        pathParams.push(match[1]);
      }
      if (pathParams.length > 0) route.pathParams = pathParams;

      const paramBindings: string[] = [];
      const queryBindings: string[] = [];
      const paramTransforms: Record<string, "number" | "boolean" | "string"> = {};
      const paramDefaults: Record<string, unknown> = {};
      const queryTransforms: Record<string, "number" | "boolean" | "string"> = {};
      const queryDefaults: Record<string, unknown> = {};
      let hasBodyBinding: boolean = false;
      const handlerParams: HandlerParamNode[] = [];
      for (const p of method.parameters) {
        const pName = parameterName(p);
        let hasBindingDecorator: boolean = false;
        let paramNode: HandlerParamNode | undefined;
        for (const pDec of decoratorsOf(p)) {
          const dName = decoratorName(pDec);
          const dArgs = decoratorArguments(pDec);
          if (dName === "Param") {
            hasBindingDecorator = true;
            const parsed = parseBindingOptions(dArgs, pName);
            paramBindings.push(parsed.name);
            if (parsed.transform) paramTransforms[parsed.name] = parsed.transform;
            if (parsed.default !== undefined) paramDefaults[parsed.name] = parsed.default;
            paramNode = {
              name: pName,
              kind: "param",
              bindingName: parsed.name,
              transform: parsed.transform,
              default: parsed.default,
            };
          } else if (dName === "Query") {
            hasBindingDecorator = true;
            const parsed = parseBindingOptions(dArgs, pName);
            queryBindings.push(parsed.name);
            if (parsed.transform) queryTransforms[parsed.name] = parsed.transform;
            if (parsed.default !== undefined) queryDefaults[parsed.name] = parsed.default;
            paramNode = {
              name: pName,
              kind: "query",
              bindingName: parsed.name,
              transform: parsed.transform,
              default: parsed.default,
            };
          } else if (dName === "Body") {
            hasBindingDecorator = true;
            hasBodyBinding = true;
            paramNode = { name: pName, kind: "body" };
          } else if (dName === "Headers") {
            hasBindingDecorator = true;
            paramNode = { name: pName, kind: "headers" };
          }
        }
        // Automatic route parameter binding (Angular withComponentInputBinding pattern):
        // If a method parameter name matches a route path parameter (:name) and has no explicit binding decorator,
        // automatically infer the path parameter binding and deduce its primitive transform.
        if (!hasBindingDecorator && pathParams.includes(pName)) {
          paramBindings.push(pName);
          const typeText = p.type ? nodeText(p.type) : "";
          let inferredTransform: "number" | "boolean" | "string" | undefined;
          if (typeText === "number") {
            paramTransforms[pName] = "number";
            inferredTransform = "number";
          } else if (typeText === "boolean") {
            paramTransforms[pName] = "boolean";
            inferredTransform = "boolean";
          }
          paramNode = {
            name: pName,
            kind: "param",
            bindingName: pName,
            transform: inferredTransform,
          };
        } else if (!hasBindingDecorator) {
          if (pName === "req" || pName === "ctx" || pName === "context") {
            paramNode = { name: pName, kind: "context" };
          } else {
            paramNode = { name: pName, kind: "unknown" };
          }
        }
        if (paramNode) handlerParams.push(paramNode);
      }
      if (paramBindings.length > 0) route.paramBindings = paramBindings;
      if (queryBindings.length > 0) route.queryBindings = queryBindings;
      if (Object.keys(paramTransforms).length > 0) route.paramTransforms = paramTransforms;
      if (Object.keys(paramDefaults).length > 0) route.paramDefaults = paramDefaults;
      if (Object.keys(queryTransforms).length > 0) route.queryTransforms = queryTransforms;
      if (Object.keys(queryDefaults).length > 0) route.queryDefaults = queryDefaults;
      if (hasBodyBinding) route.hasBodyBinding = true;
      if (handlerParams.length > 0) route.handlerParams = handlerParams;

      const routeGuards: string[] = [...classGuards];
      const routeCanDeactivate: string[] = [];
      for (const mDec of decoratorsOf(method)) {
        const dName = decoratorName(mDec);
        const mArgs = decoratorArguments(mDec);
        if (dName === "UseGuards") {
          for (const gArg of mArgs) {
            routeGuards.push(tokenText(gArg, ctx));
          }
        } else if (dName === "CanDeactivate") {
          for (const gArg of mArgs) {
            routeCanDeactivate.push(tokenText(gArg, ctx));
          }
        } else if (dName === "Title") {
          const tArg = mArgs[0];
          if (tArg && ts.isStringLiteral(tArg)) {
            route.title = tArg.text;
          }
        } else if (dName === "Data") {
          const dArg = mArgs[0];
          if (dArg && ts.isObjectLiteralExpression(dArg)) {
            route.data = { ...route.data, ...parseObjectLiteralValues(dArg) };
          }
        } else if (dName === "Resolve") {
          const rArg = mArgs[0];
          if (rArg && ts.isObjectLiteralExpression(rArg)) {
            const resolvers: Record<string, string> = route.resolvers ?? {};
            for (const prop of rArg.properties) {
              if (ts.isPropertyAssignment(prop)) {
                const rName = propertyName(prop.name);
                const init = prop.initializer;
                if (init) resolvers[rName] = tokenText(init, ctx);
              }
            }
            if (Object.keys(resolvers).length > 0) {
              route.resolvers = resolvers;
            }
          }
        }
      }

      const optionsArg = args[1];
      if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        for (const field of ["body", "params", "query", "response"] as const) {
          const schemaExpr = getProp(optionsArg, field);
          if (schemaExpr && ts.isIdentifier(schemaExpr)) {
            route[field] = nodeText(schemaExpr);
            const importPath = importPathOf(schemaExpr, ctx);
            if (importPath) schemaImports[schemaExpr.text] = importPath;
          }
        }
        const commandExpr = getProp(optionsArg, "command");
        if (commandExpr && ts.isIdentifier(commandExpr)) {
          const commandDecl = resolveDeclaration(commandExpr, ctx)[0];
          route.command = commandDecl && ts.isClassDeclaration(commandDecl)
            ? (commandDecl.name?.text ?? commandExpr.text)
            : commandExpr.text;
        }
        const guardsExpr = getProp(optionsArg, "guards");
        if (guardsExpr && ts.isArrayLiteralExpression(guardsExpr)) {
          for (const el of guardsExpr.elements) {
            routeGuards.push(tokenText(el, ctx));
          }
        }
        const canMatchExpr = getProp(optionsArg, "canMatch");
        if (canMatchExpr && ts.isArrayLiteralExpression(canMatchExpr)) {
          const canMatchList: string[] = [];
          for (const el of canMatchExpr.elements) {
            canMatchList.push(tokenText(el, ctx));
          }
          if (canMatchList.length > 0) {
            route.canMatch = canMatchList;
          }
        }
        const canDeactivateExpr = getProp(optionsArg, "canDeactivate");
        if (canDeactivateExpr && ts.isArrayLiteralExpression(canDeactivateExpr)) {
          for (const el of canDeactivateExpr.elements) {
            routeCanDeactivate.push(tokenText(el, ctx));
          }
        }
        const resolversExpr = getProp(optionsArg, "resolvers");
        if (resolversExpr && ts.isObjectLiteralExpression(resolversExpr)) {
          const resolvers: Record<string, string> = {};
          for (const prop of resolversExpr.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const rName = propertyName(prop.name);
              const init = prop.initializer;
              if (init) resolvers[rName] = tokenText(init, ctx);
            }
          }
          if (Object.keys(resolvers).length > 0) {
            route.resolvers = resolvers;
          }
        }
        const redirectToExpr = getProp(optionsArg, "redirectTo");
        if (redirectToExpr && ts.isStringLiteral(redirectToExpr)) {
          route.redirectTo = redirectToExpr.text;
        }
        const pathMatchExpr = getProp(optionsArg, "pathMatch");
        if (pathMatchExpr && ts.isStringLiteral(pathMatchExpr)) {
          const val = pathMatchExpr.text;
          if (val === "full" || val === "prefix") {
            route.pathMatch = val;
          }
        }
        const titleExpr = getProp(optionsArg, "title");
        if (titleExpr && ts.isStringLiteral(titleExpr)) {
          route.title = titleExpr.text;
        }
        const dataExpr = getProp(optionsArg, "data");
        if (dataExpr && ts.isObjectLiteralExpression(dataExpr)) {
          route.data = { ...route.data, ...parseObjectLiteralValues(dataExpr) };
        }
      }
      if (routeGuards.length > 0) {
        route.guards = routeGuards;
      }
      if (routeCanDeactivate.length > 0) {
        route.canDeactivate = routeCanDeactivate;
      }
      routes.push(route);
    }
  }

  return {
    className: decl.name?.text ?? "<anonymous>",
    path,
    scope: injectable?.scope ?? "request",
    deps,
    hasOnDestroy: hasDestroyHook(decl) || undefined,
    optionalDeps: optionalDeps.length > 0 ? optionalDeps : undefined,
    selfDeps: selfDeps.length > 0 ? selfDeps : undefined,
    skipSelfDeps: skipSelfDeps.length > 0 ? skipSelfDeps : undefined,
    hostDeps: hostDeps.length > 0 ? hostDeps : undefined,
    functionalInjects: functionalInjects.length > 0 ? functionalInjects : undefined,
    standalone: standalone || undefined,
    routes,
    file,
    importPath: modulePath(ctx.rootDir, decl.getSourceFile().fileName),
    schemaImports: Object.keys(schemaImports).length > 0 ? schemaImports : undefined,
  };
}

/**
 * Dependency resolution for class provider / controller:
 * @Injectable({ deps }) > constructor @Inject parameter decorator > constructor parameter type name
 * (only when type name is a known class / known token); otherwise marked missing.
 */
function classDeps(
  cls: ClassDeclaration,
  ctx: AnalysisContext,
): {
  deps: string[];
  optionalDeps: string[];
  selfDeps: string[];
  skipSelfDeps: string[];
  hostDeps: string[];
  functionalInjects: FunctionalInjectNode[];
  missing: boolean;
} {
  const injectable = parseInjectableOptions(cls, ctx);
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  const deps: string[] = injectable?.deps ? [...injectable.deps] : [];
  const optionalDeps: string[] = [];
  const selfDeps: string[] = [];
  const skipSelfDeps: string[] = [];
  const hostDeps: string[] = [];
  const functionalInjects: FunctionalInjectNode[] = [];
  let missing: boolean = false;

  if (!injectable?.deps && ctor && ctor.parameters.length > 0) {
    const injectParams = parseInjectParams(cls, ctx);
    const optionalIndices = parseOptionalParams(cls);
    const selfIndices = parseModifierParams(cls, "Self");
    const skipSelfIndices = parseModifierParams(cls, "SkipSelf");
    const hostIndices = parseModifierParams(cls, "Host");
    ctor.parameters.forEach((param, index) => {
      const isOptional = optionalIndices.has(index);
      const injected = injectParams.get(index);
      const tokenName = injected ?? paramTypeTokenName(param, ctx);
      if (tokenName) {
        deps.push(tokenName);
        if (isOptional) optionalDeps.push(tokenName);
        if (selfIndices.has(index)) selfDeps.push(tokenName);
        if (skipSelfIndices.has(index)) skipSelfDeps.push(tokenName);
        if (hostIndices.has(index)) hostDeps.push(tokenName);
      } else {
        if (!isOptional) missing = true;
      }
    });
  }

  // Property-level inject() calls (Angular functional DI syntax: private foo = inject(TOKEN)).
  for (const prop of cls.members.filter(ts.isPropertyDeclaration)) {
    const init = prop.initializer;
    if (init && ts.isCallExpression(init)) {
      const callName = nodeText(init.expression).split(".").pop();
      if (callName === "inject") {
        const [tokenArg, optionsArg] = init.arguments;
        if (tokenArg) {
          const tokenName = tokenText(tokenArg, ctx);
          const unwrappedToken = unwrapForwardRef(tokenArg);
          const known = ts.isStringLiteral(unwrappedToken)
            || (ts.isIdentifier(unwrappedToken)
              && (ctx.tokensByName.has(tokenName) || ctx.classesByName.has(tokenName)));
          if (!known) {
            missing = true;
            continue;
          }
          if (!deps.includes(tokenName)) deps.push(tokenName);
          const options = optionsArg && ts.isObjectLiteralExpression(optionsArg)
            ? {
                optional: booleanProp(optionsArg, "optional") ?? false,
                self: booleanProp(optionsArg, "self") ?? false,
                skipSelf: booleanProp(optionsArg, "skipSelf") ?? false,
                host: booleanProp(optionsArg, "host") ?? false,
              }
            : { optional: false, self: false, skipSelf: false, host: false };
          if (options.optional && !optionalDeps.includes(tokenName)) optionalDeps.push(tokenName);
          if (options.self && !selfDeps.includes(tokenName)) selfDeps.push(tokenName);
          if (options.skipSelf && !skipSelfDeps.includes(tokenName)) skipSelfDeps.push(tokenName);
          if (options.host && !hostDeps.includes(tokenName)) hostDeps.push(tokenName);
          if (!functionalInjects.some((entry) => entry.token === tokenName)) {
            functionalInjects.push({
              token: tokenName,
              expression: nodeText(unwrappedToken),
              importPath: ts.isIdentifier(unwrappedToken)
                ? (() => {
                    const declaration = resolveDeclaration(unwrappedToken, ctx)[0];
                    return declaration && isProjectSourcePath(declaration.getSourceFile().fileName, ctx.rootDir)
                      ? modulePath(ctx.rootDir, declaration.getSourceFile().fileName)
                      : undefined;
                  })()
                : undefined,
              importModule: ts.isIdentifier(unwrappedToken)
                ? (() => {
                    const declaration = resolveDeclaration(unwrappedToken, ctx)[0];
                    return declaration && !isProjectSourcePath(declaration.getSourceFile().fileName, ctx.rootDir)
                      ? importModuleOf(unwrappedToken, ctx)
                      : undefined;
                  })()
                : undefined,
              ...options,
            });
          }
        }
      }
    }
  }

  return { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, functionalInjects, missing };
}

/** Fallback for constructor parameter type name: only used if type name references a known class or known InjectionToken variable. */
function paramTypeTokenName(param: ParameterDeclaration, ctx: AnalysisContext): string | undefined {
  const typeNode = param.type;
  if (!typeNode) return undefined;
  const text = nodeText(typeNode).replace(/<.*>$/, "").replace(/\[\]$/, "").trim();
  if (ctx.classesByName.has(text)) return text;
  if (ctx.tokensByName.has(text)) return text;
  return undefined;
}

// ---------------------------------------------------------------------------
// AST Utilities
// ---------------------------------------------------------------------------

function parseInjectableOptions(
  cls: ClassDeclaration,
  ctx?: AnalysisContext,
): { scope?: Scope; providedIn?: "root"; deps?: string[] } | undefined {
  const dec = findDecorator(cls, "Injectable");
  if (!dec) return undefined;
  const obj = decoratorObjectArg(dec);
  if (!obj) return {};
  const scope = stringLiteralProp(obj, "scope");
  const providedIn = stringLiteralProp(obj, "providedIn");
  const depsExpr = getProp(obj, "deps");
  return {
    scope: scope && isScope(scope) ? scope : undefined,
    providedIn: providedIn === "root" ? "root" : undefined,
    deps: depsExpr
      ? arrayProp(obj, "deps").map((el) => (ctx ? tokenNameOf(el, ctx).name : nodeText(el)))
      : undefined,
  };
}

/** Constructor @Inject(token) parameter decorator -> parameter index -> token name. */
function parseInjectParams(cls: ClassDeclaration, ctx: AnalysisContext): Map<number, string> {
  const result = new Map<number, string>();
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  if (!ctor) return result;
  ctor.parameters.forEach((param, index) => {
    for (const dec of decoratorsOf(param)) {
      if (decoratorName(dec) !== "Inject") continue;
      const arg = decoratorArguments(dec)[0];
      if (arg) result.set(index, tokenText(arg, ctx));
    }
  });
  return result;
}

/** Constructor @Optional() parameter decorator or question token -> parameter indices. */
function parseOptionalParams(cls: ClassDeclaration): Set<number> {
  const result = new Set<number>();
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  if (!ctor) return result;
  ctor.parameters.forEach((param, index) => {
    for (const dec of decoratorsOf(param)) {
      if (decoratorName(dec) === "Optional") result.add(index);
    }
    if (param.questionToken) result.add(index);
  });
  return result;
}

function parseModifierParams(cls: ClassDeclaration, modifierName: string): Set<number> {
  const result = new Set<number>();
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  if (!ctor) return result;
  ctor.parameters.forEach((param, index) => {
    for (const dec of decoratorsOf(param)) {
      if (decoratorName(dec) === modifierName) result.add(index);
    }
  });
  return result;
}

function unwrapForwardRef(expr: Expression): Expression {
  if (ts.isCallExpression(expr)) {
    const exprText = nodeText(expr.expression);
    if (exprText === "forwardRef" || exprText.endsWith(".forwardRef")) {
      const arg = expr.arguments[0];
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const body = arg.body;
        if (body && ts.isExpression(body)) {
          return unwrapForwardRef(body);
        }
      }
    }
  }
  return expr;
}

function tokenText(expr: Expression, ctx: AnalysisContext): string {
  const unwrapped = unwrapForwardRef(expr);
  if (ts.isStringLiteral(unwrapped)) return unwrapped.text;
  if (ts.isIdentifier(unwrapped)) {
    const decl = resolveDeclaration(unwrapped, ctx)[0];
    if (decl && ts.isClassDeclaration(decl)) return decl.name?.text ?? unwrapped.text;
    if (decl && ts.isVariableDeclaration(decl)) return variableName(decl);
  }
  return nodeText(unwrapped);
}

function resolveScope(
  input: { explicit?: Scope; cls?: ClassDeclaration; tokenName: string },
  ctx: AnalysisContext,
): Scope {
  if (input.explicit) return input.explicit;
  if (input.cls) {
    const injectable = parseInjectableOptions(input.cls, ctx);
    if (injectable?.scope) return injectable.scope;
  }
  const token = ctx.tokensByName.get(input.tokenName);
  if (token?.scope) return token.scope;
  return "application";
}

/** Identifier -> token name + kind (resolves across imports to declaration). */
function tokenNameOf(expr: Expression, ctx: AnalysisContext): { name: string; kind: TokenKind } {
  const unwrapped = unwrapForwardRef(expr);
  if (ts.isIdentifier(unwrapped)) {
    const decl = resolveDeclaration(unwrapped, ctx)[0];
    if (decl && ts.isClassDeclaration(decl)) {
      return { name: decl.name?.text ?? nodeText(expr), kind: "class" };
    }
    if (decl && ts.isVariableDeclaration(decl)) {
      const name = variableName(decl);
      return { name, kind: ctx.tokensByName.has(name) ? "injection-token" : "class" };
    }
    if (ctx.tokensByName.has(unwrapped.text)) {
      return { name: unwrapped.text, kind: "injection-token" };
    }
  }
  return { name: nodeText(expr), kind: "class" };
}

/** Resolves identifier to its declarations (following import aliases). */
function resolveDeclaration(id: Identifier, ctx: AnalysisContext): ts.Declaration[] {
  let symbol = ctx.checker.getSymbolAtLocation(id);
  if (!symbol) return [];
  let declarations = symbol.declarations ?? [];
  for (let guard: number = 0; guard < 4; guard += 1) {
    const isAlias = declarations.some(
      (d) =>
        ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d),
    );
    if (!isAlias) break;
    if (!(symbol.flags & ts.SymbolFlags.Alias)) break;
    const aliased = ctx.checker.getAliasedSymbol(symbol);
    symbol = aliased;
    declarations = aliased.declarations ?? [];
  }
  return declarations;
}

/** File path where identifier is defined (relative to rootDir, stripped of extension) for import generation. */
function importPathOf(id: Identifier, ctx: AnalysisContext): string | undefined {
  const decl = resolveDeclaration(id, ctx)[0];
  if (decl) return modulePath(ctx.rootDir, decl.getSourceFile().fileName);
  return undefined;
}

/** Package specifier for an imported symbol declared outside the project source tree. */
function importModuleOf(id: Identifier, ctx: AnalysisContext): string | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(id);
  const declarations = symbol?.declarations ?? [];
  for (const declaration of declarations) {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (ts.isImportDeclaration(current)) {
        const moduleSpecifier = current.moduleSpecifier;
        return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : undefined;
      }
      current = current.parent;
    }
  }
  return undefined;
}

function findDecorator(cls: ClassDeclaration, name: string): Decorator | undefined {
  return decoratorsOf(cls).find((dec) => decoratorName(dec) === name);
}

function decoratorName(dec: Decorator): string | undefined {
  const expr = dec.expression;
  if (ts.isCallExpression(expr)) {
    return nodeText(expr.expression).split(".").pop();
  }
  if (ts.isIdentifier(expr)) return expr.text;
  return undefined;
}

function decoratorObjectArg(dec: Decorator): ObjectLiteralExpression | undefined {
  const expr = dec.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  const arg = expr.arguments[0];
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
}

function getProp(obj: ObjectLiteralExpression, name: string): Expression | undefined {
  const prop = obj.properties.find((item) =>
    ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  );
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}

function toCompilerDiagnostic(diagnostic: ts.Diagnostic, rootDir: string): Diagnostic {
  const file = diagnostic.file;
  const position = file && diagnostic.start !== undefined
    ? file.getLineAndCharacterOfPosition(diagnostic.start)
    : undefined;
  return {
    severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warn",
    code: `typescript-${diagnostic.code}`,
    errorCode: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    file: file ? sourcePath(rootDir, file.fileName) : undefined,
    line: position ? position.line + 1 : undefined,
  };
}

function stringLiteralProp(obj: ObjectLiteralExpression, name: string): string | undefined {
  const expr = getProp(obj, name);
  return expr && ts.isStringLiteral(expr) ? expr.text : undefined;
}

function arrayProp(obj: ObjectLiteralExpression, name: string): Expression[] {
  const expr = getProp(obj, name);
  return expr && ts.isArrayLiteralExpression(expr) ? [...expr.elements] : [];
}

function booleanProp(obj: ObjectLiteralExpression, name: string): boolean | undefined {
  const expr = getProp(obj, name);
  if (!expr) return undefined;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function parseScopeProp(obj: ObjectLiteralExpression): Scope | undefined {
  const scope = stringLiteralProp(obj, "scope");
  return scope && isScope(scope) ? scope : undefined;
}

function parseBindingOptions(args: readonly Expression[], defaultName: string): {
  name: string;
  transform?: "number" | "boolean" | "string";
  default?: unknown;
} {
  let name = defaultName;
  let transform: "number" | "boolean" | "string" | undefined;
  let defaultValue: unknown;

  const first = args[0];
  const second = args[1];

  if (first && ts.isStringLiteral(first)) {
    name = first.text;
  } else if (first && ts.isObjectLiteralExpression(first)) {
    const nameProp = getProp(first, "name");
    if (nameProp && ts.isStringLiteral(nameProp)) {
      name = nameProp.text;
    }
    const trProp = getProp(first, "transform");
    if (trProp && ts.isStringLiteral(trProp)) {
      const val = trProp.text;
      if (val === "number" || val === "boolean" || val === "string") {
        transform = val;
      }
    }
    const defProp = getProp(first, "default");
    if (defProp) {
      defaultValue = parseLiteralValue(defProp);
    }
  }

  if (second && ts.isObjectLiteralExpression(second)) {
    const trProp = getProp(second, "transform");
    if (trProp && ts.isStringLiteral(trProp)) {
      const val = trProp.text;
      if (val === "number" || val === "boolean" || val === "string") {
        transform = val;
      }
    }
    const defProp = getProp(second, "default");
    if (defProp) {
      defaultValue = parseLiteralValue(defProp);
    }
  }

  return { name, transform, default: defaultValue };
}

function parseLiteralValue(node: AstNode): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(parseLiteralValue);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return parseObjectLiteralValues(node);
  }
  return undefined;
}

function parseObjectLiteralValues(obj: ObjectLiteralExpression): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop.name);
      const init = prop.initializer;
      if (init) {
        result[name] = parseLiteralValue(init);
      }
    }
  }
  return result;
}

/** Absolute path -> posix-style module path relative to rootDir without extension (for import generation). */
function modulePath(rootDir: string, absFile: string): string {
  return sourcePath(rootDir, absFile).replace(/\.(ts|tsx|js|mts|cts)$/, "");
}

/** Absolute path -> posix-style source file path relative to rootDir (keeping extension, for diagnostic location). */
function sourcePath(rootDir: string, absFile: string): string {
  return relative(rootDir, absFile).split(sep).join("/");
}

function warn(
  ctx: AnalysisContext,
  code: string,
  message: string,
  file?: string,
  line?: number,
): void {
  ctx.diagnostics.push({ severity: "warn", code, message, file, line });
}
