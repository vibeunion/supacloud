/**
 * ApplicationGraph: Static application graph built by the compiler from source AST.
 * No runtime reflection or container; all metadata is explicitly represented here and in generated code.
 */

import type { IncrementalProgramSession } from "./program";

export type Scope = "application" | "request" | "job";

export type ProviderKind = "class" | "value" | "factory" | "existing";

export type TokenKind = "injection-token" | "class";

export interface FunctionalInjectNode {
  /** Logical token name used by the application graph. */
  token: string;
  /** Source expression used to identify the runtime token. */
  expression: string;
  /** Relative source module path for the token expression. */
  importPath?: string;
  /** Package module specifier for a library token. */
  importModule?: string;
  optional?: boolean;
  self?: boolean;
  skipSelf?: boolean;
  host?: boolean;
}

export interface AspectRefNode {
  /** Exported symbol name used in the generated static import. */
  name: string;
  /** Source expression retained for diagnostics and manifest inspection. */
  expression: string;
  /** Relative source module path for a project-local aspect. */
  importPath?: string;
  /** Package module specifier for a library aspect. */
  importModule?: string;
}

export interface Diagnostic {
  severity: "error" | "warn";
  code: string;
  message: string;
  file?: string;
  line?: number;
  /** Actionable Angular Ivy-style remediation hint. */
  suggestion?: string;
  /** Standardized compiler diagnostic code (e.g. SC1001) modeled after Angular ngtsc error codes. */
  errorCode?: string;
  /** Documentation URL for this diagnostic. */
  docsUrl?: string;
}

export interface ProviderNode {
  /** Token name (InjectionToken variable name or class name). */
  token: string;
  tokenKind: TokenKind;
  kind: ProviderKind;
  useClass?: string;
  useValueExpr?: string;
  useFactoryName?: string;
  useExisting?: string;
  scope: Scope;
  /** Token names in constructor/factory parameter order. */
  deps: string[];
  /** Parameter tokens that are marked @Optional() (receive undefined if unresolved). */
  optionalDeps?: string[];
  /** Parameter tokens marked @Self() (must be resolved from current module's own providers). */
  selfDeps?: string[];
  /** Parameter tokens marked @SkipSelf() (must NOT be resolved from current module's own providers). */
  skipSelfDeps?: string[];
  /** Parameter tokens marked @Host(). */
  hostDeps?: string[];
  /** Property-level Angular functional inject() calls compiled into a static context. */
  functionalInjects?: FunctionalInjectNode[];
  /** When true, multiple providers can contribute to this token as an array of instances (Angular multi-providers). */
  multi?: boolean;
  /** Automatically provided in the root injector context without manual module declaration (Angular-style). */
  providedIn?: "root";
  /** Class implements OnDestroy interface or onDestroy method. */
  hasOnDestroy?: boolean;
  exported: boolean;
  file: string;
  line: number;
  /** Relative module path of useClass/useFactory/useValue symbol (for import generation). */
  importPath?: string;
  /** Package module specifier for providers supplied by a library. */
  importModule?: string;
}

export interface HandlerParamNode {
  name: string;
  kind: "param" | "query" | "body" | "headers" | "context" | "unknown";
  bindingName?: string;
  transform?: "number" | "boolean" | "string";
  default?: unknown;
}

export interface RouteNode {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
  handler: string;
  body?: string;
  params?: string;
  query?: string;
  response?: string;
  /** @Command-decorated class explicitly bound by the route. */
  command?: string;
  /** Route guards executed before handler (Angular CanActivateFn style). */
  guards?: string[];
  /** Route matching guards executed before route activation (Angular CanMatchFn style). */
  canMatch?: string[];
  /** Route deactivation guards executed before leaving route (Angular CanDeactivateFn style). */
  canDeactivate?: string[];
  /** Route resolvers executed before handler (Angular ResolveFn style). */
  resolvers?: Record<string, string>;
  /** Route redirect target (Angular Router style). */
  redirectTo?: string;
  /** Route redirect matching rule (Angular Router style). */
  pathMatch?: "full" | "prefix";
  /** Path parameters parsed from route path (e.g. :id -> 'id'). */
  pathParams?: string[];
  /** Handler method parameter bindings declared via @Param('name'). */
  paramBindings?: string[];
  /** Handler method query bindings declared via @Query('name'). */
  queryBindings?: string[];
  /** Handler method has @Body() binding. */
  hasBodyBinding?: boolean;
  /** Parameter transforms declared via @Param({ transform: ... }) */
  paramTransforms?: Record<string, "number" | "boolean" | "string">;
  /** Parameter defaults declared via @Param({ default: ... }) */
  paramDefaults?: Record<string, unknown>;
  /** Query transforms declared via @Query({ transform: ... }) */
  queryTransforms?: Record<string, "number" | "boolean" | "string">;
  /** Query defaults declared via @Query({ default: ... }) */
  queryDefaults?: Record<string, unknown>;
  /** Route title (Angular Route.title style). */
  title?: string;
  /** Route static metadata dictionary (Angular Route.data style). */
  data?: Record<string, unknown>;
  /** Detailed method parameter metadata for compile-time typed invoker generation. */
  handlerParams?: HandlerParamNode[];
  /** Explicit aspects applied around this route. */
  aspects?: AspectRefNode[];
}

