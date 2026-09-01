import path from "path";
import { fileURLToPath } from "node:url";
import {
  initSync as initModuleLexerSync,
  parse as parseModuleImports,
} from "es-module-lexer";
import {
  assertPathInProject,
  assertRuntimeDependencyPath,
  clearCapturedServeHandler,
  DYNAMIC_CODE_DISABLED_MESSAGE,
  guardDynamicCodeApis,
  disableSubprocessApis,
  envWriteLog,
  FILESYSTEM_DISABLED_MESSAGE,
  getCapturedServeHandler,
  initializeProjectRootControl,
  isKnownRuntimeBuiltinSpecifier,
  NATIVE_LOADER_DISABLED_MESSAGE,
  setInjectedEnv,
  SUBPROCESS_DISABLED_MESSAGE,
  tenantBuiltinSpecifier,
} from "./deno-compat";
import { installEdgeFetchTlsPolicy, resolveEdgeFetchTlsPolicy } from "./fetch-tls-policy";
import type { EdgeFetchTlsPolicy } from "./fetch-tls-policy";
import { runWithPgredisBinding } from "./internal-bindings";
import {
  isCanonicalArtifactSha256,
  isEdgeRuntimePreheatIdentity,
  type EdgeRuntimePreheatIdentity,
} from "./preheat-attestation";

const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads");
import type { PgredisRuntimeBindingConfig } from "./internal-bindings";
import {
  assertTrustedFunctionArtifact,
  withTrustedFunctionArtifact,
} from "./trusted-function-files";

const runtimeBunFile = Bun.file.bind(Bun);
const setProjectRoot = initializeProjectRootControl();

export function getInjectedEnv(): Record<string, string> {
  return currentInjectedEnv;
}

if (!parentPort) throw new Error("This file must be run as a Worker");
initModuleLexerSync();
disableSubprocessApis();
guardDynamicCodeApis((source) => {
  const [generatedImports] = parseModuleImports(source);
  if (generatedImports.length > 0) throw new Error(DYNAMIC_CODE_DISABLED_MESSAGE);
});

const MAX_MODULE_CACHE = 20;

type ModuleCacheEntry = {
  handler: unknown;
  functionId: string;
  projectRef: string;
  lastUsed: number;
};

