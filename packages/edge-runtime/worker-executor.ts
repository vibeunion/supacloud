import { parentPort } from "worker_threads";
import "./port-guard";
import "./url-import-plugin";
import { getCapturedServeHandler, clearCapturedServeHandler } from "./deno-compat";
import { autoInstallDeps } from "./auto-deps";

interface CachedModule {
  mod: any;
  serveHandler: Function | null;
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

parentPort?.on("message", async (msg) => {
  // Handle cache invalidation messages from pool
  if (msg.type === "invalidate") {
    moduleCache.delete(msg.functionId);
    return;
  }

  try {
    const { functionId, functionPath, env, url, method, headers, body } =
      msg;

    // Inject tenant env vars
    for (const [k, v] of Object.entries(env as Record<string, string>)) {
      process.env[k] = v;
    }

    // Load module (LRU cache)
    let cached = moduleCache.get(functionId);
    if (!cached) {
      clearCapturedServeHandler();
      const mod = await loadModule(functionPath);
      const serveHandler = getCapturedServeHandler();
      cached = { mod, serveHandler, lastUsed: Date.now() };
      moduleCache.set(functionId, cached);
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
      typeof (handler as { handle: Function }).handle === "function"
    ) {
      // Elysia app
      response = await (handler as { handle: (req: Request) => Promise<Response> }).handle(request);
    } else if (
      handler &&
      typeof handler === "object" &&
      "fetch" in handler &&
      typeof (handler as { fetch: Function }).fetch === "function"
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Worker Error";
    parentPort?.postMessage({
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: message })),
    });
  }
});
