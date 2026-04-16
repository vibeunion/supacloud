import { parentPort, MessageChannel } from "worker_threads";
import "./port-guard";
import "./url-import-plugin";
import {
  getCapturedServeHandler,
  clearCapturedServeHandler,
} from "./deno-compat";
import { autoInstallDeps } from "./auto-deps";

interface CachedModule {
  mod: Record<string, unknown>;
  serveHandler: ((req: Request) => Response | Promise<Response>) | null;
  lastUsed: number;
}

const moduleCache = new Map<string, CachedModule>();
const MAX_CACHED = 20;

// Track invalidation version per function to bust Bun's internal import() cache.
// Bun caches modules by resolved specifier — appending ?v=N forces a fresh load.
const moduleVersion = new Map<string, number>();

/** Try to import a function module; on missing-dep errors, auto-install and retry once.
 *  Appends a cache-busting query param to bypass Bun's internal import() cache
 *  so that re-deployed functions are loaded fresh from disk. */
async function loadModule(functionPath: string, functionId?: string): Promise<{ default: unknown }> {
  const version = functionId ? (moduleVersion.get(functionId) || 0) : 0;
  const cacheBustedPath = version > 0 ? `${functionPath}?v=${version}` : functionPath;
  try {
    return await import(cacheBustedPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Cannot find module") ||
      msg.includes("Could not resolve")
    ) {
      console.log(
        `[Worker] Module load failed, attempting auto-install for ${functionPath}`,
      );
      await autoInstallDeps(functionPath);
      // Retry after auto-install with cache-busted path
      return await import(cacheBustedPath);
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
    // Bump version so next loadModule() uses a different import specifier,
    // bypassing Bun's internal module cache
    moduleVersion.set(msg.functionId, (moduleVersion.get(msg.functionId) || 0) + 1);
    return;
  }

  // Handle function pre-heating (zero cold-start)
  if (msg.type === "preheat") {
    try {
      if (!moduleCache.has(msg.functionId)) {
        clearCapturedServeHandler();
        const mod = await loadModule(msg.functionPath, msg.functionId);
        const serveHandler =
          getCapturedServeHandler() as CachedModule["serveHandler"];
        moduleCache.set(msg.functionId, {
          mod: mod as Record<string, unknown>,
          serveHandler,
          lastUsed: Date.now(),
        });
        if (moduleCache.size > MAX_CACHED) {
          let oldest = { key: "", time: Infinity };
          for (const [k, v] of moduleCache) {
            if (v.lastUsed < oldest.time) oldest = { key: k, time: v.lastUsed };
          }
          moduleCache.delete(oldest.key);
        }
      }
      parentPort?.postMessage({
        type: "preheat_done",
        functionId: msg.functionId,
      });
    } catch (err: unknown) {
      parentPort?.postMessage({
        type: "preheat_error",
        functionId: msg.functionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  try {
    const { functionId, functionPath, env, url, method, headers, body } = msg;

    // ── Inject Supabase runtime env vars (official: always available) ──────
    // Extract projectRef and functionSlug from functionId (format: "{ref}_{slug}")
    // NOTE: project refs in SupaCloud are short alphanumeric IDs (no underscores),
    // so splitting at first underscore is reliable here.
    const underscoreIdx = functionId.indexOf("_");
    const projectRef =
      underscoreIdx > 0 ? functionId.slice(0, underscoreIdx) : functionId;
    const functionSlug =
      underscoreIdx > 0 ? functionId.slice(underscoreIdx + 1) : functionId;

    // SB_EXECUTION_ID: use the one from x-sb-execution-id header (set by server.ts) for consistency
    const executionId =
      (headers as Record<string, string>)["x-sb-execution-id"] ||
      crypto.randomUUID();

    // Only inject if not already set by tenant env (user secrets take precedence for SB_REGION)
    if (!env["SB_REGION"]) env["SB_REGION"] = process.env.SB_REGION || "local";
    if (!env["SB_EXECUTION_ID"]) env["SB_EXECUTION_ID"] = executionId;
    if (!env["DENO_DEPLOYMENT_ID"])
      env["DENO_DEPLOYMENT_ID"] = `${projectRef}_${functionSlug}_1`;
    // ── End runtime env injection ──────────────────────────────────────────

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
        const mod = await loadModule(functionPath, functionId);
        const serveHandler =
          getCapturedServeHandler() as CachedModule["serveHandler"];
        cached = {
          mod: mod as Record<string, unknown>,
          serveHandler,
          lastUsed: Date.now(),
        };
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
        typeof (handler as { handle: (req: Request) => Promise<Response> })
          .handle === "function"
      ) {
        // Elysia app
        response = await (
          handler as { handle: (req: Request) => Promise<Response> }
        ).handle(request);
      } else if (
        handler &&
        typeof handler === "object" &&
        "fetch" in handler &&
        typeof (handler as { fetch: (req: Request) => Promise<Response> })
          .fetch === "function"
      ) {
        // Hono / other fetch-based frameworks
        response = await (
          handler as { fetch: (req: Request) => Promise<Response> }
        ).fetch(request);
      } else {
        throw new Error(
          "Function must export default handler, Elysia app, or fetch-based app",
        );
      }

      // Serialize response — preserve duplicate headers (e.g. set-cookie)
      const resHeaders: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (lower === "set-cookie") {
          // Handled below to preserve all values
        } else {
          resHeaders[k] = v;
        }
      });
      // Preserve all set-cookie values as an array
      const cookies = (response.headers as any).getSetCookie?.();
      if (cookies && cookies.length > 0) {
        resHeaders["set-cookie"] = cookies;
      }
      // Detect streaming responses (SSE, chunked, text/stream, etc.)
      const contentType = response.headers.get("content-type") || "";
      const isStreaming =
        contentType.includes("text/event-stream") ||
        contentType.includes("application/octet-stream") ||
        contentType.includes("application/x-ndjson") ||
        response.headers.get("transfer-encoding") === "chunked" ||
        !response.headers.has("content-length");

      if (isStreaming && response.body) {
        // Use custom message types for chunk streaming to avoid Bun 1.x MessagePort transfer bug
        const streamId = crypto.randomUUID();
        parentPort?.postMessage({
          type: "stream_start",
          status: response.status,
          headers: resHeaders,
          streamId,
        });

        const reader = response.body.getReader();
        // Capture restore function for deferred cleanup
        const restoreEnv = () => {
          for (const [k, prev] of savedEnv) {
            if (prev === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = prev;
            }
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              parentPort?.postMessage({ type: "stream_chunk", streamId, done: true });
              break;
            }
            parentPort?.postMessage({ type: "stream_chunk", streamId, done: false, chunk: value.buffer }, [
              value.buffer,
            ]);
          }
        } catch (err) {
          parentPort?.postMessage({
            type: "stream_chunk",
            streamId,
            done: true,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          restoreEnv(); // Restore env AFTER stream ends
        }

        // Signal outer finally to skip restoration (already handled above)
        savedEnv.clear();
      } else {
        const resBody = await response.arrayBuffer();
        parentPort?.postMessage({
          status: response.status,
          headers: resHeaders,
          body: resBody,
        });
      }
    } finally {
      // Restore previous env values to avoid cross-tenant leakage
      // (For streaming responses, savedEnv is cleared above so this is a no-op)
      for (const [k, prev] of savedEnv) {
        if (prev === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = prev;
        }
      }
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Internal Worker Error";
    parentPort?.postMessage({
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: message })),
    });
  }
});
