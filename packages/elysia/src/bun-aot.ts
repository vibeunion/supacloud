import { Elysia } from "elysia";
import type { AnyElysia } from "elysia";
import {
  createApplication,
  type ApplicationOptions,
} from "./index";
import { createBunNativeApplication } from "./bun-native";

export interface BunAotApplication {
  readonly app: AnyElysia;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly start: (options: BunAotServeOptions) => BunAotServer;
  readonly destroy: () => Promise<void>;
}

export interface BunAotServeOptions {
  hostname?: string;
  port: number;
}

export interface BunAotServer {
  readonly url: string;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface BunApplication extends BunAotApplication {
  readonly mode: "native" | "aot";
}

type BunServe = (options: {
  hostname?: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) => { url: URL | string; stop(closeActiveConnections?: boolean): void | Promise<void> };

function bunServe(): BunServe {
  const runtime = (globalThis as unknown as { Bun?: { serve: BunServe } }).Bun;
  if (!runtime?.serve) throw new Error("SupaCloud Bun AOT adapter requires Bun.serve");
  return runtime.serve.bind(runtime);
}

export function createBunAotApplication<const Http extends AnyElysia = Elysia, RequestContext = unknown>(
  options: ApplicationOptions<Http, RequestContext>,
): BunAotApplication {
  const app = createApplication(options);
  const fetch = app.handle.bind(app);
  return {
    app,
    fetch,
    start: ({ hostname = "127.0.0.1", port }) => {
      const server = bunServe()({ hostname, port, fetch });
      let stopPromise: Promise<void> | undefined;
      return {
        url: String(server.url),
        stop: (closeActiveConnections = true) => {
          stopPromise ??= Promise.resolve(server.stop(closeActiveConnections)).then(() => app.destroy());
          return stopPromise;
        },
      };
    },
    destroy: () => app.destroy(),
  };
}

/**
 * Select the optimized native path only when it can preserve the complete
 * application contract. Complex applications automatically use the full AOT
 * runtime, so capability checks never become silent behavior loss.
 */
export function createBunApplication<const Http extends AnyElysia = Elysia, RequestContext = unknown>(
  options: ApplicationOptions<Http, RequestContext>,
): BunApplication {
  const complex = options.modules?.some((module) =>
    module.createRequestScope !== undefined
    || module.controllers.some((controller) => controller.routes.some((route) =>
      route.command !== undefined
      || route.aspects?.length
      || route.aspectPipeline
      || route.data?.httpPolicies !== undefined,
    )),
  )
    || options.requestContext !== undefined
    || options.http !== undefined
    || options.httpPolicies !== undefined
    || options.commandGovernance !== undefined
    || options.commandExecutor !== undefined
    || options.errorMapper !== undefined
    || options.onExecution !== undefined
    || options.pendingWork !== undefined
    || options.documentation !== undefined;
  if (complex) return { ...createBunAotApplication(options), mode: "aot" };
  const native = createBunNativeApplication({
    modules: options.modules ?? [],
    deps: options.deps,
    normalize: options.normalize,
  });
  const start = (serveOptions: BunAotServeOptions): BunAotServer => {
    const server = native.start(serveOptions);
    return { url: server.url, stop: async (close = true) => { await server.stop(close); } };
  };
  return {
    fetch: native.fetch,
    start,
    mode: "native",
    app: native as unknown as AnyElysia,
    destroy: async () => {},
  };
}
