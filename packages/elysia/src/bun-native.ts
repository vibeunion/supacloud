import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { CompiledModule, CompiledRoute } from "./index";

export type BunNativeRequestContextFactory = (
  request: Request,
) => unknown | Promise<unknown>;

export interface BunNativeApplicationOptions {
  modules: CompiledModule[];
  deps?: Record<string, unknown>;
  requestContext?: BunNativeRequestContextFactory;
  normalize?: boolean;
}

export interface BunNativeApplication {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly start: (options: BunNativeServeOptions) => BunNativeServer;
}

export interface BunNativeServeOptions {
  hostname?: string;
  port: number;
}

export interface BunNativeServer {
  readonly url: string;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

type RouteEntry = {
  module: CompiledModule;
  controller: CompiledModule["controllers"][number];
  route: CompiledRoute;
  path: string;
  segments: string[];
  matchPath: (pathname: string) => Record<string, string> | undefined;
  validateBody: (value: unknown) => unknown;
  validateParams: (value: unknown) => unknown;
  validateQuery: (value: unknown) => unknown;
};

type BunServe = (options: {
  hostname?: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) => { url: URL | string; stop(closeActiveConnections?: boolean): void | Promise<void> };

function bunServe(): BunServe {
  const runtime = (globalThis as unknown as { Bun?: { serve: BunServe } }).Bun;
  if (!runtime?.serve) throw new Error("SupaCloud Bun adapter requires Bun.serve");
  return runtime.serve.bind(runtime);
}

function joinPath(prefix: string, path: string): string {
  const value = `${prefix}/${path}`.replace(/\/+/g, "/");
  return value === "/" ? value : value.replace(/\/$/, "") || "/";
}

function routeSegments(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

function compilePathMatcher(segments: string): (pathname: string) => Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = routeSegments(segments).map((segment) => {
    if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(segment.slice(1));
    return "([^/]+)";
  }).join("/");
  const matcher = new RegExp(`^/${pattern}/?$`);
  return (pathname) => {
    const match = matcher.exec(pathname);
    if (!match) return undefined;
    const params: Record<string, string> = {};
    for (let index = 0; index < names.length; index += 1) params[names[index]!] = decodeURIComponent(match[index + 1]!);
    return params;
  };
}

function compileSchema(schema: unknown, label: string, normalize: boolean): (value: unknown) => unknown {
  if (schema === undefined) return (value) => value;
  const validator = Compile(schema as TSchema);
  return (value) => {
    try {
      if (!validator.Check(value)) throw new TypeError(`Invalid ${label}`);
      return normalize ? validator.Decode(value) : value;
    } catch {
      throw new Response(JSON.stringify({ ok: false, code: "REQUEST_VALIDATION_FAILED", message: "Invalid request" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
  };
}

async function requestBody(request: Request, route: CompiledRoute): Promise<unknown> {
  if (route.body === undefined || route.parse === "none") return undefined;
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return request.json();
  return request.text();
}

function responseFor(value: unknown): Response {
  if (value instanceof Response) return value;
  return Response.json(value);
}

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  return Response.json({ ok: false, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" }, { status: 500 });
}

export function createBunNativeApplication(options: BunNativeApplicationOptions): BunNativeApplication {
  const normalize = options.normalize ?? true;
  const services = options.modules.map((module) => ({ module, value: module.createServices(options.deps ?? {}, {}) }));
  const staticRoutes = new Map<string, RouteEntry>();
  const dynamicRoutes = new Map<string, RouteEntry[]>();
  for (const module of options.modules) {
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        if (typeof route.invoker !== "function") throw new TypeError(`Route ${route.method} ${route.path} requires a generated invoker`);
        const path = joinPath(controller.path, route.path);
        const segments = routeSegments(path);
        const entry: RouteEntry = {
          module, controller, route, path, segments,
          matchPath: compilePathMatcher(path),
          validateBody: compileSchema(route.body, "body", normalize),
          validateParams: compileSchema(route.params, "params", normalize),
          validateQuery: compileSchema(route.query, "query", normalize),
        };
        const key = `${route.method} ${path}`;
        if (segments.some((segment) => segment.startsWith(":"))) {
          const list = dynamicRoutes.get(route.method) ?? [];
          list.push(entry);
          dynamicRoutes.set(route.method, list);
        } else {
          staticRoutes.set(key, entry);
        }
      }
    }
  }

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const entry = staticRoutes.get(`${request.method} ${url.pathname}`)
      ?? dynamicRoutes.get(request.method)?.find((candidate) => candidate.matchPath(url.pathname));
    if (!entry) return new Response("Not Found", { status: 404 });
    try {
      const params = entry.matchPath(url.pathname)!;
      const query = Object.fromEntries(url.searchParams.entries());
      const body = await requestBody(request, entry.route);
      const input = {
        body: entry.validateBody(body),
        params: entry.validateParams(params) as Record<string, unknown>,
        query: entry.validateQuery(query) as Record<string, unknown>,
        headers: Object.fromEntries(request.headers.entries()),
        context: options.requestContext ? await options.requestContext(request) : undefined,
        request,
      };
      const service = services.find((item) => item.module === entry.module)?.value;
      const controller = entry.controller.scope === "application" ? service?.[entry.controller.serviceKey] : service?.[entry.controller.serviceKey];
      const result = await entry.route.invoker(controller, input);
      return responseFor(result);
    } catch (error) {
      return errorResponse(error);
    }
  };

  return {
    fetch,
    start: ({ hostname = "127.0.0.1", port }) => {
      const server = bunServe()({ hostname, port, fetch });
      return {
        url: String(server.url),
        stop: server.stop.bind(server),
      };
    },
  };
}