type LoadModuleResult = {
  handler: unknown;
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
  projectRef: string;
  moduleVersion?: string;
  envProof?: string;
  artifactSha256?: string;
  attestation?: EdgeRuntimePreheatIdentity;
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
  framework?: "fetch" | "elysia" | "hono" | "sveltekit-function";
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

type ModuleIdentity = {
  functionId: string;
  functionPath: string;
  moduleVersion: string;
  envProof: string;
  artifactSha256: string;
};

function buildModuleCacheKey(identity: ModuleIdentity): string {
  return [
    identity.functionId,
    identity.functionPath,
    identity.moduleVersion,
    identity.envProof,
    identity.artifactSha256,
  ].join("\n");
}

function buildModuleImportUrl(identity: ModuleIdentity): string {
  const query = new URLSearchParams({
    version: identity.moduleVersion,
    env_proof: identity.envProof,
    artifact_sha256: identity.artifactSha256,
  });
  return `${identity.functionPath}?${query.toString()}`;
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

async function importModuleHandler(importUrl: string): Promise<unknown> {
  clearCapturedServeHandler();
  try {
    const moduleNamespace = await import(importUrl) as Record<string, unknown>;
    const serveHandler = getCapturedServeHandler();
    return moduleNamespace.default
      || moduleNamespace.handler
      || serveHandler
      || moduleNamespace;
  } finally {
    clearCapturedServeHandler();
  }
}

async function assertAttestedArtifact(
  functionPath: string,
  identity: EdgeRuntimePreheatIdentity | undefined,
): Promise<void> {
  if (!identity) return;
  await assertTrustedFunctionArtifact(functionPath, identity.artifact_sha256);
}

async function assertExpectedArtifact(
  functionPath: string,
  expectedSha256: string | undefined,
): Promise<void> {
  if (expectedSha256 === undefined) return;
  await assertTrustedFunctionArtifact(functionPath, expectedSha256);
}

const DISABLED_TENANT_MODULES = new Map([
  ["bun:ffi", SUBPROCESS_DISABLED_MESSAGE],
  ["child_process", SUBPROCESS_DISABLED_MESSAGE],
  ["cluster", SUBPROCESS_DISABLED_MESSAGE],
  ["node:child_process", SUBPROCESS_DISABLED_MESSAGE],
  ["node:cluster", SUBPROCESS_DISABLED_MESSAGE],
  ["node:worker_threads", SUBPROCESS_DISABLED_MESSAGE],
  ["worker_threads", SUBPROCESS_DISABLED_MESSAGE],
  ["fs", FILESYSTEM_DISABLED_MESSAGE],
  ["fs/promises", FILESYSTEM_DISABLED_MESSAGE],
  ["node:fs", FILESYSTEM_DISABLED_MESSAGE],
  ["node:fs/promises", FILESYSTEM_DISABLED_MESSAGE],
  ["bun:jsc", NATIVE_LOADER_DISABLED_MESSAGE],
  ["inspector", NATIVE_LOADER_DISABLED_MESSAGE],
  ["module", NATIVE_LOADER_DISABLED_MESSAGE],
  ["node:inspector", NATIVE_LOADER_DISABLED_MESSAGE],
  ["node:module", NATIVE_LOADER_DISABLED_MESSAGE],
  ["node:v8", NATIVE_LOADER_DISABLED_MESSAGE],
  ["node:vm", NATIVE_LOADER_DISABLED_MESSAGE],
  ["v8", NATIVE_LOADER_DISABLED_MESSAGE],
  ["vm", NATIVE_LOADER_DISABLED_MESSAGE],
]);

const COMPUTED_DYNAMIC_IMPORT_DISABLED_MESSAGE =
  "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.";
const UNSUPPORTED_MODULE_PROTOCOL_MESSAGE =
  "Unsupported module URL protocol in the multi-tenant Edge Runtime.";
const RUNTIME_RESOLVED_MODULE_PREFIXES = [
  "node:",
  "bun:",
  "npm:",
  "jsr:",
  "https://deno.land/std",
  "https://esm.sh/",
  "https://cdn.skypack.dev/",
];

function moduleLoader(filePath: string): "js" | "jsx" | "ts" | "tsx" | null {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return "ts";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "js";
  return null;
}

function isDynamicImportLiteral(source: string, start: number, end: number): boolean {
  const expression = source.slice(start, end).trim();
  const quote = expression[0];
  if ((quote !== "\"" && quote !== "'" && quote !== "`") || expression.length < 2) {
    return false;
  }

  for (let index = 1; index < expression.length; index++) {
    const character = expression[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote === "`" && character === "$" && expression[index + 1] === "{") {
      return false;
    }
    if (character === quote) {
      return expression.slice(index + 1).trim() === "";
    }
  }
  return false;
}

async function assertTenantModuleGraphSafe(
  entryPath: string,
  visited = new Set<string>(),
  requireSingleFile = false,
): Promise<void> {
  const resolvedEntry = path.resolve(entryPath);
  if (visited.has(resolvedEntry)) return;
  visited.add(resolvedEntry);

  assertPathInProject(resolvedEntry);
  const loader = moduleLoader(resolvedEntry);
  if (!loader) return;
  const source = await Bun.file(resolvedEntry).text();
  const [moduleImports] = parseModuleImports(source);
  if (moduleImports.some((imported) => (
    imported.d >= 0 && !isDynamicImportLiteral(source, imported.s, imported.e)
  ))) {
    throw new Error(COMPUTED_DYNAMIC_IMPORT_DISABLED_MESSAGE);
  }
  const imports = new Bun.Transpiler({ loader })
    .scanImports(source);
  for (const imported of imports) {
    const disabledMessage = DISABLED_TENANT_MODULES.get(imported.path);
    if (disabledMessage) {
      throw new Error(disabledMessage);
    }
    if (tenantBuiltinSpecifier(imported.path)) {
      continue;
    }
    if (
      isKnownRuntimeBuiltinSpecifier(imported.path)
      || imported.path.startsWith("node:")
      || imported.path.startsWith("bun:")
    ) {
      throw new Error(NATIVE_LOADER_DISABLED_MESSAGE);
    }
    if (requireSingleFile) {
      throw new Error("Attested Function artifact must be a self-contained module");
    }
    let dependencyPath = imported.path;
    if (dependencyPath.startsWith("file:")) {
      dependencyPath = fileURLToPath(dependencyPath);
    } else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(dependencyPath)) {
      if (RUNTIME_RESOLVED_MODULE_PREFIXES.some((prefix) => dependencyPath.startsWith(prefix))) {
        continue;
      }
      throw new Error(UNSUPPORTED_MODULE_PROTOCOL_MESSAGE);
    } else if (!dependencyPath.startsWith(".") && !path.isAbsolute(dependencyPath)) {
      continue;
    } else if (!path.isAbsolute(dependencyPath)) {
      try {
        dependencyPath = Bun.resolveSync(imported.path, path.dirname(resolvedEntry));
      } catch {
        continue;
      }
    }
    try {
      assertPathInProject(dependencyPath);
    } catch {
      try {
        assertRuntimeDependencyPath(dependencyPath);
      } catch {
        throw new Error(`Access denied: module "${imported.path}" is outside the project directory`);
      }
      continue;
    }
    await assertTenantModuleGraphSafe(dependencyPath, visited, requireSingleFile);
  }
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
  return tlsPolicy ?? await resolveEdgeFetchTlsPolicy(
    currentInjectedEnv,
    originalProcessEnv,
    (caFile) => runtimeBunFile(caFile).text(),
  );
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
  projectRoot: string;
  moduleVersion?: string;
  projectRef: string;
  envProof?: string;
  artifactSha256?: string;
}): Promise<LoadModuleResult> {
  const identity: ModuleIdentity = {
    functionId: input.functionId,
    functionPath: input.functionPath,
    moduleVersion: input.moduleVersion || "unversioned",
    envProof: input.envProof || "unverified-env",
    artifactSha256: input.artifactSha256 || "unverified-artifact",
  };
  const cacheKey = buildModuleCacheKey(identity);
  const cached = moduleCache.get(cacheKey);
  if (cached) {
    try {
      await assertExpectedArtifact(input.functionPath, input.artifactSha256);
    } catch (error: unknown) {
      moduleCache.delete(cacheKey);
      throw error;
    }
    cached.lastUsed = Date.now();
    return { handler: cached.handler, cacheHit: true, moduleCacheSize: moduleCache.size };
  }

  evictOldestModule();

  await assertTenantModuleGraphSafe(
    input.functionPath,
    new Set<string>(),
    input.artifactSha256 !== undefined,
  );
  const handler = input.artifactSha256 === undefined
    ? await importModuleHandler(buildModuleImportUrl(identity))
    : await withTrustedFunctionArtifact(
        input.functionPath,
        input.artifactSha256,
        (descriptorPath) => importModuleHandler(buildModuleImportUrl({
          ...identity,
          functionPath: descriptorPath,
        })),
      );
  moduleCache.set(cacheKey, {
    handler,
    functionId: input.functionId,
    projectRef: input.projectRef,
    lastUsed: Date.now(),
  });
  return { handler, cacheHit: false, moduleCacheSize: moduleCache.size };
}

