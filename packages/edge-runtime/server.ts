import "./url-import-plugin";
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { WorkerPool } from "./worker-pool";
import {
  invalidateTenantEnvCache,
  loadTenantEnv,
  withBackgroundInternalToken,
} from "./tenant-env";
import {
  normalizeEdgeRuntimeAuthRuntimeMode,
  normalizeJwtJwks,
  normalizeThirdPartyJwtPolicy,
  readEdgeRuntimeProjectSecrets,
  verifyEdgeRuntimeJwtContext,
  withVerifiedJwtContext,
  type EdgeRuntimeAuthRuntimeMode,
  type EdgeRuntimeJwtVerificationResult,
} from "./jwt-verifier";
import {
  buildBackgroundForwardDispatch,
} from "./background-forward";
import { activeFunctionPathCandidates, functionPathCandidates } from "./function-source";
import path from "path";
import fs from "fs/promises";
import type { PgredisRuntimeEndpointConfig } from "./internal-bindings";
import { createPgredisCapability } from "./pgredis-capability";

const PORT = Number(process.env.EDGE_RUNTIME_PORT) || Number(process.env.PORT) || 9005;
const HOST = process.env.EDGE_RUNTIME_HOST || process.env.HOST || "127.0.0.1";
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;
const BACKGROUND_POOL_SIZE = Number(process.env.BACKGROUND_WORKER_POOL_SIZE) || Math.max(1, Math.min(POOL_SIZE, 2));
const BACKGROUND_PREHEAT_MODE = process.env.EDGE_BACKGROUND_PREHEAT_MODE || "one";
const FOREGROUND_WORKER_SMOL = resolveBooleanEnv(
  process.env.EDGE_FOREGROUND_WORKER_SMOL ?? process.env.WORKER_SMOL,
  false,
);
const BACKGROUND_WORKER_SMOL = resolveBooleanEnv(
  process.env.EDGE_BACKGROUND_WORKER_SMOL ?? process.env.WORKER_SMOL,
  true,
);
const FUNCTIONS_DIR = path.resolve(process.env.EDGE_FUNCTIONS_DIR || "./functions");
const FUNCTIONS_BASE_DIR = path.resolve(process.env.EDGE_FUNCTIONS_BASE_DIR || FUNCTIONS_DIR);
const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const FUNCTION_REQUEST_TIMEOUT_MS = Number(process.env.EDGE_FUNCTION_TIMEOUT_MS) || 60_000;
const BACKGROUND_FUNCTION_TIMEOUT_MS = Number(process.env.EDGE_BACKGROUND_FUNCTION_TIMEOUT_MS) || 300_000;
const WORKER_RECYCLE_RESPONSE_GRACE_MS = 100;
const INTERNAL_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";
const PROJECT_REF_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FUNCTION_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const AUTH_FAILURE_WINDOW_MS = Number(process.env.EDGE_AUTH_FAILURE_WINDOW_MS) || 30_000;
const AUTH_FAILURE_LIMIT = Number(process.env.EDGE_AUTH_FAILURE_LIMIT) || 8;
const AUTH_FAILURE_COOLDOWN_MS = Number(process.env.EDGE_AUTH_FAILURE_COOLDOWN_MS) || 60_000;
const AUTH_FAILURE_MAX_ENTRIES = Number(process.env.EDGE_AUTH_FAILURE_MAX_ENTRIES) || 2_048;
const PGREDIS_RUNTIME_INTERNAL_URL = process.env.PGREDIS_RUNTIME_INTERNAL_URL?.trim() || "";
const PGREDIS_RUNTIME_INTERNAL_TOKEN = process.env.PGREDIS_RUNTIME_INTERNAL_TOKEN?.trim() || "";
const PGREDIS_RUNTIME_INTERNAL_TIMEOUT_MS = Number(process.env.PGREDIS_RUNTIME_INTERNAL_TIMEOUT_MS) || 5_000;
const PGREDIS_RUNTIME_CAPABILITY_TTL_MS = Number(process.env.PGREDIS_RUNTIME_CAPABILITY_TTL_MS) || 600_000;
if (Boolean(PGREDIS_RUNTIME_INTERNAL_URL) !== Boolean(PGREDIS_RUNTIME_INTERNAL_TOKEN)) {
  throw new Error("PGREDIS_RUNTIME_INTERNAL_URL and PGREDIS_RUNTIME_INTERNAL_TOKEN must be configured together");
}
const PGREDIS_RUNTIME_ENDPOINT: PgredisRuntimeEndpointConfig | undefined = PGREDIS_RUNTIME_INTERNAL_URL
  ? {
      baseUrl: PGREDIS_RUNTIME_INTERNAL_URL,
      signingSecret: PGREDIS_RUNTIME_INTERNAL_TOKEN,
      timeoutMs: PGREDIS_RUNTIME_INTERNAL_TIMEOUT_MS,
      capabilityTtlMs: PGREDIS_RUNTIME_CAPABILITY_TTL_MS,
    }
  : undefined;

