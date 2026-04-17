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

/** Try to import a function module; on missing-dep errors, auto-install and retry once */
async function loadModule(functionPath: string): Promise<{ default: unknown }> {
  try {
    return await import(functionPath);
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
      return await import(functionPath);
    }
    throw err;
  }
}

interface WorkerMessage {
  type?: string;
  functionId?: string;
  functionPath?: string;
  env?: Record<string, string>;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | null;
}

type LogStream = "stdout" | "stderr";

function postWorkerLog(stream: LogStream, args: unknown[]) {
  try {
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

    parentPort?.postMessage({
      type: "log",
      stream,
      level: stream === "stderr" ? "error" : "info",
      timestamp: new Date().toISOString(),
      message,
    });
  } catch {
    // ignore logging failures
  }
}

let currentAbortController: AbortController | null = null;
let currentBackgroundTaskId: string | null = null;

parentPort?.on("message", async (msg: WorkerMessage) => {
  // Handle cache invalidation messages from pool (belt-and-suspenders:
  // the pool replaces workers on invalidation, but this handles edge cases
  // where a message arrives before the worker is terminated)
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

  if (msg.type === "cancel_current") {
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort(
        new DOMException("Task cancelled", "AbortError"),
      );
    }
    parentPort?.postMessage({
      type: "cancel_ack",
      taskId: currentBackgroundTaskId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const { functionId, functionPath, env, url, method, headers, body } = msg;
    if (!functionId || !functionPath || !env || !url || !method || !headers) {
      throw new Error("Invalid worker invocation payload");
    }
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    console.log = (...args: unknown[]) => {
      postWorkerLog("stdout", args);
      originalConsole.log(...args);
    };
    console.info = (...args: unknown[]) => {
      postWorkerLog("stdout", args);
      originalConsole.info(...args);
    };
    console.warn = (...args: unknown[]) => {
      postWorkerLog("stderr", args);
      originalConsole.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      postWorkerLog("stderr", args);
      originalConsole.error(...args);
    };
    console.debug = (...args: unknown[]) => {
      postWorkerLog("stdout", args);
      originalConsole.debug(...args);
    };

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
    if ((headers as Record<string, string>)["x-supacloud-background"] === "true") {
      env["SUPACLOUD_BACKGROUND_TASK_ID"] =
        (headers as Record<string, string>)["x-supacloud-task-id"] || "";
      env["SUPACLOUD_BACKGROUND_ATTEMPT"] =
        (headers as Record<string, string>)["x-supacloud-attempt"] || "1";
      env["SUPACLOUD_CANCELLATION_SIGNAL"] = "supported";
    }
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
      currentAbortController = new AbortController();
      currentBackgroundTaskId = headers["x-supacloud-task-id"] || null;

      // Load module (LRU cache)
      let cached = moduleCache.get(functionId);
      if (!cached) {
        clearCapturedServeHandler();
        const mod = await loadModule(functionPath);
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
      const init: RequestInit = {
        method,
        headers: new Headers(headers),
        signal: currentAbortController.signal,
      };
      if (body && !["GET", "HEAD"].includes(method)) init.body = body;
      const request = new Request(url, init);

      // Call function (supports bare handler, Elysia app, or Hono/other)
      const handler = cached.serveHandler || cached.mod.default;
      let response: Response;
      if (typeof handler === "function") {
        response = await (handler as (req: Request) => Promise<Response>)(request);
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
      currentAbortController = null;
      currentBackgroundTaskId = null;
      // Restore previous env values to avoid cross-tenant leakage
      // (For streaming responses, savedEnv is cleared above so this is a no-op)
      for (const [k, prev] of savedEnv) {
        if (prev === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = prev;
        }
      }
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
    }
  } catch (err: unknown) {
    const isAbortError =
      err instanceof DOMException
        ? err.name === "AbortError"
        : err instanceof Error && err.name === "AbortError";
    const status = isAbortError ? 499 : 500;
    const message =
      err instanceof Error ? err.message : "Internal Worker Error";
    parentPort?.postMessage({
      status,
      headers: { "Content-Type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: message })),
    });
  }
});
