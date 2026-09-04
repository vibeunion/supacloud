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
  /** Angular-style route resolvers executed before handler to preload dependencies. */
  resolvers?: Record<string, ResolveFn | string>;
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

export function Query(options: QueryOptions): ClassDecorator {
  return (target) => {
    defineMetadata(target, QUERY_METADATA, { ...options });
  };
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
      const routes: RouteDefinition[] = [
        ...(readOwnOrInherited<RouteDefinition[]>(cls, ROUTES_METADATA) ?? []),
      ];
      routes.push({
        method,
        path,
        handler: String(propertyKey),
        ...options,
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

export function getRoutes(target: object): RouteDefinition[] {
  return readOwnOrInherited(target, ROUTES_METADATA) ?? [];
}
