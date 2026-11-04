import { Elysia } from "elysia";
import type { AnyElysia } from "elysia";
import {
  createApplication,
  type ApplicationOptions,
} from "./index";

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
