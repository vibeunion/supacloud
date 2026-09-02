import { Elysia } from "elysia";

// ---------------------------------------------------------------------------
// Compiled module contract (mirrors @supacloud/compiler output)
// ---------------------------------------------------------------------------

export interface CompiledRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Method name on the controller instance. */
  handler: string;
  /** TypeBox schema; validation is enabled only when the field is present. */
  body?: unknown;
  params?: unknown;
  query?: unknown;
  response?: unknown;
  /** Class name of the @Command explicitly bound to this route. */
  command?: string;
}

export interface CompiledCommand {
  className: string;
  name: string;
  permission?: string;
  transaction?: string;
  audit?: string;
  idempotency?: string;
}

export interface CompiledController {
  /** Controller path prefix, e.g. "/cases". */
  path: string;
  /** Key of the controller instance on `services` or the request scope. */
  serviceKey: string;
  scope: "application" | "request" | "job";
  routes: CompiledRoute[];
}

export interface CompiledModule {
  name: string;
  createServices(
    deps: Record<string, unknown>,
    imported: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  createRequestScope?(
    services: Record<string, unknown>,
    ctx: unknown,
    imported?: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  controllers: CompiledController[];
  /** Optional for compatibility with previously generated modules. */
  commands?: CompiledCommand[];
}

// ---------------------------------------------------------------------------
// Application options
// ---------------------------------------------------------------------------

export type RequestContextFactory = (
  request: Request,
) => unknown | Promise<unknown>;

export interface CommandInvocation {
  command: CompiledCommand;
  input: {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, unknown>;
  };
  request: Request;
  requestContext: unknown;
  scope?: Record<string, unknown>;
  services: Record<string, unknown>;
}

export type CommandExecutor = (
  invocation: CommandInvocation,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export interface ApplicationErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
}

export class ApplicationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: ApplicationErrorOptions = {}) {
    super(message);
    this.name = "ApplicationError";
    this.status = options.status ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.details = options.details;
  }
}

export interface ErrorContext {
  request: Request;
  requestContext: unknown;
  frameworkCode: string | number | undefined;
}

export type ErrorMapper = (
  error: unknown,
  context: ErrorContext,
) => Response | undefined | Promise<Response | undefined>;

export interface ApplicationOptions {
  name?: string;
  /** Modules in topological import order. */
  modules: CompiledModule[];
  /** Platform-level dependencies (db client etc.), passed to createServices. */
  deps?: Record<string, unknown>;
  /** Builds the per-request context object. Defaults to { requestId, request }. */
  requestContext?: RequestContextFactory;
  /** Enforces permission/audit/idempotency policy for command-bound routes. */
  commandExecutor?: CommandExecutor;
  /** Maps framework or application failures to the public HTTP contract. */
  errorMapper?: ErrorMapper;
}

const defaultRequestContext: RequestContextFactory = (request) => ({
  requestId: crypto.randomUUID(),
  request,
});

