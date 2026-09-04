import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type Identifier,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol as TsSymbol,
  type VariableDeclaration,
} from "ts-morph";
import type {
  ApplicationGraph,
  CachedModuleEntry,
  CommandNode,
  ControllerNode,
  DependencyGraphCache,
  Diagnostic,
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

interface ClassInfo {
  name: string;
  decl: ClassDeclaration;
  file: string;
}

/** Analysis context: project-wide symbol index + diagnostics collection. */
interface AnalysisContext {
  rootDir: string;
  tokensByName: Map<string, TokenInfo>;
  classesByName: Map<string, ClassInfo>;
  diagnostics: Diagnostic[];
}

/**
 * Analyzes source code under rootDir (via ts-morph AST, without typecheck dependency) to build ApplicationGraph.
 * Decorators are matched by name only (Module/Injectable/Inject/Command/Query/Controller/Get/...),
 * without checking import origins, so this package does not need to depend on @supacloud/app.
 */
export async function analyzeProject(
  rootDir: string,
  include?: string[],
  cache?: DependencyGraphCache,
): Promise<ApplicationGraph> {
  let project: Project;
  if (cache?.project) {
    project = cache.project;
    for (const sf of project.getSourceFiles()) {
      sf.refreshFromFileSystemSync();
    }
  } else {
    project = createProject(rootDir);
    const patterns = (include ?? DEFAULT_INCLUDE).map((glob) => join(rootDir, glob));
    project.addSourceFilesAtPaths(patterns);
    if (cache) cache.project = project;
  }
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().includes("node_modules") && !sf.isDeclarationFile())
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

  const ctx: AnalysisContext = {
    rootDir,
    tokensByName: new Map(),
    classesByName: new Map(),
    diagnostics: [],
  };
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
    for (const cls of sf.getClasses()) {
      const moduleDec = findDecorator(cls, "Module");
      if (!moduleDec) continue;
      const options = decoratorObjectArg(moduleDec);
      if (!options) continue;
      candidates.push({
        node: cls,
        options,
        className: cls.getName() ?? "<anonymous>",
        file: sf.getFilePath(),
        line: cls.getStartLineNumber(),
      });
    }
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== "defineModule") continue;
      const parent = call.getParent();
      if (!parent || !Node.isVariableDeclaration(parent)) continue;
      const arg = call.getArguments()[0];
      if (!arg || !Node.isObjectLiteralExpression(arg)) continue;
      candidates.push({
        node: parent,
        options: arg,
        className: parent.getName(),
        file: sf.getFilePath(),
        line: parent.getStartLineNumber(),
      });
    }
  }
  const nameByNode = new Map<Node, string>();
  for (const c of candidates) {
    nameByNode.set(c.node, stringLiteralProp(c.options, "name") ?? c.className);
  }

  let modules: ModuleNode[] = [];
  let reusedModules: string[] = [];
  let reanalyzedModules: string[] = [];

  if (cache) {
    const currentFileHashes = new Map<string, string>();
    for (const sf of sourceFiles) {
      const rel = sourcePath(rootDir, sf.getFilePath());
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
    const finalDiagnostics: Diagnostic[] = [];

    for (const [modName, entry] of cache.modules.entries()) {
      const hasChangedFile = entry.ownedFiles.some((f) => changedFiles.has(f));
      const moduleFileExists = currentFileHashes.has(entry.module.file);
      if (!hasChangedFile && moduleFileExists) {
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

      const ownedFiles = new Set<string>();
      ownedFiles.add(parsed.file);
      for (const p of parsed.providers) if (p.file) ownedFiles.add(p.file);
      for (const ctrl of parsed.controllers) if (ctrl.file) ownedFiles.add(ctrl.file);

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
        const { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, missing } = classDeps(classInfo.decl, ctx);
        const file = sourcePath(ctx.rootDir, classInfo.file);
        const line = classInfo.decl.getStartLineNumber();
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
          providedIn: "root",
          hasOnDestroy: classInfo.decl.getMethod("onDestroy") !== undefined || undefined,
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
        const arg = controllerDec.getArguments()[0];
        const isStandalone = arg && Node.isObjectLiteralExpression(arg) && booleanProp(arg, "standalone");
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
            className: classInfo.decl.getName() ?? name,
            name: stringLiteralProp(meta, "name") ?? classInfo.decl.getName() ?? name,
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
      existingRoot.providers.push(...rootProviders);
      existingRoot.controllers.push(...standaloneControllers);
      existingRoot.commands.push(...standaloneCommands);
      for (const p of rootProviders) {
        if (!existingRoot.exports.includes(p.token)) existingRoot.exports.push(p.token);
      }
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

function createProject(rootDir: string): Project {
  const tsConfigFilePath = join(rootDir, "tsconfig.json");
  if (existsSync(tsConfigFilePath)) {
    return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
  }
  return new Project({
    compilerOptions: { experimentalDecorators: true, allowJs: false },
  });
}

/** Indexes InjectionToken variables and class declarations in the file. */
function indexFile(sf: SourceFile, ctx: AnalysisContext): void {
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (name && !ctx.classesByName.has(name)) {
      ctx.classesByName.set(name, { name, decl: cls, file: sf.getFilePath() });
    }
  }
  for (const statement of sf.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const info = parseTokenVariable(decl, sf.getFilePath());
      if (info && !ctx.tokensByName.has(info.name)) {
        ctx.tokensByName.set(info.name, info);
      }
    }
  }
}

/** Parses `const X = new InjectionToken("name", { scope })` variable declaration. */
function parseTokenVariable(decl: VariableDeclaration, file: string): TokenInfo | undefined {
  const init = decl.getInitializer();
  if (!init || !Node.isNewExpression(init)) return undefined;
  if (init.getExpression().getText() !== "InjectionToken") return undefined;
  const [nameArg, optionsArg] = init.getArguments();
  const info: TokenInfo = { name: decl.getName(), file, line: decl.getStartLineNumber() };
  if (nameArg && Node.isStringLiteral(nameArg)) {
    info.stringName = nameArg.getLiteralText();
  }
  if (optionsArg && Node.isObjectLiteralExpression(optionsArg)) {
    const scope = stringLiteralProp(optionsArg, "scope");
    if (scope && (SCOPES as string[]).includes(scope)) {
      info.scope = scope as Scope;
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
  candidate: { node: Node; options: ObjectLiteralExpression; className: string; file: string; line: number },
  nameByNode: Map<Node, string>,
  ctx: AnalysisContext,
): ModuleNode {
  const { options, className, file, line } = candidate;
  const name = nameByNode.get(candidate.node) ?? className;

  const tags = arrayProp(options, "tags")
    .map((el) => (Node.isStringLiteral(el) ? el.getLiteralText() : el.getText().replace(/['"]/g, "")))
    .filter(Boolean);

  const imports = arrayProp(options, "imports")
    .map((el) => {
      const unwrapped = unwrapForwardRef(el);
      const decl = Node.isIdentifier(unwrapped) ? resolveDeclaration(unwrapped)[0] : undefined;
      if (decl) {
        const known = nameByNode.get(decl);
        if (known) return known;
        if (Node.isClassDeclaration(decl)) {
          const dec = findDecorator(decl, "Module");
          const decOptions = dec && decoratorObjectArg(dec);
          const decName = decOptions && stringLiteralProp(decOptions, "name");
          return decName ?? decl.getName() ?? el.getText();
        }
        if (Node.isVariableDeclaration(decl)) return decl.getName();
      }
      return el.getText();
    })
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const exports = arrayProp(options, "exports").map((el) => tokenNameOf(el, ctx).name);
  const exportsSet = new Set(exports);

  const providers: ProviderNode[] = [];
  for (const el of arrayProp(options, "providers")) {
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
    if (!Node.isIdentifier(expr)) return;
    const decl = resolveDeclaration(expr)[0];
    if (decl && Node.isClassDeclaration(decl) && !seenHandlers.has(decl.getName() ?? "")) {
      seenHandlers.add(decl.getName() ?? "");
      handlerClasses.push(decl);
    }
  };
  for (const el of arrayProp(options, "providers")) {
    if (Node.isIdentifier(el)) collectHandler(el);
    if (Node.isObjectLiteralExpression(el)) {
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
          className: cls.getName() ?? "<anonymous>",
          name: stringLiteralProp(meta, "name") ?? cls.getName() ?? "<anonymous>",
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
          className: cls.getName() ?? "<anonymous>",
          name: stringLiteralProp(meta, "name") ?? cls.getName() ?? "<anonymous>",
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
  const file = sourcePath(ctx.rootDir, el.getSourceFile().getFilePath());
  const line = el.getStartLineNumber();

  const unwrappedEl = unwrapForwardRef(el);
  // Bare class reference -> class provider, token = class name
  if (Node.isIdentifier(unwrappedEl)) {
    const decl = resolveDeclaration(unwrappedEl)[0];
    const cls = decl && Node.isClassDeclaration(decl) ? decl : undefined;
    const className = cls?.getName() ?? unwrappedEl.getText();
    const { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, missing } = cls
      ? classDeps(cls, ctx)
      : { deps: [], optionalDeps: [], selfDeps: [], skipSelfDeps: [], hostDeps: [], missing: false };
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
      providedIn: injectable?.providedIn,
      hasOnDestroy: cls?.getMethod("onDestroy") !== undefined || undefined,
      exported: exportsSet.has(className),
      file,
      line,
      importPath: cls ? modulePath(ctx.rootDir, cls.getSourceFile().getFilePath()) : undefined,
    };
  }

  if (!Node.isObjectLiteralExpression(el)) return undefined;
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
    const decl = Node.isIdentifier(unwrappedClass) ? resolveDeclaration(unwrappedClass)[0] : undefined;
    const cls = decl && Node.isClassDeclaration(decl) ? decl : undefined;
    const useClass = cls?.getName() ?? unwrappedClass.getText();
    let deps = explicitDeps;
    let optionalDeps: string[] = [];
    let selfDeps: string[] = [];
    let skipSelfDeps: string[] = [];
    let hostDeps: string[] = [];
    if (deps.length === 0 && cls) {
      const result = classDeps(cls, ctx);
      deps = result.deps;
      optionalDeps = result.optionalDeps;
      selfDeps = result.selfDeps;
      skipSelfDeps = result.skipSelfDeps;
      hostDeps = result.hostDeps;
      if (result.missing) {
        warn(ctx, "missing-deps", `provider ${token} (useClass ${useClass}) 的部分构造依赖无法静态解析`, file, line);
      }
    }
    const injectable = cls ? parseInjectableOptions(cls, ctx) : undefined;
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
      multi: multi ?? undefined,
      providedIn: injectable?.providedIn,
      hasOnDestroy: cls?.getMethod("onDestroy") !== undefined || undefined,
      exported: exportsSet.has(token),
      file,
      line,
      importPath: cls ? modulePath(ctx.rootDir, cls.getSourceFile().getFilePath()) : undefined,
    };
  }

  if (useValueExpr) {
    return {
      token,
      tokenKind,
      kind: "value",
      useValueExpr: useValueExpr.getText(),
      scope: resolveScope({ explicit: explicitScope, tokenName: token }, ctx),
      deps: [],
      multi: multi ?? undefined,
      exported: exportsSet.has(token),
      file,
      line,
      importPath: Node.isIdentifier(useValueExpr)
        ? importPathOf(useValueExpr, ctx)
        : undefined,
    };
  }

  if (useFactoryExpr) {
    const factoryName = Node.isIdentifier(useFactoryExpr)
      ? (() => {
          const decl = resolveDeclaration(useFactoryExpr)[0];
          return decl && (Node.isFunctionDeclaration(decl) || Node.isVariableDeclaration(decl))
            ? decl.getName() ?? useFactoryExpr.getText()
            : useFactoryExpr.getText();
        })()
      : useFactoryExpr.getText();
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
      importPath: Node.isIdentifier(useFactoryExpr)
        ? importPathOf(useFactoryExpr, ctx)
        : undefined,
    };
  }

  if (useExistingExpr) {
    const target = tokenNameOf(useExistingExpr, ctx).name;
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

function parseController(
  input: Expression | ClassDeclaration,
  ctx: AnalysisContext,
): ControllerNode | undefined {
  let decl: ClassDeclaration | undefined;
  if (Node.isClassDeclaration(input)) {
    decl = input;
  } else {
    const unwrapped = unwrapForwardRef(input);
    const resolved = Node.isIdentifier(unwrapped) ? resolveDeclaration(unwrapped)[0] : undefined;
    if (resolved && Node.isClassDeclaration(resolved)) {
      decl = resolved;
    }
  }
  if (!decl) return undefined;
  const controllerDec = findDecorator(decl, "Controller");
  if (!controllerDec) return undefined;
  let path = "/";
  let standalone: boolean | undefined;
  const pathArg = controllerDec.getArguments()[0];
  if (pathArg) {
    if (Node.isStringLiteral(pathArg)) {
      path = pathArg.getLiteralText();
    } else if (Node.isObjectLiteralExpression(pathArg)) {
      const p = stringLiteralProp(pathArg, "path");
      if (p) path = p;
      standalone = booleanProp(pathArg, "standalone");
    }
  }

  const { deps, optionalDeps, selfDeps, skipSelfDeps, missing } = classDeps(decl, ctx);
  const file = sourcePath(ctx.rootDir, decl.getSourceFile().getFilePath());
  if (missing) {
    warn(ctx, "missing-deps", `controller ${decl.getName()} 的部分构造依赖无法静态解析`, file, decl.getStartLineNumber());
  }

  const injectable = parseInjectableOptions(decl, ctx);
  const routes: RouteNode[] = [];
  const schemaImports: Record<string, string> = {};
  const classGuards: string[] = [];
  for (const dec of decl.getDecorators()) {
    if (decoratorName(dec) === "UseGuards") {
      for (const gArg of dec.getArguments()) {
        classGuards.push(tokenText(gArg as Expression));
      }
    }
  }

  for (const method of decl.getMethods()) {
    for (const dec of method.getDecorators()) {
      const name = decoratorName(dec);
      const httpMethod = name ? ROUTE_DECORATORS[name] : undefined;
      if (!httpMethod) continue;
      const args = dec.getArguments();
      const pathArg = args[0];
      const routePath = pathArg && Node.isStringLiteral(pathArg) ? pathArg.getLiteralText() : "/";
      const route: RouteNode = {
        method: httpMethod,
        path: routePath,
        handler: method.getName(),
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
      let hasBodyBinding = false;
      for (const p of method.getParameters()) {
        const pName = p.getName();
        let hasBindingDecorator = false;
        for (const pDec of p.getDecorators()) {
          const dName = decoratorName(pDec);
          const dArgs = pDec.getArguments();
          if (dName === "Param") {
            hasBindingDecorator = true;
            const parsed = parseBindingOptions(dArgs, pName);
            paramBindings.push(parsed.name);
            if (parsed.transform) paramTransforms[parsed.name] = parsed.transform;
            if (parsed.default !== undefined) paramDefaults[parsed.name] = parsed.default;
          } else if (dName === "Query") {
            hasBindingDecorator = true;
            const parsed = parseBindingOptions(dArgs, pName);
            queryBindings.push(parsed.name);
            if (parsed.transform) queryTransforms[parsed.name] = parsed.transform;
            if (parsed.default !== undefined) queryDefaults[parsed.name] = parsed.default;
          } else if (dName === "Body") {
            hasBindingDecorator = true;
            hasBodyBinding = true;
          }
        }
        // Automatic route parameter binding (Angular withComponentInputBinding pattern):
        // If a method parameter name matches a route path parameter (:name) and has no explicit binding decorator,
        // automatically infer the path parameter binding and deduce its primitive transform.
        if (!hasBindingDecorator && pathParams.includes(pName)) {
          paramBindings.push(pName);
          const typeText = p.getType().getText();
          if (typeText === "number") {
            paramTransforms[pName] = "number";
          } else if (typeText === "boolean") {
            paramTransforms[pName] = "boolean";
          }
        }
      }
      if (paramBindings.length > 0) route.paramBindings = paramBindings;
      if (queryBindings.length > 0) route.queryBindings = queryBindings;
      if (Object.keys(paramTransforms).length > 0) route.paramTransforms = paramTransforms;
      if (Object.keys(paramDefaults).length > 0) route.paramDefaults = paramDefaults;
      if (Object.keys(queryTransforms).length > 0) route.queryTransforms = queryTransforms;
      if (Object.keys(queryDefaults).length > 0) route.queryDefaults = queryDefaults;
      if (hasBodyBinding) route.hasBodyBinding = true;

      const routeGuards: string[] = [...classGuards];
      const routeCanDeactivate: string[] = [];
      for (const mDec of method.getDecorators()) {
        const dName = decoratorName(mDec);
        const mArgs = mDec.getArguments();
        if (dName === "UseGuards") {
          for (const gArg of mArgs) {
            routeGuards.push(tokenText(gArg as Expression));
          }
        } else if (dName === "CanDeactivate") {
          for (const gArg of mArgs) {
            routeCanDeactivate.push(tokenText(gArg as Expression));
          }
        } else if (dName === "Title") {
          const tArg = mArgs[0];
          if (tArg && Node.isStringLiteral(tArg)) {
            route.title = tArg.getLiteralText();
          }
        } else if (dName === "Data") {
          const dArg = mArgs[0];
          if (dArg && Node.isObjectLiteralExpression(dArg)) {
            route.data = { ...route.data, ...parseObjectLiteralValues(dArg) };
          }
        } else if (dName === "Resolve") {
          const rArg = mArgs[0];
          if (rArg && Node.isObjectLiteralExpression(rArg)) {
            const resolvers: Record<string, string> = route.resolvers ?? {};
            for (const prop of rArg.getProperties()) {
              if (Node.isPropertyAssignment(prop)) {
                const rName = prop.getName();
                const init = prop.getInitializer();
                if (init) resolvers[rName] = tokenText(init);
              }
            }
            if (Object.keys(resolvers).length > 0) {
              route.resolvers = resolvers;
            }
          }
        }
      }

      const optionsArg = args[1];
      if (optionsArg && Node.isObjectLiteralExpression(optionsArg)) {
        for (const field of ["body", "params", "query", "response"] as const) {
          const schemaExpr = getProp(optionsArg, field);
          if (schemaExpr && Node.isIdentifier(schemaExpr)) {
            route[field] = schemaExpr.getText();
            const importPath = importPathOf(schemaExpr, ctx);
            if (importPath) schemaImports[schemaExpr.getText()] = importPath;
          }
        }
        const commandExpr = getProp(optionsArg, "command");
        if (commandExpr && Node.isIdentifier(commandExpr)) {
          const commandDecl = resolveDeclaration(commandExpr)[0];
          route.command = commandDecl && Node.isClassDeclaration(commandDecl)
            ? (commandDecl.getName() ?? commandExpr.getText())
            : commandExpr.getText();
        }
        const guardsExpr = getProp(optionsArg, "guards");
        if (guardsExpr && Node.isArrayLiteralExpression(guardsExpr)) {
          for (const el of guardsExpr.getElements()) {
            routeGuards.push(tokenText(el));
          }
        }
        const canMatchExpr = getProp(optionsArg, "canMatch");
        if (canMatchExpr && Node.isArrayLiteralExpression(canMatchExpr)) {
          const canMatchList: string[] = [];
          for (const el of canMatchExpr.getElements()) {
            canMatchList.push(tokenText(el));
          }
          if (canMatchList.length > 0) {
            route.canMatch = canMatchList;
          }
        }
        const canDeactivateExpr = getProp(optionsArg, "canDeactivate");
        if (canDeactivateExpr && Node.isArrayLiteralExpression(canDeactivateExpr)) {
          for (const el of canDeactivateExpr.getElements()) {
            routeCanDeactivate.push(tokenText(el));
          }
        }
        const resolversExpr = getProp(optionsArg, "resolvers");
        if (resolversExpr && Node.isObjectLiteralExpression(resolversExpr)) {
          const resolvers: Record<string, string> = {};
          for (const prop of resolversExpr.getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              const rName = prop.getName();
              const init = prop.getInitializer();
              if (init) resolvers[rName] = tokenText(init);
            }
          }
          if (Object.keys(resolvers).length > 0) {
            route.resolvers = resolvers;
          }
        }
        const redirectToExpr = getProp(optionsArg, "redirectTo");
        if (redirectToExpr && Node.isStringLiteral(redirectToExpr)) {
          route.redirectTo = redirectToExpr.getLiteralText();
        }
        const pathMatchExpr = getProp(optionsArg, "pathMatch");
        if (pathMatchExpr && Node.isStringLiteral(pathMatchExpr)) {
          const val = pathMatchExpr.getLiteralText();
          if (val === "full" || val === "prefix") {
            route.pathMatch = val;
          }
        }
        const titleExpr = getProp(optionsArg, "title");
        if (titleExpr && Node.isStringLiteral(titleExpr)) {
          route.title = titleExpr.getLiteralText();
        }
        const dataExpr = getProp(optionsArg, "data");
        if (dataExpr && Node.isObjectLiteralExpression(dataExpr)) {
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
    className: decl.getName() ?? "<anonymous>",
    path,
    scope: injectable?.scope ?? "request",
    deps,
    optionalDeps: optionalDeps.length > 0 ? optionalDeps : undefined,
    selfDeps: selfDeps.length > 0 ? selfDeps : undefined,
    skipSelfDeps: skipSelfDeps.length > 0 ? skipSelfDeps : undefined,
    standalone: standalone || undefined,
    routes,
    file,
    importPath: modulePath(ctx.rootDir, decl.getSourceFile().getFilePath()),
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
  missing: boolean;
} {
  const injectable = parseInjectableOptions(cls, ctx);
  if (injectable?.deps) {
    return {
      deps: injectable.deps,
      optionalDeps: [],
      selfDeps: [],
      skipSelfDeps: [],
      hostDeps: [],
      missing: false,
    };
  }

  const ctor = cls.getConstructors()[0];
  const deps: string[] = [];
  const optionalDeps: string[] = [];
  const selfDeps: string[] = [];
  const skipSelfDeps: string[] = [];
  const hostDeps: string[] = [];
  let missing = false;

  if (ctor && ctor.getParameters().length > 0) {
    const injectParams = parseInjectParams(cls);
    const optionalIndices = parseOptionalParams(cls);
    const selfIndices = parseModifierParams(cls, "Self");
    const skipSelfIndices = parseModifierParams(cls, "SkipSelf");
    const hostIndices = parseModifierParams(cls, "Host");
    ctor.getParameters().forEach((param, index) => {
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

  // Property-level inject() calls (Angular functional DI syntax: private foo = inject(TOKEN))
  for (const prop of cls.getProperties()) {
    const init = prop.getInitializer();
    if (init && Node.isCallExpression(init)) {
      const callName = init.getExpression().getText().split(".").pop();
      if (callName === "inject") {
        const [tokenArg, optionsArg] = init.getArguments();
        if (tokenArg) {
          const tokenName = tokenText(tokenArg as Expression);
          if (tokenName) {
            if (!deps.includes(tokenName)) deps.push(tokenName);
            if (optionsArg && Node.isObjectLiteralExpression(optionsArg)) {
              const isOptional = booleanProp(optionsArg, "optional");
              if (isOptional && !optionalDeps.includes(tokenName)) {
                optionalDeps.push(tokenName);
              }
              const isSelf = booleanProp(optionsArg, "self");
              if (isSelf && !selfDeps.includes(tokenName)) {
                selfDeps.push(tokenName);
              }
              const isSkipSelf = booleanProp(optionsArg, "skipSelf");
              if (isSkipSelf && !skipSelfDeps.includes(tokenName)) {
                skipSelfDeps.push(tokenName);
              }
              const isHost = booleanProp(optionsArg, "host");
              if (isHost && !hostDeps.includes(tokenName)) {
                hostDeps.push(tokenName);
              }
            }
          }
        }
      }
    }
  }

  return { deps, optionalDeps, selfDeps, skipSelfDeps, hostDeps, missing };
}

/** Fallback for constructor parameter type name: only used if type name references a known class or known InjectionToken variable. */
function paramTypeTokenName(param: ParameterDeclaration, ctx: AnalysisContext): string | undefined {
  const typeNode = param.getTypeNode();
  if (!typeNode) return undefined;
  const text = typeNode.getText().replace(/<.*>$/, "").replace(/\[\]$/, "").trim();
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
    scope: scope && (SCOPES as string[]).includes(scope) ? (scope as Scope) : undefined,
    providedIn: providedIn === "root" ? "root" : undefined,
    deps: depsExpr
      ? arrayProp(obj, "deps").map((el) => (ctx ? tokenNameOf(el, ctx).name : el.getText()))
      : undefined,
  };
}

/** Constructor @Inject(token) parameter decorator -> parameter index -> token name. */
function parseInjectParams(cls: ClassDeclaration): Map<number, string> {
  const result = new Map<number, string>();
  const ctor = cls.getConstructors()[0];
  if (!ctor) return result;
  ctor.getParameters().forEach((param, index) => {
    for (const dec of param.getDecorators()) {
      if (decoratorName(dec) !== "Inject") continue;
      const arg = dec.getArguments()[0];
      if (arg) result.set(index, tokenText(arg as Expression));
    }
  });
  return result;
}

/** Constructor @Optional() parameter decorator or question token -> parameter indices. */
function parseOptionalParams(cls: ClassDeclaration): Set<number> {
  const result = new Set<number>();
  const ctor = cls.getConstructors()[0];
  if (!ctor) return result;
  ctor.getParameters().forEach((param, index) => {
    for (const dec of param.getDecorators()) {
      if (decoratorName(dec) === "Optional") result.add(index);
    }
    if (param.hasQuestionToken()) result.add(index);
  });
  return result;
}

function parseModifierParams(cls: ClassDeclaration, modifierName: string): Set<number> {
  const result = new Set<number>();
  const ctor = cls.getConstructors()[0];
  if (!ctor) return result;
  ctor.getParameters().forEach((param, index) => {
    for (const dec of param.getDecorators()) {
      if (decoratorName(dec) === modifierName) result.add(index);
    }
  });
  return result;
}

function unwrapForwardRef(expr: Expression): Expression {
  if (Node.isCallExpression(expr)) {
    const exprText = expr.getExpression().getText();
    if (exprText === "forwardRef" || exprText.endsWith(".forwardRef")) {
      const arg = expr.getArguments()[0];
      if (arg && (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg))) {
        const body = arg.getBody();
        if (body && Node.isExpression(body)) {
          return unwrapForwardRef(body);
        }
      }
    }
  }
  return expr;
}

function tokenText(expr: Expression): string {
  const unwrapped = unwrapForwardRef(expr);
  if (Node.isStringLiteral(unwrapped)) return unwrapped.getLiteralText();
  if (Node.isIdentifier(unwrapped)) {
    const decl = resolveDeclaration(unwrapped)[0];
    if (decl && Node.isClassDeclaration(decl)) return decl.getName() ?? unwrapped.getText();
    if (decl && Node.isVariableDeclaration(decl)) return decl.getName();
  }
  return unwrapped.getText();
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
  if (Node.isIdentifier(unwrapped)) {
    const decl = resolveDeclaration(unwrapped)[0];
    if (decl && Node.isClassDeclaration(decl)) {
      return { name: decl.getName() ?? expr.getText(), kind: "class" };
    }
    if (decl && Node.isVariableDeclaration(decl)) {
      const name = decl.getName();
      return { name, kind: ctx.tokensByName.has(name) ? "injection-token" : "class" };
    }
    if (ctx.tokensByName.has(expr.getText())) {
      return { name: expr.getText(), kind: "injection-token" };
    }
  }
  return { name: expr.getText(), kind: "class" };
}

/** Resolves identifier to its declarations (following import aliases). */
function resolveDeclaration(id: Identifier): Node[] {
  let symbol: TsSymbol | undefined = id.getSymbol();
  if (!symbol) return [];
  let declarations = symbol.getDeclarations();
  for (let guard = 0; guard < 4; guard += 1) {
    const isAlias = declarations.some(
      (d) =>
        Node.isImportSpecifier(d) || Node.isImportClause(d) || Node.isNamespaceImport(d),
    );
    if (!isAlias) break;
    const aliased: TsSymbol | undefined = symbol.getAliasedSymbol();
    if (!aliased) break;
    symbol = aliased;
    declarations = aliased.getDeclarations();
  }
  return declarations;
}

/** File path where identifier is defined (relative to rootDir, stripped of extension) for import generation. */
function importPathOf(id: Identifier, ctx: AnalysisContext): string | undefined {
  const symbol = id.getSymbol();
  const first = symbol?.getDeclarations()[0];
  if (first && (Node.isImportSpecifier(first) || Node.isImportClause(first))) {
    const importDecl = first.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const target = importDecl?.getModuleSpecifierSourceFile();
    if (target) return modulePath(ctx.rootDir, target.getFilePath());
  }
  const decl = resolveDeclaration(id)[0];
  if (decl) return modulePath(ctx.rootDir, decl.getSourceFile().getFilePath());
  return undefined;
}

function findDecorator(cls: ClassDeclaration, name: string): Decorator | undefined {
  return cls.getDecorators().find((dec) => decoratorName(dec) === name);
}

function decoratorName(dec: Decorator): string | undefined {
  const expr = dec.getExpression();
  if (Node.isCallExpression(expr)) {
    return expr.getExpression().getText().split(".").pop();
  }
  if (Node.isIdentifier(expr)) return expr.getText();
  return undefined;
}

function decoratorObjectArg(dec: Decorator): ObjectLiteralExpression | undefined {
  const expr = dec.getExpression();
  if (!Node.isCallExpression(expr)) return undefined;
  const arg = expr.getArguments()[0];
  return arg && Node.isObjectLiteralExpression(arg) ? arg : undefined;
}

function getProp(obj: ObjectLiteralExpression, name: string): Expression | undefined {
  const prop = obj.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  return undefined;
}

function stringLiteralProp(obj: ObjectLiteralExpression, name: string): string | undefined {
  const expr = getProp(obj, name);
  return expr && Node.isStringLiteral(expr) ? expr.getLiteralText() : undefined;
}

function arrayProp(obj: ObjectLiteralExpression, name: string): Expression[] {
  const expr = getProp(obj, name);
  return expr && Node.isArrayLiteralExpression(expr) ? expr.getElements() : [];
}

function booleanProp(obj: ObjectLiteralExpression, name: string): boolean | undefined {
  const expr = getProp(obj, name);
  if (!expr) return undefined;
  if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
  if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function parseScopeProp(obj: ObjectLiteralExpression): Scope | undefined {
  const scope = stringLiteralProp(obj, "scope");
  return scope && (SCOPES as string[]).includes(scope) ? (scope as Scope) : undefined;
}

function parseBindingOptions(args: Node[], defaultName: string): {
  name: string;
  transform?: "number" | "boolean" | "string";
  default?: unknown;
} {
  let name = defaultName;
  let transform: "number" | "boolean" | "string" | undefined;
  let defaultValue: unknown;

  const first = args[0];
  const second = args[1];

  if (first && Node.isStringLiteral(first)) {
    name = first.getLiteralText();
  } else if (first && Node.isObjectLiteralExpression(first)) {
    const nameProp = getProp(first, "name");
    if (nameProp && Node.isStringLiteral(nameProp)) {
      name = nameProp.getLiteralText();
    }
    const trProp = getProp(first, "transform");
    if (trProp && Node.isStringLiteral(trProp)) {
      const val = trProp.getLiteralText();
      if (val === "number" || val === "boolean" || val === "string") {
        transform = val;
      }
    }
    const defProp = getProp(first, "default");
    if (defProp) {
      defaultValue = parseLiteralValue(defProp);
    }
  }

  if (second && Node.isObjectLiteralExpression(second)) {
    const trProp = getProp(second, "transform");
    if (trProp && Node.isStringLiteral(trProp)) {
      const val = trProp.getLiteralText();
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

function parseLiteralValue(node: Node): unknown {
  if (Node.isStringLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (node.getKindName() === "TrueKeyword") return true;
  if (node.getKindName() === "FalseKeyword") return false;
  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().map(parseLiteralValue);
  }
  if (Node.isObjectLiteralExpression(node)) {
    return parseObjectLiteralValues(node);
  }
  return undefined;
}

function parseObjectLiteralValues(obj: ObjectLiteralExpression): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getName();
      const init = prop.getInitializer();
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