// 空集群和 CI 环境可能尚未创建函数目录，启动时先落盘以避免健康检查前崩溃。
async function ensureDir(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
    return await fs.realpath(dir);
  }
}

const FUNCTIONS_BASE_REALPATH = await ensureDir(FUNCTIONS_BASE_DIR);
if (
  !isPathInside(FUNCTIONS_DIR, FUNCTIONS_BASE_DIR) &&
  !isPathInside(FUNCTIONS_DIR, FUNCTIONS_BASE_REALPATH)
) {
  throw new Error(`EDGE_FUNCTIONS_DIR must be inside EDGE_FUNCTIONS_BASE_DIR`);
}
const FUNCTIONS_DIR_REALPATH = await ensureDir(FUNCTIONS_DIR);

type AuthFailureEntry = {
  count: number;
  windowStart: number;
  blockedUntil: number;
  lastSeen: number;
};

const authFailureCache = new Map<string, AuthFailureEntry>();
const projectModuleEpoch = new Map<string, number>();

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function resolveBackgroundPreheatWorkers(): number | undefined {
  return BACKGROUND_PREHEAT_MODE === "all" ? undefined : 1;
}

if (!isPathInside(FUNCTIONS_DIR_REALPATH, FUNCTIONS_BASE_REALPATH)) {
  throw new Error(`EDGE_FUNCTIONS_DIR must be inside EDGE_FUNCTIONS_BASE_DIR`);
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeProjectRef(value: string): boolean {
  return PROJECT_REF_PATTERN.test(value);
}

function isSafeFunctionSlug(value: string): boolean {
  return FUNCTION_SLUG_PATTERN.test(value);
}

function isSafeVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

function getProjectModuleEpoch(projectRef: string): number {
  return projectModuleEpoch.get(projectRef) ?? 0;
}

function bumpProjectModuleEpoch(projectRef: string): number {
  const next = getProjectModuleEpoch(projectRef) + 1;
  projectModuleEpoch.set(projectRef, next);
  return next;
}

async function authFailureKey(
  projectRef: string,
  functionName: string,
  authHeader: string | null | undefined,
  apikeyHeader: string | null | undefined,
): Promise<string> {
  const material = `${authHeader || ""}\n${apikeyHeader || ""}` || "missing-auth";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${projectRef}/${functionName}/${fingerprint}`;
}

function clearStaleAuthFailures(now = Date.now()) {
  for (const [key, entry] of authFailureCache) {
    if (entry.blockedUntil <= now && now - entry.lastSeen > AUTH_FAILURE_COOLDOWN_MS) {
      authFailureCache.delete(key);
    }
  }

  while (authFailureCache.size > AUTH_FAILURE_MAX_ENTRIES) {
    const oldestKey = authFailureCache.keys().next().value;
    if (!oldestKey) break;
    authFailureCache.delete(oldestKey);
  }
}

function authFailureLimitResponse(blockedUntil: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  return new Response(JSON.stringify({ error: "Too many authentication failures" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
      "Cache-Control": "no-store",
      "x-relay-error": "true",
    },
  });
}

async function authFailureBlockResponse(
  projectRef: string,
  functionName: string,
  authHeader: string | null | undefined,
  apikeyHeader: string | null | undefined,
): Promise<Response | null> {
  const key = await authFailureKey(projectRef, functionName, authHeader, apikeyHeader);
  const entry = authFailureCache.get(key);
  if (!entry || entry.blockedUntil <= Date.now()) return null;
  return authFailureLimitResponse(entry.blockedUntil);
}

async function recordAuthFailure(
  projectRef: string,
  functionName: string,
  authHeader: string | null | undefined,
  apikeyHeader: string | null | undefined,
): Promise<Response | null> {
  const now = Date.now();
  const key = await authFailureKey(projectRef, functionName, authHeader, apikeyHeader);
  const current = authFailureCache.get(key);
  const entry = current && now - current.windowStart <= AUTH_FAILURE_WINDOW_MS
    ? current
    : { count: 0, windowStart: now, blockedUntil: 0, lastSeen: now };

  entry.count += 1;
  entry.lastSeen = now;
  if (entry.count >= AUTH_FAILURE_LIMIT) {
    entry.blockedUntil = now + AUTH_FAILURE_COOLDOWN_MS;
    console.warn(`[authFailureBreaker] throttling repeated 401s for ${projectRef}/${functionName}`);
  }
  authFailureCache.set(key, entry);
  clearStaleAuthFailures(now);

  return entry.blockedUntil > now ? authFailureLimitResponse(entry.blockedUntil) : null;
}

async function clearAuthFailure(
  projectRef: string,
  functionName: string,
  authHeader: string | null | undefined,
  apikeyHeader: string | null | undefined,
) {
  const key = await authFailureKey(projectRef, functionName, authHeader, apikeyHeader);
  authFailureCache.delete(key);
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json", "x-relay-error": "true" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

if (!process.env.MANAGEMENT_API_URL) {
  console.warn(
    "[EdgeRuntime] WARNING: MANAGEMENT_API_URL is not set. Defaulting to http://127.0.0.1:9090. If edge-runtime runs on a different node than management-api, this will fail!",
  );
}

const MASTER_TOKEN = INTERNAL_TOKEN;

if (!process.env.EDGE_RUNTIME_VERSION) {
  process.env.EDGE_RUNTIME_VERSION = "1.58.3";
}

let shuttingDown = false;
let workerRecycleScheduled = false;

function requestRuntimeRecycle(): void {
  if (workerRecycleScheduled || shuttingDown) return;
  workerRecycleScheduled = true;
  queueMicrotask(() => {
    void gracefulShutdown("worker replacement budget", 1);
  });
}

const pool = new WorkerPool({
  size: POOL_SIZE,
  requestTimeout: FUNCTION_REQUEST_TIMEOUT_MS,
  smol: FOREGROUND_WORKER_SMOL,
  onWorkerRecycleRequired: requestRuntimeRecycle,
});

const backgroundPool = new WorkerPool({
  size: BACKGROUND_POOL_SIZE,
  requestTimeout: BACKGROUND_FUNCTION_TIMEOUT_MS,
  smol: BACKGROUND_WORKER_SMOL,
  onWorkerRecycleRequired: requestRuntimeRecycle,
});

async function resolveProjectRoot(projectRef: string): Promise<string> {
  if (!isSafeProjectRef(projectRef)) {
    throw new Error("Invalid project reference");
  }

  const projectRoot = path.resolve(FUNCTIONS_DIR, projectRef);
  if (!isPathInside(projectRoot, FUNCTIONS_DIR)) {
    throw new Error("Invalid project root");
  }

  const realProjectRoot = await fs.realpath(projectRoot);
  if (!isPathInside(realProjectRoot, FUNCTIONS_DIR_REALPATH)) {
    throw new Error("Project root escapes functions directory");
  }

  return realProjectRoot;
}

type FunctionActivationSnapshot = {
  functionPath: string;
  projectRoot: string;
  activeVersion: string | null;
  verifyJwt: boolean;
  moduleVersion: string;
};

async function resolveFunctionPath(
  projectRef: string,
  functionName: string,
  requestedVersion?: string | null,
): Promise<FunctionActivationSnapshot> {
  if (!isSafeFunctionSlug(functionName)) {
    throw new Error("Invalid function slug");
  }
  if (requestedVersion && !isSafeVersion(requestedVersion)) {
    throw new Error("Invalid function version");
  }

  const projectRoot = await resolveProjectRoot(projectRef);
  const resolvedConfig = await getFunctionConfig(projectRef, functionName, projectRoot);
  const activeVersion = requestedVersion || resolvedConfig.version || null;
  const candidates = requestedVersion
    ? functionPathCandidates(projectRoot, functionName, requestedVersion)
    : activeFunctionPathCandidates(projectRoot, functionName, resolvedConfig.version);

  for (const candidate of candidates) {
    if (!isPathInside(candidate, projectRoot)) {
      throw new Error("Function path escapes project root");
    }

    try {
      const realCandidate = await fs.realpath(candidate);
      if (!isPathInside(realCandidate, projectRoot)) {
        throw new Error("Function path escapes project root");
      }
      const stat = await fs.stat(realCandidate);
      if (!stat.isFile()) {
        continue;
      }
      return {
        functionPath: realCandidate,
        projectRoot,
        activeVersion,
        verifyJwt: resolvedConfig.verify_jwt,
        moduleVersion: [
          `active:${activeVersion || "legacy"}`,
          `env:${getProjectModuleEpoch(projectRef)}`,
          `mtime:${stat.mtimeMs}`,
          `ctime:${stat.ctimeMs}`,
          `size:${stat.size}`,
        ].join(":"),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("escapes")) throw error;
    }
  }

  throw new Error("Function not found");
}

type FunctionDispatchOptions = {
  background?: boolean;
  backgroundInternalToken?: string;
  tenantEnv?: Record<string, string>;
  cancelKey?: string;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
};

type FunctionDispatchInput = {
  projectRef: string;
  functionName: string;
  request: Request;
  setHeaders: Record<string, string>;
  activation: FunctionActivationSnapshot;
};

function functionDispatchError(
  error: unknown,
  setHeaders: Record<string, string>,
): Response {
  const message = error instanceof Error ? error.message : "Internal Error";
  setHeaders["x-relay-error"] = "true";
  const statusCode = message.includes("not found") || message.includes("ENOENT")
    ? 404
    : message.includes("timeout") || message.includes("Timeout")
      ? 504
      : 500;
  const safeMessage = statusCode === 404
    ? "Function not found"
    : statusCode === 504
      ? "Function execution timed out"
      : "Internal Server Error";
  return new Response(JSON.stringify({ error: safeMessage }), {
    status: statusCode,
    headers: { "Content-Type": "application/json", "x-relay-error": "true" },
  });
}

async function dispatchFunction(
  input: FunctionDispatchInput,
  opts?: FunctionDispatchOptions,
) {
  const { projectRef, functionName, request, setHeaders, activation } = input;
  try {
    const { functionPath, projectRoot, activeVersion, moduleVersion } = activation;
    const versionSuffix = activeVersion ? `_v${activeVersion}` : "";
    const functionId = `${projectRef}_${functionName}${versionSuffix}`;
    const targetPool = opts?.background ? backgroundPool : pool;
    const tenantEnv = opts?.tenantEnv || await loadTenantEnv(projectRef);
    const backgroundInternalToken = opts?.backgroundInternalToken || INTERNAL_TOKEN;
    const runtimeLogContext = {
      functionVersion: activeVersion,
      executionId: setHeaders["x-sb-execution-id"] || null,
      background: opts?.background === true,
    };
    return await targetPool.dispatch({
      functionId,
      functionPath,
      projectRoot,
      projectRef,
      internalBindings: PGREDIS_RUNTIME_ENDPOINT
        ? {
            baseUrl: PGREDIS_RUNTIME_ENDPOINT.baseUrl,
            capabilityToken: createPgredisCapability(PGREDIS_RUNTIME_ENDPOINT.signingSecret, {
              projectRef,
              subject: functionId,
              ttlMs: PGREDIS_RUNTIME_ENDPOINT.capabilityTtlMs,
            }),
            timeoutMs: PGREDIS_RUNTIME_ENDPOINT.timeoutMs,
          }
        : undefined,
      moduleVersion,
      env: opts?.background
        ? withBackgroundInternalToken(tenantEnv, backgroundInternalToken)
        : tenantEnv,
      request,
      cancelKey: opts?.cancelKey,
      signal: request.signal,
      onLog: (entry) => {
        void appendFunctionRuntimeLog(projectRef, functionName, entry, runtimeLogContext);
        opts?.onLog?.(entry);
      },
    });
  } catch (error: unknown) {
    return functionDispatchError(error, setHeaders);
  }
}

async function appendFunctionRuntimeLog(
  projectRef: string,
  functionName: string,
  entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  },
  context: {
    functionVersion: string | null;
    executionId: string | null;
    background: boolean;
  },
) {
  try {
    const logDir = path.resolve(FUNCTIONS_DIR, projectRef, ".logs");
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${functionName}.log`);
    const payload = {
      id: crypto.randomUUID(),
      timestamp: entry.timestamp,
      event_type: "runtime_log",
      severity: entry.level,
      message: entry.message,
      metadata: {
        stream: entry.stream,
        project_ref: projectRef,
        function_slug: functionName,
        function_version: context.functionVersion,
        execution_id: context.executionId,
        background: context.background,
      },
    };
    await fs.appendFile(logFile, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    console.warn(
      `[EdgeRuntime] Failed to persist runtime log for ${projectRef}/${functionName}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function verifyInternalAuth(request: Request): boolean {
  const internalHeader = request.headers.get("x-supacloud-internal-auth") || request.headers.get("x-supacloud-internal-token");
  const token = (internalHeader || request.headers.get("authorization"))?.replace(/^Bearer\s+/i, "").trim();
  return !!INTERNAL_TOKEN && token === INTERNAL_TOKEN;
}

function requireInternalAuth(request: Request): Response | undefined {
  return verifyInternalAuth(request) ? undefined : unauthorized();
}

const configCache = new Map<
  string,
  { verify_jwt: boolean; version: string | null; expiresAt: number }
>();
const CONFIG_CACHE_TTL = 10_000;

async function getFunctionConfig(
  projectRef: string,
  functionName: string,
  projectRoot?: string,
): Promise<{ verify_jwt: boolean; version: string | null }> {
  const key = `${projectRef}/${functionName}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { verify_jwt: cached.verify_jwt, version: cached.version };
  }

  try {
    const root = projectRoot || await resolveProjectRoot(projectRef);
    const configPath = path.resolve(root, `${functionName}.config.json`);
    if (!isPathInside(configPath, root)) {
      throw new Error("Function config path escapes project root");
    }
    const realConfigPath = await fs.realpath(configPath);
    if (!isPathInside(realConfigPath, root)) {
      throw new Error("Function config path escapes project root");
    }
    const raw = await Bun.file(realConfigPath).text();
    const config = JSON.parse(raw);
    const verify_jwt = config.verify_jwt !== false;
    const version =
      typeof config.version === "string" && config.version.trim().length > 0
        ? config.version.trim()
        : null;
    configCache.set(key, {
      verify_jwt,
      version,
      expiresAt: Date.now() + CONFIG_CACHE_TTL,
    });
    return { verify_jwt, version };
  } catch {
    configCache.set(key, {
      verify_jwt: true,
      version: null,
      expiresAt: Date.now() + CONFIG_CACHE_TTL,
    });
    return { verify_jwt: true, version: null };
  }
}

interface ProjectSecrets {
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
  jwtJwks: ReturnType<typeof normalizeJwtJwks>;
  thirdParty: ReturnType<typeof normalizeThirdPartyJwtPolicy>;
  authRuntimeMode: EdgeRuntimeAuthRuntimeMode;
  authIssuer: string;
}

async function getProjectSecrets(
  projectRef: string,
): Promise<ProjectSecrets | null> {
  try {
    const runtimeEnv = await loadTenantEnv(projectRef);
    const runtimeSecrets = readEdgeRuntimeProjectSecrets(runtimeEnv);
    if (runtimeSecrets) {
      return {
        anonKey: runtimeSecrets.anonKey || "",
        serviceRoleKey: runtimeSecrets.serviceRoleKey || "",
        jwtSecret: runtimeSecrets.jwtSecret || "",
        jwtJwks: runtimeSecrets.jwtJwks || null,
        thirdParty: runtimeSecrets.thirdParty || null,
        authRuntimeMode: runtimeSecrets.authRuntimeMode || "unknown",
        authIssuer: runtimeSecrets.authIssuer || "",
      };
    }

    const [keysRes, detailRes, authRuntimeRes] = await Promise.all([
      fetch(`${MGMT_API}/v1/projects/${projectRef}/api-keys`, {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${MGMT_API}/v1/projects/${projectRef}`, {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${MGMT_API}/v1/projects/${projectRef}/auth/runtime`, {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (!keysRes.ok || !detailRes.ok || !authRuntimeRes.ok) {
      console.warn(
        `[verifyJwt] Failed to fetch secrets for ${projectRef}: keys=${keysRes.status} detail=${detailRes.status} authRuntime=${authRuntimeRes.status}`,
      );
      return null;
    }

    const keysArray = (await keysRes.json()) as {
      name: string;
      api_key: string;
    }[];
    const detail = (await detailRes.json()) as {
      jwt_secret?: string;
      config?: { auth?: {
        oauth_server?: { jwt_jwks?: unknown };
        third_party_auth?: unknown;
      } };
    };
    const authRuntime = (await authRuntimeRes.json()) as {
      mode?: "local" | "owner" | "shared";
    };
    if (authRuntime.mode === "shared") {
      console.warn(`[verifyJwt] Refusing local fallback secrets for SupAuth dependent ${projectRef}`);
      return null;
    }

    return {
      anonKey: keysArray?.find?.((k) => k.name === "anon")?.api_key || "",
      serviceRoleKey:
        keysArray?.find?.((k) => k.name === "service_role")?.api_key || "",
      jwtSecret: detail.jwt_secret || "",
      jwtJwks: normalizeJwtJwks(detail.config?.auth?.oauth_server?.jwt_jwks),
      thirdParty: normalizeThirdPartyJwtPolicy(detail.config?.auth?.third_party_auth),
      authRuntimeMode: normalizeEdgeRuntimeAuthRuntimeMode(authRuntime.mode),
      authIssuer: "",
    };
  } catch (err) {
    console.warn(
      `[verifyJwt] Error fetching secrets for ${projectRef}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function verifyJwt(
  projectRef: string,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<EdgeRuntimeJwtVerificationResult> {
  const secrets = await getProjectSecrets(projectRef);
  if (!secrets) return { verified: false, source: "none" };

  const result = await verifyEdgeRuntimeJwtContext(
    secrets,
    authHeader,
    apikeyHeader,
  );
  if (!result.verified) {
    console.warn(`[verifyJwt] JWT verification failed for ${projectRef}`);
  }
  return result;
}

async function handleFunctionRequest(
  c: { params: Record<string, string>; headers: Record<string, string | undefined>; request: Request; set: { headers: Record<string, string | number> } },
  functionName: string,
) {
  const projectRef = c.headers["x-project-ref"];
  const authHeader = c.headers["authorization"] || null;
  const apikeyHeader = c.headers["apikey"] || null;
  if (!projectRef) {
    c.set.headers["x-relay-error"] = "true";
    return badRequest("Missing x-project-ref");
  }
  if (!isSafeProjectRef(projectRef) || !isSafeFunctionSlug(functionName)) {
    c.set.headers["x-relay-error"] = "true";
    return badRequest("Invalid project reference or function slug");
  }
  const blockedResponse = await authFailureBlockResponse(projectRef, functionName, authHeader, apikeyHeader);
  if (blockedResponse) {
    return blockedResponse;
  }

  const setHeaders = c.set.headers as Record<string, string>;
  let activation: FunctionActivationSnapshot;
  try {
    activation = await resolveFunctionPath(projectRef, functionName);
  } catch (error) {
    return functionDispatchError(error, setHeaders);
  }
  let verifiedSubject: string | undefined;
  if (c.request.method !== "OPTIONS" && activation.verifyJwt) {
    const verification = await verifyJwt(
      projectRef,
      authHeader,
      apikeyHeader,
    );
    if (!verification.verified) {
      const rateLimitResponse = await recordAuthFailure(projectRef, functionName, authHeader, apikeyHeader);
      if (rateLimitResponse) return rateLimitResponse;
      return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }
    verifiedSubject = verification.source === "jwt"
      ? verification.payload.sub
      : undefined;
  }

  const functionRequest = withVerifiedJwtContext(c.request, verifiedSubject);
  c.set.headers["x-sb-execution-id"] = crypto.randomUUID();
  const response = await dispatchFunction(
    {
      projectRef,
      functionName,
      request: functionRequest,
      setHeaders,
      activation,
    },
  );

  if (response.status === 401) {
    const rateLimitResponse = await recordAuthFailure(projectRef, functionName, authHeader, apikeyHeader);
    if (rateLimitResponse) return rateLimitResponse;
  } else {
    await clearAuthFailure(projectRef, functionName, authHeader, apikeyHeader);
  }

  return response;
}

const app = new Elysia()
  .use(cors())
  .get("/health", () => ({
    status: "ok",
    instanceId: process.env.EDGE_RUNTIME_INSTANCE_ID || null,
  }))
  .get("/metrics", (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;

    const foreground = pool.snapshotMetrics("supacloud_edge");
    const background = backgroundPool.snapshotMetrics("supacloud_edge_background");
    return Object.entries({ ...foreground, ...background })
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
  })

  .post("/invalidate/:ref/:slug", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    if (!isSafeProjectRef(c.params.ref) || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid project reference or function slug");
    }

    const functionId = `${c.params.ref}_${c.params.slug}`;
    configCache.delete(`${c.params.ref}/${c.params.slug}`);
    invalidateTenantEnvCache(c.params.ref);
    const [foreground, background] = await Promise.all([
      pool.invalidateModule(functionId),
      backgroundPool.invalidateModule(functionId),
    ]);
    return {
      invalidated: functionId,
      module_scope: "legacy-base-only",
      immutable_versions_retained: true,
      config_cache_evicted: true,
      foreground,
      background,
    };
  })

  .post("/invalidate-env/:ref", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    if (!isSafeProjectRef(c.params.ref)) {
      return badRequest("Invalid project reference");
    }

    invalidateTenantEnvCache(c.params.ref);
    const moduleEpoch = bumpProjectModuleEpoch(c.params.ref);
    const [foreground, background] = await Promise.all([
      pool.invalidateProject(c.params.ref),
      backgroundPool.invalidateProject(c.params.ref),
    ]);
    return { invalidated: c.params.ref, moduleEpoch, foreground, background };
  })

  .post("/preheat/:ref/:slug", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;

    try {
      const requestedVersion = c.request.headers.get("x-supacloud-function-version") || null;
      const { functionPath, projectRoot, moduleVersion } = await resolveFunctionPath(
        c.params.ref,
        c.params.slug,
        requestedVersion,
      );
      const versionSuffix = requestedVersion ? `_v${requestedVersion}` : "";
      const functionId = `${c.params.ref}_${c.params.slug}${versionSuffix}`;
      const tenantEnv = await loadTenantEnv(c.params.ref);
      const [foreground, background] = requestedVersion
        ? await Promise.all([
            pool.preheatVersionedIdleWorkers({
              functionId,
              functionPath,
              projectRoot,
              env: tenantEnv,
              projectRef: c.params.ref,
              moduleVersion,
            }),
            backgroundPool.preheatVersionedIdleWorkers({
              functionId,
              functionPath,
              projectRoot,
              env: tenantEnv,
              projectRef: c.params.ref,
              moduleVersion,
              maxWorkers: resolveBackgroundPreheatWorkers(),
            }),
          ])
        : await Promise.all([
            pool.preheatIdleWorkers(functionId, functionPath, projectRoot, tenantEnv, {
              projectRef: c.params.ref,
              moduleVersion,
            }),
            backgroundPool.preheatIdleWorkers(functionId, functionPath, projectRoot, tenantEnv, {
              projectRef: c.params.ref,
              moduleVersion,
              maxWorkers: resolveBackgroundPreheatWorkers(),
            }),
          ]);
      return {
        preheated: functionId,
        version: requestedVersion,
        success: foreground.succeeded > 0 || background.succeeded > 0,
        foreground,
        background,
      };
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "Invalid function path");
    }
  })

  .post("/internal/background/:ref/:functionName/*", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const backgroundDispatch = buildBackgroundForwardDispatch(
      c.request,
      await loadTenantEnv(c.params.ref),
    );
    const requestedVersion = backgroundDispatch.forwardedRequest.headers.get("x-supacloud-function-version");
    let response: Response;
    try {
      const activation = await resolveFunctionPath(c.params.ref, c.params.functionName, requestedVersion);
      response = await dispatchFunction(
        {
          projectRef: c.params.ref,
          functionName: c.params.functionName,
          request: backgroundDispatch.forwardedRequest,
          setHeaders,
          activation,
        },
        {
          background: true,
          backgroundInternalToken: backgroundDispatch.backgroundInternalToken,
          tenantEnv: backgroundDispatch.tenantEnv,
          cancelKey: c.request.headers.get("x-supacloud-task-id") || undefined,
          onLog: (entry) => {
            logs.push(entry);
            if (logs.length > 200) logs.shift();
          },
        },
      );
    } catch (error) {
      response = functionDispatchError(error, setHeaders);
    }
    const bodyText = await response.text();
    return new Response(
      JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText,
        logs,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-supacloud-background-envelope": "true",
        },
      },
    );
  })
  .post("/internal/background/:ref/:functionName", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const backgroundDispatch = buildBackgroundForwardDispatch(
      c.request,
      await loadTenantEnv(c.params.ref),
    );
    const requestedVersion = backgroundDispatch.forwardedRequest.headers.get("x-supacloud-function-version");
    let response: Response;
    try {
      const activation = await resolveFunctionPath(c.params.ref, c.params.functionName, requestedVersion);
      response = await dispatchFunction(
        {
          projectRef: c.params.ref,
          functionName: c.params.functionName,
          request: backgroundDispatch.forwardedRequest,
          setHeaders,
          activation,
        },
        {
          background: true,
          backgroundInternalToken: backgroundDispatch.backgroundInternalToken,
          tenantEnv: backgroundDispatch.tenantEnv,
          cancelKey: c.request.headers.get("x-supacloud-task-id") || undefined,
          onLog: (entry) => {
            logs.push(entry);
            if (logs.length > 200) logs.shift();
          },
        },
      );
    } catch (error) {
      response = functionDispatchError(error, setHeaders);
    }
    const bodyText = await response.text();
    return new Response(
      JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText,
        logs,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-supacloud-background-envelope": "true",
        },
      },
    );
  })
  .post("/internal/background/cancel/:taskId", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;

    const cancelled = backgroundPool.cancel(c.params.taskId);
    return new Response(JSON.stringify({ cancelled }), {
      status: cancelled ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  })

  .all("/functions/v1/:functionName/*", async (c) =>
    handleFunctionRequest(
      { params: c.params, headers: c.headers as Record<string, string | undefined>, request: c.request, set: c.set },
      c.params.functionName,
    )
  )
  .all("/functions/v1/:functionName", async (c) =>
    handleFunctionRequest(
      { params: c.params, headers: c.headers as Record<string, string | undefined>, request: c.request, set: c.set },
      c.params.functionName,
    )
  )
  .all("/:functionName/*", async (c) =>
    handleFunctionRequest(
      { params: c.params, headers: c.headers as Record<string, string | undefined>, request: c.request, set: c.set },
      c.params.functionName,
    )
  )
  .all("/:functionName", async (c) =>
    handleFunctionRequest(
      { params: c.params, headers: c.headers as Record<string, string | undefined>, request: c.request, set: c.set },
      c.params.functionName,
    )
  )

  .listen({ port: PORT, hostname: HOST });

console.log(`🚀 Edge Runtime on ${HOST}:${PORT} (${POOL_SIZE} workers)`);

const gracefulShutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[EdgeRuntime] Received ${signal}, shutting down gracefully...`);

  try {
    app.stop();
  } catch {
  }

  try {
    const drainTimeout = setTimeout(() => {
      console.error("[EdgeRuntime] Force exit after drain timeout");
      process.exit(1);
    }, 30_000);

    await Promise.race([
      Promise.all([pool.drain(), backgroundPool.drain()]),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("drain timeout")), 30_000)
      ),
    ]);

    clearTimeout(drainTimeout);
  } catch {
    console.error("[EdgeRuntime] Drain timed out, forcing exit");
  }

  // Bulk preheats are drained above; leave time for their control responses to flush.
  if (exitCode !== 0) await Bun.sleep(WORKER_RECYCLE_RESPONSE_GRACE_MS);

  process.exit(exitCode);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[EdgeRuntime] FATAL uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[EdgeRuntime] unhandledRejection:", reason);
});

// Keep the main runtime process alive so systemd can supervise the actual server
// process instead of observing Bun's temporary bootstrap completion.
await new Promise<void>(() => {});
