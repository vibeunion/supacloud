/**
 * ApplicationGraph：编译器从源码 AST 构建出的静态应用图。
 * 运行期不反射、无容器，所有信息都在该结构与生成代码中显式给出。
 */

export type Scope = "application" | "request" | "job";

export type ProviderKind = "class" | "value" | "factory" | "existing";

export type TokenKind = "injection-token" | "class";

export interface Diagnostic {
  severity: "error" | "warn";
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ProviderNode {
  /** token 名（InjectionToken 变量名或类名）。 */
  token: string;
  tokenKind: TokenKind;
  kind: ProviderKind;
  useClass?: string;
  useValueExpr?: string;
  useFactoryName?: string;
  useExisting?: string;
  scope: Scope;
  /** token 名，构造/工厂参数顺序。 */
  deps: string[];
  exported: boolean;
  file: string;
  line: number;
  /** useClass/useFactory/useValue 符号的模块相对路径（供生成 import）。 */
  importPath?: string;
}

export interface RouteNode {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: string;
  body?: string;
  params?: string;
  query?: string;
  response?: string;
  /** @Command-decorated class explicitly bound by the route. */
  command?: string;
}

export interface ControllerNode {
  className: string;
  path: string;
  scope: Scope;
  deps: string[];
  routes: RouteNode[];
  file: string;
  importPath: string;
  /** 路由 schema 符号名 → 模块相对路径（供生成 import）。 */
  schemaImports?: Record<string, string>;
}

export interface CommandNode {
  className: string;
  name: string;
  permission?: string;
  transaction: "required" | "none";
  audit?: string;
  idempotency: "required" | "none";
}

export interface QueryNode {
  className: string;
  name: string;
}

export interface ModuleNode {
  /** @Module({ name }) 或 defineModule 的 name。 */
  name: string;
  className: string;
  file: string;
  line: number;
  /** 被 import 模块的 name。 */
  imports: string[];
  providers: ProviderNode[];
  controllers: ControllerNode[];
  commands: CommandNode[];
  queries: QueryNode[];
  /** 导出的 token 名。 */
  exports: string[];
}

export interface ApplicationGraph {
  modules: ModuleNode[];
  /** 被依赖但无任何模块提供的 token 名（平台注入）。 */
  externalTokens: string[];
  /**
   * 分析阶段产生的诊断（如 missing-deps），由 compileProject 合并进结果。
   * 不写入 app.manifest.json。
   */
  diagnostics?: Diagnostic[];
  /**
   * InjectionToken 变量名 → 字符串 name（如 REQUEST_CONTEXT →
   * "supacloud.request-context"），供代码生成识别内置上下文 token。
   * 不写入 app.manifest.json。
   */
  tokenNames?: Record<string, string>;
}

export interface CompileOptions {
  /** 项目根（含 tsconfig）。 */
  rootDir: string;
  /** glob，默认 ['**\/*.module.ts', '**\/*.ts']。 */
  include?: string[];
  /** 生成目录（如 <rootDir>/generated）。 */
  outDir: string;
  /** warn 级诊断升级为 error。 */
  strict?: boolean;
}

export interface CompileResult {
  diagnostics: Diagnostic[];
  graph: ApplicationGraph;
  written: string[];
}