export interface ControllerNode {
  className: string;
  path: string;
  scope: Scope;
  deps: string[];
  /** Class implements OnDestroy interface or onDestroy method. */
  hasOnDestroy?: boolean;
  /** Parameter tokens marked @Optional(). */
  optionalDeps?: string[];
  selfDeps?: string[];
  skipSelfDeps?: string[];
  /** Parameter tokens marked @Host(). */
  hostDeps?: string[];
  /** Property-level Angular functional inject() calls compiled into a static context. */
  functionalInjects?: FunctionalInjectNode[];
  /** Automatically registered without manual module declaration (Angular standalone controller style). */
  standalone?: boolean;
  routes: RouteNode[];
  file: string;
  importPath: string;
  /** Route schema symbol name -> relative module path (for import generation). */
  schemaImports?: Record<string, string>;
}

export interface CommandNode {
  className: string;
  name: string;
  permission?: string;
  transaction: "required" | "none";
  audit?: string;
  idempotency: "required" | "none";
  /** Automatically registered without manual module declaration. */
  standalone?: boolean;
  /** Explicit aspects applied around this command. */
  aspects?: AspectRefNode[];
}

export interface JobNode {
  className: string;
  name: string;
  scope: Scope;
  aspects?: AspectRefNode[];
}

export interface QueryNode {
  className: string;
  name: string;
}

export interface ModuleNode {
  /** Name from @Module({ name }) or defineModule. */
  name: string;
  className: string;
  /** Module tags (e.g. ['scope:case', 'type:feature']) for architecture boundary governance. */
  tags?: string[];
  file: string;
  line: number;
  /** Names of imported modules. */
  imports: string[];
  providers: ProviderNode[];
  controllers: ControllerNode[];
  commands: CommandNode[];
  jobs?: JobNode[];
  queries: QueryNode[];
  /** Explicit aspects applied to all routes and commands in this module. */
  aspects?: AspectRefNode[];
  /** Exported token names. */
  exports: string[];
}

export interface ApplicationGraph {
  modules: ModuleNode[];
  /** Depended token names provided by platform injection rather than any module. */
  externalTokens: string[];
  /**
   * Diagnostics produced during analysis (e.g. missing-deps), merged by compileProject.
   * Omitted from app.manifest.json.
   */
  diagnostics?: Diagnostic[];
  /**
   * InjectionToken variable name -> string name (e.g. REQUEST_CONTEXT ->
   * "supacloud.request-context"), used during code generation to identify built-in context tokens.
   * Omitted from app.manifest.json.
   */
  tokenNames?: Record<string, string>;
  /** Incremental cache statistics (modules reused vs reanalyzed). */
  cacheStats?: {
    reusedModules: string[];
    reanalyzedModules: string[];
  };
}

export interface CompileOptions {
  /** Project root directory (containing tsconfig). */
  rootDir: string;
  /** Glob patterns, defaults to ['**\/*.module.ts', '**\/*.ts']. */
  include?: string[];
  /** Output directory (e.g. <rootDir>/generated). */
  outDir: string;
  /** Upgrade warn-level diagnostics to error. */
  strict?: boolean;
  /** Built-in architecture boundary preset (for example, 'modular-monolith'). */
  moduleBoundaryPreset?: ModuleBoundaryPresetName;
  /** Module boundary and architecture governance rules inspired by Nx enforce-module-boundaries. */
  moduleBoundaries?: ModuleBoundaryRule[];
  /** Allow routes to bind directly to @Command (defaults to true). */
  allowRouteCommandBindings?: boolean;
  /** Runtime Command executor capabilities used to validate declared governance metadata. */
  commandCapabilities?: CommandExecutionCapabilities;
  /** Disallow controllers from directly injecting DB clients (enforces presentation layer separation). */
  disallowControllerDirectDb?: boolean;
  /** Detect modules declared in the project that are unreachable from any root module. */
  detectOrphanModules?: boolean;
  /** Write generated artifacts even when error-level diagnostics exist (default: true). */
  writeOnError?: boolean;
  /** Generate typed API client in client.ts (default: false). */
  generateClient?: boolean;
  /** Generate typed permissions registry in permissions.ts (default: false). */
  generatePermissions?: boolean;
  /** Prune unused root providers from compiled output (Angular Ivy AOT tree-shaking). */
  treeShakeUnusedProviders?: boolean;
  /** Incremental dependency graph cache. */
  cache?: DependencyGraphCache;
  /**
   * Changed source paths supplied by the watch/incremental driver.
   * This is an implementation hint and does not change the public graph shape.
   */
  changedPaths?: string[];
  /** Type-safety gates for generated artifacts and production source. */
  typeSafety?: TypeSafetyOptions;
}