async function executeFunction(handler: unknown, request: Request): Promise<Response> {
  if (typeof handler === "function") {
    const result = await handler(request);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (handler && typeof handler === "object") {
    const objectHandler = handler as Record<string, unknown>;
    if (typeof objectHandler.handle === "function") {
      const result = await objectHandler.handle(request);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof objectHandler.fetch === "function") {
      const result = await objectHandler.fetch(request);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  throw new Error(
    "Function must export a default function, an object with handle()/fetch(), " +
    "or register a handler with Deno.serve().",
  );
}

function isFrameworkRouterHandler(handler: unknown): handler is FrameworkRouterHandler {
  if (!handler || typeof handler !== "object") return false;
  const candidate = handler as Record<string, unknown>;
  const metadata = candidate.__supacloud as Record<string, unknown> | undefined;
  return metadata?.routeAware === true
    || Array.isArray(candidate.routes)
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

function hasPreheatArtifactFields(candidate: Record<string, unknown>): boolean {
  if (candidate.artifactSha256 !== undefined
    && !isCanonicalArtifactSha256(candidate.artifactSha256)) return false;
  if (candidate.attestation === undefined) return true;
  return isEdgeRuntimePreheatIdentity(candidate.attestation)
    && candidate.artifactSha256 === candidate.attestation.artifact_sha256;
}

function hasPreheatFields(candidate: Record<string, unknown>): boolean {
  return typeof candidate.functionId === "string"
    && typeof candidate.functionPath === "string"
    && typeof candidate.projectRoot === "string"
    && typeof candidate.projectRef === "string"
    && (candidate.moduleVersion === undefined || typeof candidate.moduleVersion === "string")
    && (candidate.envProof === undefined || typeof candidate.envProof === "string")
    && hasPreheatArtifactFields(candidate)
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
      const env = msg.env || {};
      setProjectRoot(msg.projectRoot || path.dirname(msg.functionPath));
      injectEnv(env);
      setInjectedEnv(env);
      const restoreFetchTlsPolicy = installEdgeFetchTlsPolicy(
        await resolveMessageTlsPolicy(msg.tlsPolicy),
      );
      try {
        await assertAttestedArtifact(msg.functionPath, msg.attestation);
        const moduleLoad = await loadModule({
          functionId: msg.functionId,
          functionPath: msg.functionPath,
          projectRoot: msg.projectRoot,
          moduleVersion: msg.moduleVersion,
          projectRef: msg.projectRef,
          envProof: msg.envProof,
          artifactSha256: msg.artifactSha256,
        });
        await assertAttestedArtifact(msg.functionPath, msg.attestation);
        postToParent({
          type: "preheat_done",
          functionId: msg.functionId,
          moduleCacheHit: moduleLoad.cacheHit,
          moduleCacheSize: moduleLoad.moduleCacheSize,
          attestation: msg.attestation
            ? { ...msg.attestation, module_loaded: true }
            : undefined,
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

  const projectRef = msg.projectRef;
  const requestAbortController = new AbortController();
  currentAbortController = requestAbortController;
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
      projectRoot,
      moduleVersion: msg.moduleVersion,
      projectRef,
      envProof: msg.envProof,
      artifactSha256: msg.artifactSha256,
    });
    // Retirement may arrive while module loading is suspended. Do not enter
    // tenant code after the worker has already closed its parent port.
    if (requestAbortController.signal.aborted) {
      const abortReason = requestAbortController.signal.reason;
      throw abortReason instanceof Error
        ? abortReason
        : new DOMException("Task cancelled", "AbortError");
    }
    try {
      await assertExpectedArtifact(functionPath, msg.artifactSha256);
    } catch (error: unknown) {
      invalidateCachedModules((entry) => entry.functionId === functionId);
      throw error;
    }
    postToParent({ type: "execution_started", functionId });
    const handler = moduleLoad.handler;
    await runWithPgredisBinding(internalBindings
      ? { ...internalBindings, signal: requestAbortController.signal }
      : undefined, async () => {
        const handlerUrl = (msg.framework && msg.framework !== "fetch") || isFrameworkRouterHandler(handler)
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
