import type { Provider, Token, Type } from "./provider";
import type { EnvironmentProviders } from "./provider";
import { flattenProviders } from "./provider";
import type { Scope } from "./scope";
import { DEFAULT_SCOPE } from "./scope";

/**
 * Decorator metadata keys. Metadata is attached as static properties on the
 * decorated class so the SupaCloud compiler can read it from the AST *and*
 * tooling can read it at runtime without reflect-metadata.
 */
export const INJECTABLE_METADATA = "supacloud:injectable";
export const MODULE_METADATA = "supacloud:module";
export const COMMAND_METADATA = "supacloud:command";
export const QUERY_METADATA = "supacloud:query";
export const CONTROLLER_METADATA = "supacloud:controller";
export const ROUTES_METADATA = "supacloud:routes";
export const INJECT_PARAMS_METADATA = "supacloud:inject-params";
export const OPTIONAL_PARAMS_METADATA = "supacloud:optional-params";
export const SELF_PARAMS_METADATA = "supacloud:self-params";
export const SKIP_SELF_PARAMS_METADATA = "supacloud:skip-self-params";
export const HOST_PARAMS_METADATA = "supacloud:host-params";
export const GUARDS_METADATA = "supacloud:guards";
export const CAN_DEACTIVATE_METADATA = "supacloud:guards:can-deactivate";
export const RESOLVE_METADATA = "supacloud:resolvers";
export const TITLE_METADATA = "supacloud:route:title";
export const DATA_METADATA = "supacloud:route:data";
export const ROUTE_PARAMS_METADATA = "supacloud:route-params";

export interface RouteParamBinding {
  index: number;
  type: "param" | "query" | "body" | "headers";
  name?: string;
  transform?: "number" | "boolean" | "string";
  default?: unknown;
}

export interface ParamOptions {
  name?: string;
  transform?: "number" | "boolean" | "string";
  default?: unknown;
}

export interface InjectableOptions {
  scope?: Scope;
  /** Automatically provide this service in root scope without manual module declaration (Angular-style). */
  providedIn?: "root";
  /** Explicit constructor dependency tokens, in parameter order. */
  deps?: Token[];
}

export interface InjectableMeta {
  scope: Scope;
  providedIn?: "root";
  deps: Token[];
}

export interface ModuleOptions {
  name: string;
  /** Tags for architectural boundary governance (e.g. ['scope:case', 'type:feature']). */
  tags?: string[];
  imports?: Array<Type<unknown>>;
  providers?: Array<Provider | EnvironmentProviders>;
  controllers?: Array<Type<unknown>>;
  commands?: Array<Type<unknown>>;
  queries?: Array<Type<unknown>>;
  exports?: Token[];
}

export interface ModuleMeta extends Required<Omit<ModuleOptions, "exports" | "tags">> {
  tags?: string[];
  exports: Token[];
}

export interface CommandOptions {
  name: string;
  /** Permission identifier required to execute (e.g. "case.create"). */
  permission: string;
  /** Transaction requirement for the underlying write, e.g. "required". */
  transaction?: "required" | "none";
  /** Audit event name recorded on success, e.g. "case.created". */
  audit?: string;
  /** Idempotency strategy, e.g. "required". */
  idempotency?: "required" | "none";
  /** Automatically discover and register without manual module declaration. */
  standalone?: boolean;
}

export type CommandMeta = Omit<CommandOptions, "transaction" | "idempotency"> & {
  transaction: "required" | "none";
  idempotency: "required" | "none";
  standalone?: boolean;
};

export interface QueryOptions {
  name: string;
}

export type QueryMeta = QueryOptions;

export interface ControllerMeta {
  path: string;
  standalone?: boolean;
}

export interface ControllerOptions {
  path?: string;
  standalone?: boolean;
}