export interface TypeSafetyOptions {
  /** Reject the `any` keyword in generated TypeScript artifacts. */
  noAnyInGenerated?: boolean;
  /** Scan non-test production source for unsafe type escapes and widening. */
  scanProductionSource?: boolean;
  /** Additional relative glob patterns excluded from the production-source scan. */
  exclude?: string[];
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
  /** Allow routes to bind directly to @Command (defaults to true). */
  allowRouteCommandBindings?: boolean;
  /** Runtime Command executor capabilities used to validate declared governance metadata. */
  commandCapabilities?: CommandExecutionCapabilities;
  /** Disallow controllers from directly injecting DB clients. */
  disallowControllerDirectDb?: boolean;
  /** Detect modules declared in the project that are unreachable from any root module. */
  detectOrphanModules?: boolean;
}

/** Runtime capabilities declared by the Command executor. */
export interface CommandExecutionCapabilities {
  /** Whether runtime permission checks are supported. */
  permission?: boolean;
  /** Whether runtime audit persistence is supported. */
  audit?: boolean;
  /** Whether idempotency receipts are supported. */
  idempotency?: boolean;
  /**
   * Transaction execution capability:
   * - true: full transaction boundaries are supported;
   * - 'rpc-only': application-level transactions are unavailable and multi-table writes must use one DB RPC (warn);
   * - false: transaction support is disabled (error).
   */
  transaction?: boolean | "rpc-only";
}

export interface CompileResult {
  diagnostics: Diagnostic[];
  graph: ApplicationGraph;
  written: string[];
  stats?: CompileStats;
}

export interface CompileStats {
  cacheHit: boolean;
  changedFiles: string[];
  affectedModules: string[];
  reanalyzedModules?: string[];
  reusedModules?: string[];
}

export interface CheckProjectResult {
  /** Whether generated artifacts exactly match the files on disk. */
  upToDate: boolean;
  /** Relative paths of missing or mismatched artifacts. */
  mismatches: string[];
  diagnostics: Diagnostic[];
  graph: ApplicationGraph;
}

export interface WatchEvent {
  type: "compile-start" | "compiled" | "compile-error";
  initial: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  written: string[];
  stats?: CompileStats;
}

export interface WatchOptions extends CompileOptions {
  /** Debounce source changes before starting a compile (default: 100ms). */
  debounceMs?: number;
  onEvent?: (event: WatchEvent) => void;
}

export interface WatchHandle {
  /** Resolves after the initial compile has completed. */
  ready: Promise<WatchEvent>;
  close(): Promise<void>;
}

export interface CachedModuleEntry {
  module: ModuleNode;
  /** Files owned by this module (normalized relative paths). */
  ownedFiles: string[];
  /** File hash mapping for owned files. */
  fileHashes: Record<string, string>;
  /** Diagnostics captured during this module's analysis. */
  diagnostics?: Diagnostic[];
}

export interface DependencyGraphCache {
  /** Cached modules by module name. */
  modules: Map<string, CachedModuleEntry>;
  /** Global file hashes by relative file path. */
  fileHashes: Map<string, string>;
  /** Retained native TypeScript BuilderProgram session. */
  programSession?: IncrementalProgramSession;
  /** Retained module dependency graph tracking imports and reverse dependents. */
  dependencyGraph?: DependencyGraphIndex;
  /** Content hashes for generated artifacts, used by the incremental emitter. */
  generatedHashes?: Map<string, string>;
  lastStats?: {
    reusedModules: string[];
    reanalyzedModules: string[];
  };
}

export interface DependencyGraphIndex {
  getAffectedModules(changedFiles: string[]): string[];
}
