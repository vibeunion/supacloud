import { parentPort } from "worker_threads";
import path from "path";
import { getCapturedServeHandler, clearCapturedServeHandler, setProjectRoot, setInjectedEnv, envWriteLog } from "./deno-compat";
import { installEdgeFetchTlsPolicy, resolveEdgeFetchTlsPolicy } from "./fetch-tls-policy";
import type { EdgeFetchTlsPolicy } from "./fetch-tls-policy";
import { runWithPgredisBinding } from "./internal-bindings";
import type { PgredisRuntimeBindingConfig } from "./internal-bindings";

export function getInjectedEnv(): Record<string, string> {
  return currentInjectedEnv;
}

if (!parentPort) throw new Error("This file must be run as a Worker");

const MAX_MODULE_CACHE = 20;

type ModuleCacheEntry = {
  module: any;
  functionId: string;
  projectRef: string | null;
  lastUsed: number;
};

type LoadModuleResult = {
  handler: any;
  cacheHit: boolean;
  moduleCacheSize: number;
};

type FrameworkRouterHandler = Record<string, unknown> & {
  routes: unknown[];
};

type InvalidateModuleMessage = { type: "invalidate_module"; functionId: string };
type InvalidateProjectMessage = { type: "invalidate_project"; projectRef: string };
type WorkerLifecycleMessage = { type: "cancel_current" } | { type: "retire" };
type PreheatMessage = {
  type: "preheat";
  functionId: string;
  functionPath: string;
  projectRoot: string;
  projectRef?: string;
  moduleVersion?: string;
  env: Record<string, string>;
  tlsPolicy?: EdgeFetchTlsPolicy;
};
type ExecuteMessage = Omit<PreheatMessage, "type"> & {
  type?: undefined;
  url: string;
  method: string;
  headers: Record<string, string | string[]>;
  body?: ArrayBuffer | null;
  internalBindings?: Omit<PgredisRuntimeBindingConfig, "signal">;
};
type ParentMessage =
  | InvalidateModuleMessage
  | InvalidateProjectMessage
  | WorkerLifecycleMessage
  | PreheatMessage
  | ExecuteMessage;

const moduleCache = new Map<string, ModuleCacheEntry>();

function evictOldestModule() {
  while (moduleCache.size >= MAX_MODULE_CACHE) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, entry] of moduleCache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      moduleCache.delete(oldestKey);
    } else {
      break;
    }
  }
}

function buildModuleCacheKey(functionId: string, functionPath: string, moduleVersion: string): string {
  return `${functionId}\n${functionPath}\n${moduleVersion}`;
}

function buildModuleImportUrl(functionPath: string, moduleVersion: string): string {
  return `${functionPath}?v=${encodeURIComponent(moduleVersion)}`;
}

function invalidateCachedModules(predicate: (entry: ModuleCacheEntry) => boolean): number {
  let invalidated = 0;
  for (const [key, entry] of moduleCache) {
    if (predicate(entry)) {
      moduleCache.delete(key);
      invalidated++;
    }
  }
  return invalidated;
}

const originalProcessEnv = process.env;
const bunRuntime = (globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } }).Bun;
const originalBunEnv = bunRuntime ? { ...bunRuntime.env } : null;
let envSnapshotActive = false;
let currentAbortController: AbortController | null = null;
let currentInjectedEnv: Record<string, string> = {};
let currentWaitUntilTasks: Promise<unknown>[] = [];
let retiring = false;

async function resolveMessageTlsPolicy(
  tlsPolicy: EdgeFetchTlsPolicy | undefined,
): Promise<EdgeFetchTlsPolicy> {
  return tlsPolicy ?? await resolveEdgeFetchTlsPolicy(currentInjectedEnv, originalProcessEnv);
}

function injectEnv(env: Record<string, string>) {
  if (envSnapshotActive) restoreEnv();
  currentInjectedEnv = { ...env };
  process.env = { ...env } as NodeJS.ProcessEnv;
  if (bunRuntime) {
    for (const key of Object.keys(bunRuntime.env)) {
      delete bunRuntime.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      bunRuntime.env[key] = value;
    }
  }
  envSnapshotActive = true;
}

function restoreEnv() {
  if (!envSnapshotActive) return;
  process.env = originalProcessEnv;
  if (bunRuntime && originalBunEnv) {
    for (const key of Object.keys(bunRuntime.env)) {
      delete bunRuntime.env[key];
    }
    for (const [key, value] of Object.entries(originalBunEnv)) {
      bunRuntime.env[key] = value;
    }
  }
  envWriteLog.clear();
  currentInjectedEnv = {};
  envSnapshotActive = false;
}

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
};

