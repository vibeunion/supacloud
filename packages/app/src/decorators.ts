import type { Provider, Token, Type } from "./provider";
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

export interface InjectableOptions {
  scope?: Scope;
  /** Explicit constructor dependency tokens, in parameter order. */
  deps?: Token[];
}

export interface InjectableMeta {
  scope: Scope;
  deps: Token[];
}

export interface ModuleOptions {
  name: string;
  /** Tags for architectural boundary governance (e.g. ['scope:case', 'type:feature']). */
  tags?: string[];
  imports?: Array<Type<unknown>>;
  providers?: Provider[];
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
}

export type CommandMeta = Omit<CommandOptions, "transaction" | "idempotency"> & {
  transaction: "required" | "none";
  idempotency: "required" | "none";
};

export interface QueryOptions {
  name: string;
}

export type QueryMeta = QueryOptions;

export interface ControllerMeta {
  path: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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

export function Module(options: ModuleOptions): ClassDecorator {
  return (target) => {
    const meta: ModuleMeta = {
      name: options.name,
      tags: options.tags ?? [],
      imports: options.imports ?? [],
      providers: options.providers ?? [],
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

export function Controller(path: string): ClassDecorator {
  return (target) => {
    defineMetadata(target, CONTROLLER_METADATA, { path });
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

export function getRoutes(target: object): RouteDefinition[] {
  return readOwnOrInherited(target, ROUTES_METADATA) ?? [];
}
