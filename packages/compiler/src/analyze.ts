import { existsSync } from "node:fs";
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
  CommandNode,
  ControllerNode,
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
};
const SCOPES: Scope[] = ["application", "request", "job"];

interface TokenInfo {
  /** 变量名，如 CASE_REPOSITORY。 */
  name: string;
  /** InjectionToken 字符串 name，如 "supacloud.case-repository"。 */
  stringName?: string;
  scope?: Scope;
  file: string;
}

interface ClassInfo {
  name: string;
  decl: ClassDeclaration;
  file: string;
}

/** 分析上下文：全项目符号索引 + 诊断收集。 */
interface AnalysisContext {
  rootDir: string;
  tokensByName: Map<string, TokenInfo>;
  classesByName: Map<string, ClassInfo>;
  diagnostics: Diagnostic[];
}

/**
 * 分析 rootDir 下的源码（ts-morph AST，无类型检查依赖），构建 ApplicationGraph。
 * 装饰器仅按名字匹配（Module/Injectable/Inject/Command/Query/Controller/Get/...），
 * 不校验 import 来源，因此本包不需要依赖 @supacloud/app。
 */
export async function analyzeProject(
  rootDir: string,
  include?: string[],
): Promise<ApplicationGraph> {
  const project = createProject(rootDir);
  const patterns = (include ?? DEFAULT_INCLUDE).map((glob) => join(rootDir, glob));
  project.addSourceFilesAtPaths(patterns);
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

  // 第一遍：发现全部模块候选（@Module 类 / defineModule 调用），先登记名字，
  // 以便 imports 能把模块类引用解析成模块 name。
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

  const modules = candidates.map((c) => parseModule(c, nameByNode, ctx));

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

/** 索引文件中的 InjectionToken 变量与类声明。 */
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

/** 解析 `const X = new InjectionToken("name", { scope })` 变量定义。 */
function parseTokenVariable(decl: VariableDeclaration, file: string): TokenInfo | undefined {
  const init = decl.getInitializer();
  if (!init || !Node.isNewExpression(init)) return undefined;
  if (init.getExpression().getText() !== "InjectionToken") return undefined;
  const [nameArg, optionsArg] = init.getArguments();
  const info: TokenInfo = { name: decl.getName(), file };
  if (nameArg && Node.isStringLiteral(nameArg)) {
    info.stringName = nameArg.getLiteralText();
  }
  if (optionsArg && Node.isObjectLiteralExpression(optionsArg)) {
    const scope = stringLiteralProp(optionsArg, "scope");
    if (scope && (SCOPES as string[]).includes(scope)) {
      info.scope = scope as Scope;
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

  const imports = arrayProp(options, "imports")
    .map((el) => {
      const decl = Node.isIdentifier(el) ? resolveDeclaration(el)[0] : undefined;
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

  // @Command/@Query：providers（裸类或 useClass）+ commands/queries 数组中带装饰器的类。
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
          transaction: stringLiteralProp(meta, "transaction"),
          audit: stringLiteralProp(meta, "audit"),
          idempotency: stringLiteralProp(meta, "idempotency"),
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

function parseProvider(
  el: Expression,
  exportsSet: Set<string>,
  ctx: AnalysisContext,
): ProviderNode | undefined {
  const file = sourcePath(ctx.rootDir, el.getSourceFile().getFilePath());
  const line = el.getStartLineNumber();

  // 裸类引用 → class provider，token = 类名
  if (Node.isIdentifier(el)) {
    const decl = resolveDeclaration(el)[0];
    const cls = decl && Node.isClassDeclaration(decl) ? decl : undefined;
    const className = cls?.getName() ?? el.getText();
    const { deps, missing } = cls ? classDeps(cls, ctx) : { deps: [], missing: false };
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

  const useClassExpr = getProp(el, "useClass");
  const useValueExpr = getProp(el, "useValue");
  const useFactoryExpr = getProp(el, "useFactory");
  const useExistingExpr = getProp(el, "useExisting");

  if (useClassExpr) {
    const decl = Node.isIdentifier(useClassExpr) ? resolveDeclaration(useClassExpr)[0] : undefined;
    const cls = decl && Node.isClassDeclaration(decl) ? decl : undefined;
    const useClass = cls?.getName() ?? useClassExpr.getText();
    let deps = explicitDeps;
    if (deps.length === 0 && cls) {
      const result = classDeps(cls, ctx);
      deps = result.deps;
      if (result.missing) {
        warn(ctx, "missing-deps", `provider ${token} (useClass ${useClass}) 的部分构造依赖无法静态解析`, file, line);
      }
    }
    return {
      token,
      tokenKind,
      kind: "class",
      useClass,
      scope: resolveScope({ explicit: explicitScope, cls, tokenName: token }, ctx),
      deps,
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
      exported: exportsSet.has(token),
      file,
      line,
    };
  }

  return undefined;
}

function parseController(el: Expression, ctx: AnalysisContext): ControllerNode | undefined {
  if (!Node.isIdentifier(el)) return undefined;
  const decl = resolveDeclaration(el)[0];
  if (!decl || !Node.isClassDeclaration(decl)) return undefined;
  const controllerDec = findDecorator(decl, "Controller");
  if (!controllerDec) return undefined;
  const pathArg = controllerDec.getArguments()[0];
  const path = pathArg && Node.isStringLiteral(pathArg) ? pathArg.getLiteralText() : "/";

  const { deps, missing } = classDeps(decl, ctx);
  const file = sourcePath(ctx.rootDir, decl.getSourceFile().getFilePath());
  if (missing) {
    warn(ctx, "missing-deps", `controller ${decl.getName()} 的部分构造依赖无法静态解析`, file, decl.getStartLineNumber());
  }

  const injectable = parseInjectableOptions(decl, ctx);
  const routes: RouteNode[] = [];
  const schemaImports: Record<string, string> = {};
  for (const method of decl.getMethods()) {
    for (const dec of method.getDecorators()) {
      const name = decoratorName(dec);
      const httpMethod = name ? ROUTE_DECORATORS[name] : undefined;
      if (!httpMethod) continue;
      const args = dec.getArguments();
      const pathArg = args[0];
      const route: RouteNode = {
        method: httpMethod,
        path: pathArg && Node.isStringLiteral(pathArg) ? pathArg.getLiteralText() : "/",
        handler: method.getName(),
      };
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
      }
      routes.push(route);
    }
  }

  return {
    className: decl.getName() ?? "<anonymous>",
    path,
    scope: injectable?.scope ?? "request",
    deps,
    routes,
    file,
    importPath: modulePath(ctx.rootDir, decl.getSourceFile().getFilePath()),
    schemaImports: Object.keys(schemaImports).length > 0 ? schemaImports : undefined,
  };
}

/**
 * 类 provider / controller 的依赖解析：
 * @Injectable({ deps }) > 构造函数 @Inject 参数装饰器 > 构造函数参数类型名
 * （仅当类型名是已知类/已知 token 时），解析不了标记 missing。
 */
function classDeps(cls: ClassDeclaration, ctx: AnalysisContext): { deps: string[]; missing: boolean } {
  const injectable = parseInjectableOptions(cls, ctx);
  if (injectable?.deps) return { deps: injectable.deps, missing: false };

  const ctor = cls.getConstructors()[0];
  if (!ctor || ctor.getParameters().length === 0) return { deps: [], missing: false };

  const injectParams = parseInjectParams(cls);
  const deps: string[] = [];
  let missing = false;
  ctor.getParameters().forEach((param, index) => {
    const injected = injectParams.get(index);
    if (injected) {
      deps.push(injected);
      return;
    }
    const byType = paramTypeTokenName(param, ctx);
    if (byType) {
      deps.push(byType);
    } else {
      missing = true;
    }
  });
  return { deps, missing };
}

/** 构造函数参数类型名回退：仅当类型名引用了已知类或已知 InjectionToken 变量时采用。 */
function paramTypeTokenName(param: ParameterDeclaration, ctx: AnalysisContext): string | undefined {
  const typeNode = param.getTypeNode();
  if (!typeNode) return undefined;
  const text = typeNode.getText().replace(/<.*>$/, "").replace(/\[\]$/, "").trim();
  if (ctx.classesByName.has(text)) return text;
  if (ctx.tokensByName.has(text)) return text;
  return undefined;
}

// ---------------------------------------------------------------------------
// AST 工具
// ---------------------------------------------------------------------------

function parseInjectableOptions(
  cls: ClassDeclaration,
  ctx?: AnalysisContext,
): { scope?: Scope; deps?: string[] } | undefined {
  const dec = findDecorator(cls, "Injectable");
  if (!dec) return undefined;
  const obj = decoratorObjectArg(dec);
  if (!obj) return {};
  const scope = stringLiteralProp(obj, "scope");
  const depsExpr = getProp(obj, "deps");
  return {
    scope: scope && (SCOPES as string[]).includes(scope) ? (scope as Scope) : undefined,
    deps: depsExpr
      ? arrayProp(obj, "deps").map((el) => (ctx ? tokenNameOf(el, ctx).name : el.getText()))
      : undefined,
  };
}

/** 构造函数 @Inject(token) 参数装饰器 → 参数下标 → token 名。 */
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

function tokenText(expr: Expression): string {
  if (Node.isIdentifier(expr)) {
    const decl = resolveDeclaration(expr)[0];
    if (decl && Node.isClassDeclaration(decl)) return decl.getName() ?? expr.getText();
    if (decl && Node.isVariableDeclaration(decl)) return decl.getName();
  }
  return expr.getText();
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

/** identifier → token 名 + 类别（跨 import 解析到声明）。 */
function tokenNameOf(expr: Expression, ctx: AnalysisContext): { name: string; kind: TokenKind } {
  if (Node.isIdentifier(expr)) {
    const decl = resolveDeclaration(expr)[0];
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

/** 解析标识符到其声明（跟随 import alias）。 */
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

/** 标识符定义处的文件路径（rootDir 相对、去扩展名），供生成 import。 */
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

function parseScopeProp(obj: ObjectLiteralExpression): Scope | undefined {
  const scope = stringLiteralProp(obj, "scope");
  return scope && (SCOPES as string[]).includes(scope) ? (scope as Scope) : undefined;
}

/** 绝对路径 → rootDir 相对、posix 风格、去扩展名的模块路径（供生成 import）。 */
function modulePath(rootDir: string, absFile: string): string {
  return sourcePath(rootDir, absFile).replace(/\.(ts|tsx|js|mts|cts)$/, "");
}

/** 绝对路径 → rootDir 相对、posix 风格的源文件路径（保留扩展名，供诊断定位）。 */
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
