import { parentPort } from "worker_threads";
import "./port-guard";
import "./url-import-plugin";
import { getCapturedServeHandler, clearCapturedServeHandler } from "./deno-compat";
import { autoInstallDeps } from "./auto-deps";

interface CachedModule {
  mod: Record<string, unknown>;
  serveHandler: ((req: Request) => Response | Promise<Response>) | null;
  lastUsed: number;
}

const moduleCache = new Map<string, CachedModule>();
const MAX_CACHED = 20;

/** Try to import a function module; on missing-dep errors, auto-install and retry once */
async function loadModule(functionPath: string): Promise<{ default: unknown }> {
  try {
    return await import(functionPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("Could not resolve")) {
      console.log(`[Worker] Module load failed, attempting auto-install for ${functionPath}`);
      await autoInstallDeps(functionPath);
      // Retry after auto-install (clear Bun's internal module cache for this path)
      return await import(functionPath);
    }
    throw err;
  }
}

interface WorkerMessage {
  type?: string;
  functionId: string;
  functionPath: string;
  env: Record<string, string>;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

parentPort?.on("message", async (msg: WorkerMessage) => {
  // Handle cache invalidation messages from pool
  if (msg.type === "invalidate") {
    moduleCache.delete(msg.functionId);
    return;
  }

  // Handle function pre-heating (zero cold-start)
  if (msg.type === "preheat") {
    try {
      if (!moduleCache.has(msg.functionId)) {
        clearCapturedServeHandler();
        const mod = await loadModule(msg.functionPath);
        const serveHandler = getCapturedServeHandler() as CachedModule["serveHandler"];
        moduleCache.set(msg.functionId, { mod: mod as Record<string, unknown>, serveHandler, lastUsed: Date.now() });
        if (moduleCache.size > MAX_CACHED) {
          let oldest = { key: "", time: Infinity };
          for (const [k, v] of moduleCache) {
            if (v.lastUsed < oldest.time) oldest = { key: k, time: v.lastUsed };
          }
          moduleCache.delete(oldest.key);
        }
      }
      parentPort?.postMessage({ type: "preheat_done", functionId: msg.functionId });
    } catch (err: unknown) {
      parentPort?.postMessage({ type: "preheat_error", functionId: msg.functionId, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  try {
    const { functionId, functionPath, env, url, method, headers, body } =
      msg;

    // Snapshot current env values for keys we're about to inject,
    // so we can restore them after execution (multi-tenant isolation)
    const envEntries = Object.entries(env as Record<string, string>);
    const savedEnv = new Map<string, string | undefined>();
    for (const [k] of envEntries) {
      savedEnv.set(k, process.env[k]);
    }

    // Inject tenant env vars
    for (const [k, v] of envEntries) {
      process.env[k] = v;
    }

    try {
      // Load module (LRU cache)
      let cached = moduleCache.get(functionId);
      if (!cached) {
        clearCapturedServeHandler();
        const mod = await loadModule(functionPath);
        const serveHandler = getCapturedServeHandler() as CachedModule["serveHandler"];
        cached = { mod: mod as Record<string, unknown>, serveHandler, lastUsed: Date.now() };
        moduleCache.set(functionId, cached!);
        if (moduleCache.size > MAX_CACHED) {
          let oldest = { key: "", time: Infinity };
          for (const [k, v] of moduleCache) {
            if (v.lastUsed < oldest.time) oldest = { key: k, time: v.lastUsed };
          }
          moduleCache.delete(oldest.key);
        }
      }
      cached.lastUsed = Date.now();

      // Build Request
      const init: RequestInit = { method, headers: new Headers(headers) };
      if (body && !["GET", "HEAD"].includes(method)) init.body = body;
      const request = new Request(url, init);

      // Call function (supports bare handler, Elysia app, or Hono/other)
      const handler = cached.serveHandler || cached.mod.default;
      let response: Response;
      if (typeof handler === "function") {
        response = await (handler as (req: Request) => Promise<Response>)(
          request,
        );
      } else if (
        handler &&
        typeof handler === "object" &&
        "handle" in handler &&
        typeof (handler as { handle: (req: Request) => Promise<Response> }).handle === "function"
      ) {
        // Elysia app
        response = await (handler as { handle: (req: Request) => Promise<Response> }).handle(request);
      } else if (
        handler &&
        typeof handler === "object" &&
        "fetch" in handler &&
        typeof (handler as { fetch: (req: Request) => Promise<Response> }).fetch === "function"
      ) {
        // Hono / other fetch-based frameworks
        response = await (handler as { fetch: (req: Request) => Promise<Response> }).fetch(request);
      } else {
        throw new Error(
          "Function must export default handler, Elysia app, or fetch-based app",
        );
      }

      // Serialize response
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => (resHeaders[k] = v));
      const resBody = await response.arrayBuffer();
      parentPort?.postMessage(
        { status: response.status, headers: resHeaders, body: resBody },
      );
    } finally {
      // Restore previous env values to avoid cross-tenant leakage
      for (const [k, prev] of savedEnv) {
        if (prev === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = prev;
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Worker Error";
    parentPort?.postMessage({
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: message })),
    });
  }
});