function setupConsoleCapture(functionId: string) {
  const sendLog = (stream: "stdout" | "stderr", level: string, ...args: any[]) => {
    try {
      postToParent({
        type: "log",
        timestamp: new Date().toISOString(),
        stream,
        level,
        message: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "),
        functionId,
      });
    } catch {}
  };

  console.log = (...args: any[]) => { originalConsole.log(...args); sendLog("stdout", "info", ...args); };
  console.warn = (...args: any[]) => { originalConsole.warn(...args); sendLog("stderr", "warn", ...args); };
  console.error = (...args: any[]) => { originalConsole.error(...args); sendLog("stderr", "error", ...args); };
  console.info = (...args: any[]) => { originalConsole.info(...args); sendLog("stdout", "info", ...args); };
  console.debug = (...args: any[]) => { originalConsole.debug(...args); sendLog("stdout", "debug", ...args); };
}

function restoreConsole() {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
  }
}

function setupEdgeRuntimeCompat() {
  currentWaitUntilTasks = [];
  (globalThis as any).EdgeRuntime = {
    waitUntil(promise: PromiseLike<unknown> | unknown) {
      const task = Promise.resolve(promise).catch((error) => {
        console.error("[EdgeRuntime.waitUntil] background task failed", error);
      });
      currentWaitUntilTasks.push(task);
    },
  };
}

async function flushWaitUntilTasks(functionId: string) {
  if (currentWaitUntilTasks.length === 0) return;
  while (currentWaitUntilTasks.length > 0) {
    const tasks = currentWaitUntilTasks.splice(0);
    await Promise.allSettled(tasks);
  }
  postToParent({
    type: "wait_until_done",
    functionId,
  });
}

function clearEdgeRuntimeCompat() {
  currentWaitUntilTasks = [];
  delete (globalThis as any).EdgeRuntime;
}

async function loadModule(input: {
  functionId: string;
  functionPath: string;
  moduleVersion?: string;
  projectRef?: string | null;
}): Promise<LoadModuleResult> {
  const moduleVersion = input.moduleVersion || "unversioned";
  const cacheKey = buildModuleCacheKey(input.functionId, input.functionPath, moduleVersion);
  const cached = moduleCache.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return { handler: cached.module, cacheHit: true, moduleCacheSize: moduleCache.size };
  }

  evictOldestModule();

  const mod = await import(buildModuleImportUrl(input.functionPath, moduleVersion));
  const handler = mod.default || mod.handler || mod;
  moduleCache.set(cacheKey, {
    module: handler,
    functionId: input.functionId,
    projectRef: input.projectRef || null,
    lastUsed: Date.now(),
  });
  return { handler, cacheHit: false, moduleCacheSize: moduleCache.size };
}

