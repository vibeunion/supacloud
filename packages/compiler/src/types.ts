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
  /** 模块标签（如 ['scope:case', 'type:feature']），用于架构边界治理。 */
  tags?: string[];
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
  /** Built-in architecture boundary preset (for example, 'modular-monolith'). */
  moduleBoundaryPreset?: ModuleBoundaryPresetName;
  /** Module boundary and architecture governance rules inspired by Nx enforce-module-boundaries. */
  moduleBoundaries?: ModuleBoundaryRule[];
  /** 是否允许路由级直接绑定 @Command（默认 true；设为 false 时禁止路由级绑定，强制走应用服务层）。 */
  allowRouteCommandBindings?: boolean;
  /** 运行期 Command 执行器能力声明（用于防范编译期“元数据剧场”）。 */
  commandCapabilities?: CommandExecutionCapabilities;
  /** Disallow controllers from directly injecting DB clients (enforces presentation layer separation). */
  disallowControllerDirectDb?: boolean;
  /** Detect modules declared in the project that are unreachable from any root module. */
  detectOrphanModules?: boolean;
}

export interface ModuleBoundaryRule {
  /** Source module tag pattern or tag (for example, 'type:ui', 'scope:case', or '*'). */
  sourceTag: string;
  /** Tags allowed for modules imported by the source module. */
  onlyDependOnLibsWithTags?: string[];
  /** Tags forbidden for modules imported by the source module. */
  bannedDependenciesWithTags?: string[];
}

/** Names of built-in module boundary presets. */
export type ModuleBoundaryPresetName =
  | "modular-monolith"
  | "feature-slices"
  | "vertical-slices"
  | "angular-enterprise"
  | "angular"
  | "clean-architecture"
  | "domain-driven";

export interface ModuleBoundaryProfile {
  name: ModuleBoundaryPresetName;
  description: string;
  rules: ModuleBoundaryRule[];
}

export interface ValidateOptions {
  strict?: boolean;
  moduleBoundaryPreset?: ModuleBoundaryPresetName;
  moduleBoundaries?: ModuleBoundaryRule[];
  /** 是否允许路由级直接绑定 @Command（默认 true；设为 false 时禁止路由级绑定，强制走应用服务层）。 */
  allowRouteCommandBindings?: boolean;
  /** 运行期 Command 执行器能力声明（用于防范编译期“元数据剧场”）。 */
  commandCapabilities?: CommandExecutionCapabilities;
  /** Disallow controllers from directly injecting DB clients. */
  disallowControllerDirectDb?: boolean;
  /** Detect modules declared in the project that are unreachable from any root module. */
  detectOrphanModules?: boolean;
}

/** Command 执行器运行期能力配置。 */
export interface CommandExecutionCapabilities {
  /** 是否支持权限判定。若为 false 而命令声明了 permission，则报 error。 */
  permission?: boolean;
  /** 是否支持审计日志。若为 false 而命令声明了 audit，则报 error。 */
  audit?: boolean;
  /** 是否支持幂等。若为 false 而命令声明了 idempotency: 'required'，则报 error。 */
  idempotency?: boolean;
  /**
   * 事务执行能力：
   * - true: 支持完整事务边界；
   * - 'rpc-only': 不支持应用级事务，事务必须落在单个 DB RPC 内（声明 transaction: 'required' 时报 warn）；
   * - false: 事务支持已禁用（声明 transaction: 'required' 时报 error）。
   */
  transaction?: boolean | "rpc-only";
}

export interface CompileResult {
  diagnostics: Diagnostic[];
  graph: ApplicationGraph;
  written: string[];
}

export interface CheckProjectResult {
  /** 产物是否完全与磁盘一致且未漂移。 */
  upToDate: boolean;
  /** 不一致或缺失的产物相对路径列表。 */
  mismatches: string[];
  diagnostics: Diagnostic[];
  graph: ApplicationGraph;
}