export type CanActivateFn<TContext = any> = (ctx: TContext) => boolean | Promise<boolean>;
export type CanMatchFn<TContext = any> = (ctx: TContext) => boolean | Promise<boolean>;
export type CanDeactivateFn<T = any, TContext = any> = (component: T, ctx: TContext) => boolean | Promise<boolean>;
export type ResolveFn<T = any, TContext = any> = (ctx: TContext) => T | Promise<T>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface RouteOptions {
  /** TypeBox schema (or compatible) for the request body. */
  body?: unknown;
  /** TypeBox schema for path params. */
  params?: unknown;
  /** TypeBox schema for query string. */
  query?: unknown;
  /** TypeBox schema for the response. */
  response?: unknown;
  /** Command class whose governance metadata must be enforced for this route. */
  command?: Type<unknown>;
  /** Angular-style functional route guards executed before handler. */
  guards?: Array<CanActivateFn | string>;
  /** Angular-style route matching guard determining whether route can match. */
  canMatch?: Array<CanMatchFn | string>;
  /** Angular-style route deactivation guard executed before leaving/cleaning up route. */
  canDeactivate?: Array<CanDeactivateFn | string>;
  /** Angular-style route resolvers executed before handler to preload dependencies. */
  resolvers?: Record<string, ResolveFn | string>;
  /** Angular-style route redirect target path. */
  redirectTo?: string;
  /** Angular-style route path matching strategy. */
  pathMatch?: "full" | "prefix";
  /** Route title or label (modeled after Angular Route.title). */
  title?: string;
  /** Static route metadata dictionary (modeled after Angular Route.data). */
  data?: Record<string, unknown>;
}

export interface RouteDefinition extends RouteOptions {
  method: HttpMethod;
  path: string;
  /** Controller method name. */
  handler: string;
}

function defineMetadata(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
}

function readOwnOrInherited<T>(target: object, key: string): T | undefined {
  return (target as Record<string, T>)[key];
}

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target) => {
    const meta: InjectableMeta = {
      scope: options.scope ?? DEFAULT_SCOPE,
      providedIn: options.providedIn,
      deps: options.deps ?? [],
    };
    defineMetadata(target, INJECTABLE_METADATA, meta);
  };
}

export function getInjectableMeta(target: object): InjectableMeta | undefined {
  return readOwnOrInherited(target, INJECTABLE_METADATA);
}

/**
 * Parameter decorator marking a constructor parameter's injection token.
 * Only meaningful together with the SupaCloud compiler; no runtime reflection
 * is performed.
 */
export function Inject(token: Token): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      throw new Error("@Inject() is only supported on constructor parameters");
    }
    const cls = target as Type<unknown>;
    const meta: Record<number, Token> = {
      ...readOwnOrInherited<Record<number, Token>>(cls, INJECT_PARAMS_METADATA),
    };
    meta[parameterIndex] = token;
    defineMetadata(cls, INJECT_PARAMS_METADATA, meta);
  };
}

export function getInjectParams(target: object): Record<number, Token> {
  return readOwnOrInherited(target, INJECT_PARAMS_METADATA) ?? {};
}

/**
 * Parameter decorator marking a constructor parameter as optional.
 * Modeled after Angular's @Optional(); if unresolved, the parameter receives undefined.
 */
export function Optional(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      throw new Error("@Optional() is only supported on constructor parameters");
    }
    const cls = target as Type<unknown>;
    const list = [...(readOwnOrInherited<number[]>(cls, OPTIONAL_PARAMS_METADATA) ?? [])];
    if (!list.includes(parameterIndex)) list.push(parameterIndex);
    defineMetadata(cls, OPTIONAL_PARAMS_METADATA, list);
  };
}

export function getOptionalParams(target: object): number[] {
  return readOwnOrInherited(target, OPTIONAL_PARAMS_METADATA) ?? [];
}

/**
 * Parameter decorator asserting that dependency must be provided in the current module/scope.
 * Modeled after Angular's @Self(); fails at compile time if resolved from imported modules or fallback.
 */
export function Self(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      throw new Error("@Self() is only supported on constructor parameters");
    }
    const cls = target as Type<unknown>;
    const list = [...(readOwnOrInherited<number[]>(cls, SELF_PARAMS_METADATA) ?? [])];
    if (!list.includes(parameterIndex)) list.push(parameterIndex);
    defineMetadata(cls, SELF_PARAMS_METADATA, list);
  };
}

export function getSelfParams(target: object): number[] {
  return readOwnOrInherited(target, SELF_PARAMS_METADATA) ?? [];
}