async function executeFunction(handler: any, request: Request): Promise<Response> {
  clearCapturedServeHandler();

  if (typeof handler === "function") {
    const result = await handler(request);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (handler && typeof handler === "object") {
    if (typeof handler.handle === "function") {
      const result = await handler.handle(request);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof handler.fetch === "function") {
      const result = await handler.fetch(request);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const captured = getCapturedServeHandler();
  if (captured) {
    const result = await captured(request);
    if (result instanceof Response) return result;
  }

  throw new Error(
    "Function must export a default function, an object with handle(), or an object with fetch(). " +
    "For Bun.serve() / Deno.serve(), use the fetch pattern: export default { fetch(req) { return new Response('ok') } }",
  );
}

function isFrameworkRouterHandler(handler: unknown): handler is FrameworkRouterHandler {
  if (!handler || typeof handler !== "object") return false;
  const candidate = handler as Record<string, unknown>;
  return Array.isArray(candidate.routes)
    && (typeof candidate.handle === "function" || typeof candidate.fetch === "function");
}

function toFunctionLocalUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const publicRoute = url.pathname.match(/^\/functions\/v1\/[^/]+(\/.*)?$/);
  if (publicRoute) {
    url.pathname = publicRoute[1] || "/";
    return url.toString();
  }

  const internalRoute = url.pathname.match(/^\/[^/]+(\/.*)?$/);
  if (internalRoute) {
    url.pathname = internalRoute[1] || "/";
  }
  return url.toString();
}

function extractProjectRef(functionId: string): string | null {
  const idx = functionId.indexOf("_");
  if (idx === -1) return null;
  return functionId.substring(0, idx);
}

function isStringRecord(candidate: unknown): candidate is Record<string, string> {
  if (!candidate || typeof candidate !== "object") return false;
  return Object.values(candidate).every((entry) => typeof entry === "string");
}

function isHeaderRecord(candidate: unknown): candidate is Record<string, string | string[]> {
  if (!candidate || typeof candidate !== "object") return false;
  return Object.values(candidate).every((header) =>
    typeof header === "string"
      || Array.isArray(header) && header.every((entry) => typeof entry === "string")
  );
}

function isTlsPolicy(candidate: unknown): candidate is EdgeFetchTlsPolicy {
  if (!candidate || typeof candidate !== "object") return false;
  const policy = candidate as Record<string, unknown>;
  return typeof policy.source === "string"
    && ["none", "ca-inline", "ca-file", "insecure"].includes(policy.source)
    && (policy.ca === undefined || typeof policy.ca === "string")
    && (policy.rejectUnauthorized === undefined || typeof policy.rejectUnauthorized === "boolean");
}

function hasPreheatFields(candidate: Record<string, unknown>): boolean {
  return typeof candidate.functionId === "string"
    && typeof candidate.functionPath === "string"
    && typeof candidate.projectRoot === "string"
    && (candidate.projectRef === undefined || typeof candidate.projectRef === "string")
    && (candidate.moduleVersion === undefined || typeof candidate.moduleVersion === "string")
    && isStringRecord(candidate.env)
    && (candidate.tlsPolicy === undefined || isTlsPolicy(candidate.tlsPolicy));
}

function isExecuteMessage(candidate: Record<string, unknown>): boolean {
  return candidate.type === undefined
    && hasPreheatFields(candidate)
    && typeof candidate.url === "string"
    && typeof candidate.method === "string"
    && isHeaderRecord(candidate.headers)
    && (candidate.body == null || candidate.body instanceof ArrayBuffer)
    && (candidate.internalBindings === undefined || isInternalBindings(candidate.internalBindings));
}

function isInternalBindings(candidate: unknown): candidate is Omit<PgredisRuntimeBindingConfig, "signal"> {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Record<string, unknown>;
  return typeof value.baseUrl === "string"
    && typeof value.capabilityToken === "string"
    && typeof value.timeoutMs === "number";
}

function isParentMessage(message: unknown): message is ParentMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  if (candidate.type === "retire" || candidate.type === "cancel_current") return true;
  if (candidate.type === "invalidate_module") return typeof candidate.functionId === "string";
  if (candidate.type === "invalidate_project") return typeof candidate.projectRef === "string";
  if (candidate.type === "preheat") return hasPreheatFields(candidate);
  return isExecuteMessage(candidate);
}

function postToParent(message: unknown) {
  if (retiring) return;
  parentPort!.postMessage(message);
}

async function onParentMessage(msg: unknown): Promise<void> {
  if (!isParentMessage(msg)) {
    console.warn("[Worker] Ignoring invalid parent message");
    return;
  }

  if (msg.type === "retire") {
    if (retiring) return;
    retiring = true;
    currentAbortController?.abort(new DOMException("Worker retiring", "AbortError"));
    parentPort!.off("message", onParentMessage);
    parentPort!.close();
    return;
  }

  if (retiring) return;

  if (msg.type === "invalidate_module") {
    const invalidated = invalidateCachedModules((entry) => entry.functionId === msg.functionId);
    postToParent({
      type: "invalidate_done",
      functionId: msg.functionId,
      invalidated,
      moduleCacheSize: moduleCache.size,
    });
    return;
  }

  if (msg.type === "invalidate_project") {
    const invalidated = invalidateCachedModules((entry) => entry.projectRef === msg.projectRef);
    postToParent({
      type: "invalidate_done",
      projectRef: msg.projectRef,
      invalidated,
      moduleCacheSize: moduleCache.size,
    });
    return;
  }

  if (msg.type === "preheat") {
    try {
      const ref = msg.projectRef || extractProjectRef(msg.functionId);
      const env = msg.env || {};
      setProjectRoot(msg.projectRoot || path.dirname(msg.functionPath));
      injectEnv(env);
      setInjectedEnv(env);
      const restoreFetchTlsPolicy = installEdgeFetchTlsPolicy(
        await resolveMessageTlsPolicy(msg.tlsPolicy),
      );
      try {
        const moduleLoad = await loadModule({
          functionId: msg.functionId,
          functionPath: msg.functionPath,
          moduleVersion: msg.moduleVersion,
          projectRef: ref,
        });
        postToParent({
          type: "preheat_done",
          functionId: msg.functionId,
          moduleCacheHit: moduleLoad.cacheHit,
          moduleCacheSize: moduleLoad.moduleCacheSize,
        });
      } finally {
        restoreFetchTlsPolicy();
      }
    } catch (err: any) {
      postToParent({
        type: "preheat_error",
        functionId: msg.functionId,
        error: err.message,
      });
    } finally {
      restoreEnv();
      setProjectRoot(null);
      setInjectedEnv({});
    }
    return;
  }

  if (msg.type === "cancel_current") {
    currentAbortController?.abort(new DOMException("Task cancelled", "AbortError"));
    postToParent({ type: "cancel_ack" });
    return;
  }

  const { functionId, functionPath, projectRoot, env, tlsPolicy, url, method, headers, body, internalBindings } = msg;

  const projectRef = msg.projectRef || extractProjectRef(functionId);
  let restoreFetchTlsPolicy = () => {};

  try {
    setProjectRoot(projectRoot || path.dirname(functionPath));
    injectEnv(env);
    setInjectedEnv(env);
    setupConsoleCapture(functionId);
    setupEdgeRuntimeCompat();
    restoreFetchTlsPolicy = installEdgeFetchTlsPolicy(
      await resolveMessageTlsPolicy(tlsPolicy),
    );
    const moduleLoad = await loadModule({
      functionId,
      functionPath,
      moduleVersion: msg.moduleVersion,
      projectRef,
    });
    const handler = moduleLoad.handler;
    const requestAbortController = new AbortController();
    currentAbortController = requestAbortController;
    await runWithPgredisBinding(internalBindings
      ? { ...internalBindings, signal: requestAbortController.signal }
      : undefined, async () => {
        const handlerUrl = isFrameworkRouterHandler(handler)
          ? toFunctionLocalUrl(url)
          : url;
        const req = new Request(handlerUrl, {
          method,
          headers: new Headers(headers as Record<string, string>),
          body: body ? Buffer.from(body) : undefined,
          signal: requestAbortController.signal,
        });

        const response = await executeFunction(handler, req);

        if (
          response.body &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          const streamId = crypto.randomUUID();
          postToParent({
            type: "stream_start",
            streamId,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            moduleCacheHit: moduleLoad.cacheHit,
            moduleCacheSize: moduleLoad.moduleCacheSize,
          });

          try {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                postToParent({
                  type: "stream_chunk",
                  streamId,
                  done: true,
                });
                break;
              }
              postToParent({
                type: "stream_chunk",
                streamId,
                chunk: Buffer.from(value).buffer,
                done: false,
              });
            }
          } catch (err: any) {
            postToParent({
              type: "stream_chunk",
              streamId,
              done: true,
              error: err.message,
            });
          }

          return;
        }

        const resBody = response.body
          ? Buffer.from(await response.arrayBuffer()).buffer
          : null;

        const resHeaders: Record<string, string | string[]> = {};
        response.headers.forEach((v, k) => {
          if (k.toLowerCase() === "set-cookie") {
            const cookies = (response.headers as any).getSetCookie?.();
            if (cookies && cookies.length > 1) {
              resHeaders[k] = cookies;
              return;
            }
          }
          resHeaders[k] = v;
        });

        postToParent({
          status: response.status,
          headers: resHeaders,
          body: resBody,
          waitUntilPending: currentWaitUntilTasks.length > 0,
          moduleCacheHit: moduleLoad.cacheHit,
          moduleCacheSize: moduleLoad.moduleCacheSize,
        });
        await flushWaitUntilTasks(functionId);
      });
  } catch (err: any) {
    const aborted = currentAbortController?.signal.aborted || err?.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    postToParent({
      status: aborted ? 499 : 500,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(
        JSON.stringify({ error: message, name: err.name }),
      ).buffer,
    });
  } finally {
    runCleanup(restoreFetchTlsPolicy);
    currentAbortController = null;
    runCleanup(clearEdgeRuntimeCompat);
    runCleanup(restoreEnv);
    runCleanup(restoreConsole);
    runCleanup(() => setProjectRoot(null));
    runCleanup(() => setInjectedEnv({}));
  }
}

parentPort.on("message", onParentMessage);
