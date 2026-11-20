import { relativeImportPath } from "./util";

interface DeliveryFunctionHost {
  fetch(request: Request): Response | Promise<Response>;
}

/**
 * Wrap a module-backed Function target in the host-owned application factory.
 * The generated application is already in scope as `createCompiledModules`.
 */
export function renderDeliveryFunctionEntry(generatedDirectory: string, hostPath: string, databaseSecret?: string): string {
  const specifier = relativeImportPath(generatedDirectory, hostPath);
  if (databaseSecret !== undefined) {
    return `
import * as deliveryFunctionHostModule from ${JSON.stringify(specifier)};
import { createBunSqlHost as createDeliverySqlHost } from "@supacloud/db/bun";

type BoundFunctionHost = {
  fetch(request: Request): Response | Promise<Response>;
  close(): void | Promise<void>;
};
const { createDeliveryApplication, createDeliveryDatabase } = deliveryFunctionHostModule as {
  createDeliveryApplication?: (
    modules: ReturnType<typeof createCompiledModules>,
    lifecycle: { signal: AbortSignal; deps: { dbClient: unknown } },
  ) => BoundFunctionHost | Promise<BoundFunctionHost>;
  createDeliveryDatabase?: (
    pool: ReturnType<typeof createDeliverySqlHost>["pool"], lifecycle: { signal: AbortSignal },
  ) => unknown | Promise<unknown>;
};
if (typeof createDeliveryApplication !== "function" || typeof createDeliveryDatabase !== "function") {
  throw new Error("Invalid Function database adapter; export createDeliveryApplication and createDeliveryDatabase.");
}
const createBoundApplication = createDeliveryApplication;
const createBoundDatabase = createDeliveryDatabase;

export default {
  __supacloud: { routeAware: true },
  async fetch(request: Request): Promise<Response> {
    const { signal } = request;
    signal.throwIfAborted();
    const url = process.env[${JSON.stringify(databaseSecret)}];
    if (!url) return new Response("Function database binding is not configured.", { status: 503 });

    // Every invocation owns at most one PostgreSQL connection; no Worker singleton retains credentials.
    let database: ReturnType<typeof createDeliverySqlHost> | undefined;
    let host: BoundFunctionHost | undefined;
    try {
      database = createDeliverySqlHost({ env: { DATABASE_URL: url }, max: 1, closeTimeout: 1 });
      const dbClient = await createBoundDatabase(database.pool, { signal });
      signal.throwIfAborted();
      host = await createBoundApplication(createCompiledModules(), { signal, deps: { dbClient } });
      if (typeof host?.fetch !== "function" || typeof host.close !== "function") {
        throw new Error("Invalid Function application adapter.");
      }
      signal.throwIfAborted();
      const response = await host.fetch(request);
      signal.throwIfAborted();
      return response;
    } catch {
      signal.throwIfAborted();
      return new Response("Function database application failed.", { status: 503 });
    } finally {
      try {
        try {
          if (typeof host?.close === "function") await host.close();
        } finally {
          await database?.close();
        }
      } catch {
        throw new Error("Function database cleanup failed.");
      }
    }
  },
};
`;
  }
  return `
import * as deliveryFunctionHostModule from ${JSON.stringify(specifier)};

type DeliveryFunctionHost = {
  fetch(request: Request): Response | Promise<Response>;
};

const createDeliveryFunctionHost = (deliveryFunctionHostModule as {
  createDeliveryApplication?: (
    modules: ReturnType<typeof createCompiledModules>,
    lifecycle: { signal: AbortSignal },
  ) => DeliveryFunctionHost | Promise<DeliveryFunctionHost>;
}).createDeliveryApplication;
if (typeof createDeliveryFunctionHost !== "function") {
  throw new Error("Invalid delivery Function host.");
}
const deliveryCreateHost = createDeliveryFunctionHost;

const deliveryFunctionLifecycle = new AbortController();
let deliveryFunctionHost: Promise<DeliveryFunctionHost> | undefined;
function deliveryHost(): Promise<DeliveryFunctionHost> {
  return deliveryFunctionHost ??= Promise.resolve(
    deliveryCreateHost(createCompiledModules(), { signal: deliveryFunctionLifecycle.signal }),
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    return (await deliveryHost()).fetch(request);
  },
};
`;
}

/** Re-export a standalone Edge Function entrypoint without requiring a compiler app graph. */
export function renderStandaloneFunctionEntry(generatedDirectory: string, entrypointPath: string): string {
  const specifier = relativeImportPath(generatedDirectory, entrypointPath);
  return `
import * as deliveryFunctionEntry from ${JSON.stringify(specifier)};

const deliveryFunctionDefault: unknown = (deliveryFunctionEntry as { default?: unknown }).default
  ?? deliveryFunctionEntry;
export default deliveryFunctionDefault;
`;
}