/**
 * Parameter decorator asserting that dependency must NOT be resolved from the current module itself.
 * Modeled after Angular's @SkipSelf(); searches parent/imported scopes.
 */
export function SkipSelf(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      throw new Error("@SkipSelf() is only supported on constructor parameters");
    }
    const cls = target as Type<unknown>;
    const list = [...(readOwnOrInherited<number[]>(cls, SKIP_SELF_PARAMS_METADATA) ?? [])];
    if (!list.includes(parameterIndex)) list.push(parameterIndex);
    defineMetadata(cls, SKIP_SELF_PARAMS_METADATA, list);
  };
}

export function getSkipSelfParams(target: object): number[] {
  return readOwnOrInherited(target, SKIP_SELF_PARAMS_METADATA) ?? [];
}

/**
 * Parameter decorator specifying host resolution boundary.
 * Modeled after Angular's @Host().
 */
export function Host(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      throw new Error("@Host() is only supported on constructor parameters");
    }
    const cls = target as Type<unknown>;
    const list = [...(readOwnOrInherited<number[]>(cls, HOST_PARAMS_METADATA) ?? [])];
    if (!list.includes(parameterIndex)) list.push(parameterIndex);
    defineMetadata(cls, HOST_PARAMS_METADATA, list);
  };
}

export function getHostParams(target: object): number[] {
  return readOwnOrInherited(target, HOST_PARAMS_METADATA) ?? [];
}

/**
 * Class and method decorator attaching functional route guards.
 * Modeled after Angular Router guards.
 */
export function UseGuards(...guards: Array<CanActivateFn | string>): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      const cls = (target as { constructor: Type<unknown> }).constructor;
      const key = `${GUARDS_METADATA}:${String(propertyKey)}`;
      const existing = readOwnOrInherited<Array<CanActivateFn | string>>(cls, key) ?? [];
      defineMetadata(cls, key, [...existing, ...guards]);
    } else {
      const existing = readOwnOrInherited<Array<CanActivateFn | string>>(target, GUARDS_METADATA) ?? [];
      defineMetadata(target, GUARDS_METADATA, [...existing, ...guards]);
    }
  };
}

export function getGuards(target: object, propertyKey?: string | symbol): Array<CanActivateFn | string> {
  if (propertyKey !== undefined) {
    const methodGuards = readOwnOrInherited<Array<CanActivateFn | string>>(target, `${GUARDS_METADATA}:${String(propertyKey)}`) ?? [];
    const classGuards = readOwnOrInherited<Array<CanActivateFn | string>>(target, GUARDS_METADATA) ?? [];
    return [...classGuards, ...methodGuards];
  }
  return readOwnOrInherited(target, GUARDS_METADATA) ?? [];
}

export function Module(options: ModuleOptions): ClassDecorator {
  return (target) => {
    const meta: ModuleMeta = {
      name: options.name,
      tags: options.tags ?? [],
      imports: options.imports ?? [],
    providers: options.providers ? flattenProviders(options.providers) : [],
    controllers: options.controllers ?? [],
      commands: options.commands ?? [],
      queries: options.queries ?? [],
      exports: options.exports ?? [],
    };
    defineMetadata(target, MODULE_METADATA, meta);
  };
}

export function getModuleMeta(target: object): ModuleMeta | undefined {
  return readOwnOrInherited(target, MODULE_METADATA);
}

export function Command(options: CommandOptions): ClassDecorator {
  return (target) => {
    defineMetadata(target, COMMAND_METADATA, {
      ...options,
      transaction: options.transaction ?? "none",
      idempotency: options.idempotency ?? "none",
    });
  };
}

export function getCommandMeta(target: object): CommandMeta | undefined {
  return readOwnOrInherited(target, COMMAND_METADATA);
}

export function Param(nameOrOptions?: string | ParamOptions, options?: ParamOptions): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      throw new Error("@Param() is only supported on controller method parameters");
    }
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${ROUTE_PARAMS_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<RouteParamBinding[]>(cls, key) ?? [];
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.name;
    const transform = typeof nameOrOptions === "object" ? nameOrOptions.transform : options?.transform;
    const defaultValue = typeof nameOrOptions === "object" ? nameOrOptions.default : options?.default;
    defineMetadata(cls, key, [...existing, { index: parameterIndex, type: "param", name, transform, default: defaultValue }]);
  };
}

