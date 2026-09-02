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
  ): Record<string, unknown>;
  controllers: CompiledController[];
}

// ---------------------------------------------------------------------------
// Application options
// ---------------------------------------------------------------------------

export type RequestContextFactory = (
  request: Request,
) => unknown | Promise<unknown>;

export interface ApplicationOptions {
  name?: string;
  /** Modules in topological import order. */
  modules: CompiledModule[];
  /** Platform-level dependencies (db client etc.), passed to createServices. */
  deps?: Record<string, unknown>;
  /** Builds the per-request context object. Defaults to { requestId, request }. */
  requestContext?: RequestContextFactory;
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
): Elysia {
  const plugin = new Elysia({ name: `supacloud:${compiled.name}` }).decorate(
    "services",
    services,
  );

  if (compiled.createRequestScope) {
    const createRequestScope = compiled.createRequestScope;
    plugin.resolve(async ({ request }) => ({
      scope: createRequestScope(services, await ctxFactory(request)),
    }));
  }

  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      const path = joinPaths(controller.path, route.path);
      const schema: Record<string, unknown> = {};
      if (route.body !== undefined) schema.body = route.body;
      if (route.params !== undefined) schema.params = route.params;
      if (route.query !== undefined) schema.query = route.query;
      if (route.response !== undefined) schema.response = route.response;

      const handler = async (ctx: HttpContext) => {
        const source =
          controller.scope === "request" ? ctx.scope : services;
        const instance = source?.[controller.serviceKey] as
          | ControllerInstance
          | undefined;
        const method = instance?.[route.handler];
        if (typeof method !== "function") {
          throw new Error(
            `supacloud: controller "${controller.serviceKey}" has no handler "${route.handler}" in scope "${controller.scope}"`,
          );
        }
        return method.call(instance, {
          body: ctx.body,
          params: ctx.params,
          query: ctx.query,
          request: ctx.request,
          scope: ctx.scope,
        });
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

  return plugin as unknown as Elysia;
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
  const ctxFactory = options.requestContext ?? defaultRequestContext;
  const imported: Record<string, Record<string, unknown>> = {};

  for (const module of options.modules) {
    const services = module.createServices(options.deps ?? {}, imported);
    imported[module.name] = services;
    app.use(createModulePlugin(module, services, ctxFactory));
  }

  return app as unknown as Elysia;
}

/** Semantic alias of createApplication for readable tests. */
export function createTestApp(options: ApplicationOptions): Elysia {
  return createApplication(options);
}