/** Join a controller prefix and a route path, normalizing slashes. */
function joinPaths(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

interface HttpContext {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, unknown>;
  request: Request;
  scope?: Record<string, unknown>;
  requestContext?: unknown;
}

type ControllerInstance = Record<
  string,
  (input: {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, unknown>;
    request: Request;
    scope?: Record<string, unknown>;
  }) => unknown
>;

/**
 * Adapt a single compiled module into an Elysia plugin.
 *
 * The plugin decorates the context with `services`; when the module defines
 * `createRequestScope`, a fresh request scope is resolved per request and
 * exposed on the `scope` context key. Request-scoped controller instances are
 * looked up on `scope`, everything else on `services`.
 */
export function createModulePlugin(
  compiled: CompiledModule,
  services: Record<string, unknown>,
  ctxFactory: RequestContextFactory = defaultRequestContext,
  options: Pick<ApplicationOptions, "commandExecutor" | "errorMapper"> = {},
  imported: Record<string, Record<string, unknown>> = {},
): Elysia {
  const requestContexts = new WeakMap<Request, unknown>();
  const plugin = new Elysia({ name: `supacloud:${compiled.name}` }).decorate(
    "services",
    services,
  );

  const createRequestScope = compiled.createRequestScope;
  plugin.resolve(async ({ request }) => {
    const requestContext = await ctxFactory(request);
    requestContexts.set(request, requestContext);
    return { requestContext };
  });

  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      const path = joinPaths(controller.path, route.path);
      const schema: Record<string, unknown> = {};
      if (route.body !== undefined) schema.body = route.body;
      if (route.params !== undefined) schema.params = route.params;
      if (route.query !== undefined) schema.query = route.query;
      if (route.response !== undefined) schema.response = route.response;

      const handler = async (ctx: HttpContext) => {
        const requestContext = ctx.requestContext ?? await ctxFactory(ctx.request);
        const requestScope = createRequestScope
          ? createRequestScope(services, requestContext, imported)
          : undefined;
        const source =
          controller.scope === "request" ? requestScope : services;
        const instance = source?.[controller.serviceKey] as
          | ControllerInstance
          | undefined;
        const method = instance?.[route.handler];
        if (typeof method !== "function") {
          throw new Error(
            `supacloud: controller "${controller.serviceKey}" has no handler "${route.handler}" in scope "${controller.scope}"`,
          );
        }
        const input = {
          body: ctx.body,
          params: ctx.params,
          query: ctx.query,
          request: ctx.request,
          scope: requestScope,
          requestContext,
        };
        const invoke = () => method.call(instance, input);
        if (!route.command) return invoke();

        const command = compiled.commands?.find((item) => item.className === route.command);
        if (!command) {
          throw new ApplicationError(`Command "${route.command}" is not registered`, {
            code: "COMMAND_NOT_REGISTERED",
          });
        }
        if (!options.commandExecutor) {
          throw new ApplicationError(`Command "${command.name}" has no executor`, {
            status: 501,
            code: "COMMAND_EXECUTOR_UNAVAILABLE",
          });
        }
        return options.commandExecutor({
          command,
          input,
          request: ctx.request,
          requestContext,
          scope: requestScope,
          services,
        }, invoke);
      };

      switch (route.method) {
        case "GET":
          plugin.get(path, handler, schema);
          break;
        case "POST":
          plugin.post(path, handler, schema);
          break;
        case "PUT":
          plugin.put(path, handler, schema);
          break;
        case "PATCH":
          plugin.patch(path, handler, schema);
          break;
        case "DELETE":
          plugin.delete(path, handler, schema);
          break;
      }
    }
  }

  plugin.onError({ as: "global" }, async ({ code, error, request }) => {
    const context: ErrorContext = {
      request,
      requestContext: requestContexts.get(request),
      frameworkCode: code,
    };
    const mapped = await options.errorMapper?.(error, context);
    return mapped ?? defaultErrorResponse(error, code);
  });

  return plugin as unknown as Elysia;
}

export function defaultErrorResponse(
  error: unknown,
  frameworkCode?: string | number,
): Response {
  if (error instanceof ApplicationError) {
    return Response.json({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }, { status: error.status });
  }
  if (frameworkCode === "VALIDATION") {
    return Response.json({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
    }, { status: 422 });
  }
  return Response.json({
    ok: false,
    code: "INTERNAL_ERROR",
    message: "Internal Server Error",
  }, { status: 500 });
}

/**
 * Create the root Elysia application from compiled modules.
 *
 * Modules are instantiated in the given (topological) order: each module's
 * `createServices` receives `deps` plus the services of all previously
 * created modules, keyed by module name.
 */
export function createApplication(options: ApplicationOptions): Elysia {
  const app = new Elysia({ name: options.name ?? "supacloud:app" });
  const configuredContextFactory = options.requestContext ?? defaultRequestContext;
  const contextCache = new WeakMap<Request, Promise<unknown>>();
  const ctxFactory: RequestContextFactory = (request) => {
    const cached = contextCache.get(request);
    if (cached) return cached;
    const pending = Promise.resolve(configuredContextFactory(request));
    contextCache.set(request, pending);
    return pending;
  };
  const imported: Record<string, Record<string, unknown>> = {};

  for (const module of options.modules) {
    const services = module.createServices(options.deps ?? {}, imported);
    imported[module.name] = services;
    app.use(createModulePlugin(module, services, ctxFactory, options, imported));
  }

  return app as unknown as Elysia;
}

/** Semantic alias of createApplication for readable tests. */
export function createTestApp(options: ApplicationOptions): Elysia {
  return createApplication(options);
}