export function Body(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      throw new Error("@Body() is only supported on controller method parameters");
    }
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${ROUTE_PARAMS_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<RouteParamBinding[]>(cls, key) ?? [];
    defineMetadata(cls, key, [...existing, { index: parameterIndex, type: "body" }]);
  };
}

export function Headers(name?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      throw new Error("@Headers() is only supported on controller method parameters");
    }
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${ROUTE_PARAMS_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<RouteParamBinding[]>(cls, key) ?? [];
    defineMetadata(cls, key, [...existing, { index: parameterIndex, type: "headers", name }]);
  };
}

export function Query(optionsOrName?: QueryOptions | ParamOptions | string, options?: ParamOptions): ClassDecorator & ParameterDecorator {
  return ((target: object, propertyKey?: string | symbol, parameterIndex?: number) => {
    if (typeof parameterIndex === "number" && propertyKey !== undefined) {
      const cls = (target as { constructor: Type<unknown> }).constructor;
      const key = `${ROUTE_PARAMS_METADATA}:${String(propertyKey)}`;
      const existing = readOwnOrInherited<RouteParamBinding[]>(cls, key) ?? [];
      const name = typeof optionsOrName === "string" ? optionsOrName : (optionsOrName as ParamOptions)?.name;
      const transform = typeof optionsOrName === "object" ? (optionsOrName as ParamOptions).transform : options?.transform;
      const defaultValue = typeof optionsOrName === "object" ? (optionsOrName as ParamOptions).default : options?.default;
      defineMetadata(cls, key, [...existing, { index: parameterIndex, type: "query", name, transform, default: defaultValue }]);
    } else {
      const opts = typeof optionsOrName === "object" && optionsOrName !== null ? optionsOrName : { name: String(optionsOrName ?? "") };
      defineMetadata(target, QUERY_METADATA, { ...opts });
    }
  }) as ClassDecorator & ParameterDecorator;
}

export function getRouteParams(target: object, propertyKey: string | symbol): RouteParamBinding[] {
  const params = readOwnOrInherited<RouteParamBinding[]>(target, `${ROUTE_PARAMS_METADATA}:${String(propertyKey)}`) ?? [];
  return [...params].sort((a, b) => a.index - b.index);
}

export function getQueryMeta(target: object): QueryMeta | undefined {
  return readOwnOrInherited(target, QUERY_METADATA);
}

export function Controller(pathOrOptions: string | ControllerOptions = "/"): ClassDecorator {
  return (target) => {
    const meta: ControllerMeta = typeof pathOrOptions === "string"
      ? { path: pathOrOptions }
      : { path: pathOrOptions.path ?? "/", standalone: pathOrOptions.standalone };
    defineMetadata(target, CONTROLLER_METADATA, meta);
  };
}

export function getControllerMeta(target: object): ControllerMeta | undefined {
  return readOwnOrInherited(target, CONTROLLER_METADATA);
}

function createRouteDecorator(method: HttpMethod) {
  return (path: string, options: RouteOptions = {}): MethodDecorator =>
    (target, propertyKey) => {
      const cls = (target as { constructor: Type<unknown> }).constructor;
      const titleKey = `${TITLE_METADATA}:${String(propertyKey)}`;
      const dataKey = `${DATA_METADATA}:${String(propertyKey)}`;
      const deactKey = `${CAN_DEACTIVATE_METADATA}:${String(propertyKey)}`;
      const resolveKey = `${RESOLVE_METADATA}:${String(propertyKey)}`;
      const title = options.title ?? readOwnOrInherited<string>(cls, titleKey);
      const data = {
        ...(readOwnOrInherited<Record<string, unknown>>(cls, dataKey) ?? {}),
        ...(options.data ?? {}),
      };
      const canDeactivate = [
        ...(readOwnOrInherited<Array<CanDeactivateFn | string>>(cls, deactKey) ?? []),
        ...(options.canDeactivate ?? []),
      ];
      const resolvers = {
        ...(readOwnOrInherited<Record<string, ResolveFn | string>>(cls, resolveKey) ?? {}),
        ...(options.resolvers ?? {}),
      };
      const routes: RouteDefinition[] = [
        ...(readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? []),
      ];
      routes.push({
        method,
        path,
        handler: String(propertyKey),
        ...options,
        resolvers: Object.keys(resolvers).length > 0 ? resolvers : undefined,
        canDeactivate: canDeactivate.length > 0 ? canDeactivate : undefined,
        title: title || undefined,
        data: Object.keys(data).length > 0 ? data : undefined,
      });
      defineMetadata(cls, ROUTES_METADATA, routes);
    };
}

export const Get = createRouteDecorator("GET");
export const Post = createRouteDecorator("POST");
export const Put = createRouteDecorator("PUT");
export const Patch = createRouteDecorator("PATCH");
export const Delete = createRouteDecorator("DELETE");
export const Head = createRouteDecorator("HEAD");
export const Options = createRouteDecorator("OPTIONS");

/**
 * Sets a route title. Modeled after Angular Route.title.
 */
export function Title(title: string): MethodDecorator {
  return (target, propertyKey) => {
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${TITLE_METADATA}:${String(propertyKey)}`;
    defineMetadata(cls, key, title);
    const routes = readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? [];
    const route = routes.find((r) => r.handler === String(propertyKey));
    if (route) {
      route.title = title;
    }
  };
}

/**
 * Attaches arbitrary static metadata to a route. Modeled after Angular Route.data.
 */
export function Data(data: Record<string, unknown>): MethodDecorator {
  return (target, propertyKey) => {
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${DATA_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<Record<string, unknown>>(cls, key) ?? {};
    defineMetadata(cls, key, { ...existing, ...data });
    const routes = readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? [];
    const route = routes.find((r) => r.handler === String(propertyKey));
    if (route) {
      route.data = { ...route.data, ...data };
    }
  };
}

/**
 * Attaches CanDeactivateFn guards to a route method. Modeled after Angular Route.canDeactivate.
 */
export function CanDeactivate(...guards: Array<CanDeactivateFn | string>): MethodDecorator {
  return (target, propertyKey) => {
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${CAN_DEACTIVATE_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<Array<CanDeactivateFn | string>>(cls, key) ?? [];
    defineMetadata(cls, key, [...existing, ...guards]);
    const routes = readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? [];
    const route = routes.find((r) => r.handler === String(propertyKey));
    if (route) {
      route.canDeactivate = [...(route.canDeactivate ?? []), ...guards];
    }
  };
}

/**
 * Attaches route pre-activation resolvers to a route method. Modeled after Angular Route.resolve.
 * Resolvers run before the route handler, allowing prefetching and validation without controller boilerplate.
 */
export function Resolve(resolvers: Record<string, ResolveFn | string>): MethodDecorator {
  return (target, propertyKey) => {
    const cls = (target as { constructor: Type<unknown> }).constructor;
    const key = `${RESOLVE_METADATA}:${String(propertyKey)}`;
    const existing = readOwnOrInherited<Record<string, ResolveFn | string>>(cls, key) ?? {};
    defineMetadata(cls, key, { ...existing, ...resolvers });
    const routes = readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? [];
    const route = routes.find((r) => r.handler === String(propertyKey));
    if (route) {
      route.resolvers = { ...(route.resolvers ?? {}), ...resolvers };
    }
  };
}

/**
 * Executes a dictionary of route resolvers concurrently.
 */
export async function executeResolvers<TContext = any>(
  resolvers: Record<string, ResolveFn | string>,
  ctx: TContext,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(resolvers);
  const resolved = await Promise.all(
    entries.map(async ([key, resolver]) => {
      if (typeof resolver === "function") {
        const val = await resolver(ctx);
        return [key, val] as const;
      }
      return [key, resolver] as const;
    }),
  );
  return Object.fromEntries(resolved);
}

export function getRoutes(target: object): RouteDefinition[] {
  return readOwnOrInherited(target, ROUTES_METADATA) ?? [];
}
