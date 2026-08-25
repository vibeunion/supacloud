import "./url-import-plugin";
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import {
  WorkerPool,
  resolveWorkerReplacementBudget,
  type WorkerPoolPreheatResult,
  type WorkerPoolVersionPreheatResult,
} from "./worker-pool";
import {
  invalidateTenantEnvCache,
  isTenantEnvLoadCurrent,
  loadTenantEnv,
  loadTenantRuntimeEnv,
  recordTenantEnvDispatch,
  reserveTenantEnvDispatch,
  runtimeEnvObservation,
  tenantEnvModuleProof,
  type TenantEnvLoad,
  type TenantEnvExecutionProfile,
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
import {
  activeFunctionPathCandidates,
  attestedFunctionArtifactPath,
} from "./function-source";
import { readFunctionFile, type TrustedFunctionFile } from "./trusted-function-files";
import {
  assertCanonicalConfiguredFunctionVersion,
  resolveFunctionVersionBinding,
  resolveTrustedBackgroundFunctionVersionBinding,
} from "./function-version";
import path from "path";
import fs from "fs/promises";
import type { PgredisRuntimeEndpointConfig } from "./internal-bindings";
import { createPgredisCapability } from "./pgredis-capability";
import {
  EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
  type EdgeRuntimePreheatIdentity,
} from "./preheat-attestation";
import {
  activationAuthorityId,
  activationFenceKey,
  activationState,
  assertActivationSuccessor,
  isEdgeFunctionActivationId,
  parseEdgeFunctionActivationManifest,
  readEdgeFunctionActivationGeneration,
  type EdgeFunctionActivationFence,
  type EdgeFunctionActivationManifest,
  type EdgeFunctionActivationState,
} from "./function-activation";

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
const WORKER_REPLACEMENT_BUDGET = resolveWorkerReplacementBudget(
  process.env.EDGE_MAX_WORKER_REPLACEMENTS_BEFORE_RECYCLE,
);
const WORKER_REPLACEMENT_BUDGET_OPTIONS = WORKER_REPLACEMENT_BUDGET === undefined
  ? {}
  : { maxWorkerReplacementsBeforeRecycle: WORKER_REPLACEMENT_BUDGET };
const INTERNAL_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";
const RUNTIME_INSTANCE_ID = process.env.EDGE_RUNTIME_INSTANCE_ID?.trim() || crypto.randomUUID();
const PROJECT_REF_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FUNCTION_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
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

function hasCompletePreheatAttestation(result: WorkerPoolPreheatResult): boolean {
  return result.attempted > 0
    && result.succeeded === result.attempted
    && result.attestation !== null;
}

function activationPreheatProof(
  foreground: WorkerPoolPreheatResult | WorkerPoolVersionPreheatResult,
  background: WorkerPoolPreheatResult | WorkerPoolVersionPreheatResult,
): NonNullable<EdgeFunctionActivationFence["preheated"]> | null {
  if (!("rotation" in foreground) || !("rotation" in background)) return null;
  return {
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    foregroundGeneration: foreground.rotation.generation,
    backgroundGeneration: background.rotation.generation,
  };
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
  ...WORKER_REPLACEMENT_BUDGET_OPTIONS,
  onWorkerRecycleRequired: requestRuntimeRecycle,
});

const backgroundPool = new WorkerPool({
  size: BACKGROUND_POOL_SIZE,
  requestTimeout: BACKGROUND_FUNCTION_TIMEOUT_MS,
  smol: BACKGROUND_WORKER_SMOL,
  ...WORKER_REPLACEMENT_BUDGET_OPTIONS,
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
  responseVersion: string | null;
  verifyJwt: boolean;
  moduleVersion: string;
  artifactSha256: string;
  activationId: string | null;
  authorityKind: "active" | "historical" | "legacy";
  attested: boolean;
};

type RuntimePreheatIdentityRequest = {
  projectRef: string;
  functionSlug: string;
  requestedVersion: string | null;
  activation: FunctionActivationSnapshot;
  tenantEnvLoad: TenantEnvLoad;
  executionProfile: TenantEnvExecutionProfile;
  moduleEnvProof: string | null;
};

function runtimePreheatIdentity(
  request: RuntimePreheatIdentityRequest,
): EdgeRuntimePreheatIdentity | null {
  if (!request.activation.attested) return null;
  return {
    schema: EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
    project_ref: request.projectRef,
    function_slug: request.functionSlug,
    requested_version: request.requestedVersion,
    target_version: request.requestedVersion ?? request.activation.activeVersion,
    resolved_version: request.activation.activeVersion,
    artifact_sha256: request.activation.artifactSha256,
    verify_jwt: request.activation.verifyJwt,
    activation_id: request.activation.activationId,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    execution_profile: request.executionProfile,
    module_env_proof: request.moduleEnvProof,
    tenant_env: {
      loaded_revision: request.tenantEnvLoad.revision,
      env_proof: request.tenantEnvLoad.envProof,
      load_state: request.tenantEnvLoad.loadState,
      load_source: request.tenantEnvLoad.loadSource,
    },
  };
}

type ResolveFunctionPathRequest = {
  projectRef: string;
  functionName: string;
  requestedVersion?: string | null;
  versionBindingResolver?: typeof resolveFunctionVersionBinding;
  configOverride?: FunctionConfig;
};

async function resolvedFunctionPath(
  request: ResolveFunctionPathRequest,
): Promise<FunctionActivationSnapshot> {
  if (!isSafeFunctionSlug(request.functionName)) {
    throw new Error("Invalid function slug");
  }
  const projectRoot = await resolveProjectRoot(request.projectRef);
  const resolvedConfig = request.configOverride
    ?? await getFunctionConfig(request.projectRef, request.functionName, projectRoot);
  if (resolvedConfig.targetState === "absent") throw new Error("Function not found");
  if (request.configOverride === undefined && resolvedConfig.authorityKind === "active") {
    const currentManifest = await activeActivationManifest(projectRoot, request.functionName);
    const currentAuthority = currentManifest.authority;
    if (!currentAuthority
      || currentAuthority.activation_id !== resolvedConfig.activationId
      || currentAuthority.target_state !== resolvedConfig.targetState
      || currentAuthority.artifact_sha256 !== resolvedConfig.artifactSha256
      || currentManifest.config.version !== resolvedConfig.version
      || currentManifest.config.verify_jwt !== resolvedConfig.verify_jwt) {
      configCache.delete(`${request.projectRef}/${request.functionName}`);
      throw new Error("Runtime environment changed before artifact resolution");
    }
  }
  const versionBindingResolver = request.versionBindingResolver ?? resolveFunctionVersionBinding;
  const { activeVersion, responseVersion } = versionBindingResolver(
    request.requestedVersion,
    resolvedConfig.version,
  );
  const authoritative = resolvedConfig.authorityKind !== "legacy";
  if (authoritative && activeVersion === null) {
    throw new Error("Authoritative Function activation must identify a version");
  }
  if (authoritative && resolvedConfig.artifactSha256 === null) {
    throw new Error("Authoritative Function activation must identify an artifact digest");
  }
  const candidates = authoritative
    ? [attestedFunctionArtifactPath(
        projectRoot,
        request.functionName,
        activeVersion!,
        resolvedConfig.artifactSha256!,
      )]
    : activeFunctionPathCandidates(projectRoot, request.functionName, activeVersion);

  for (const candidate of candidates) {
    if (!isPathInside(candidate, projectRoot)) {
      throw new Error("Function path escapes project root");
    }

    let artifact: TrustedFunctionFile;
    try {
      artifact = await readFunctionFile(candidate);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (!authoritative && (code === "ENOENT" || code === "ENOTDIR")) continue;
      throw error;
    }
    if (authoritative && artifact.sha256 !== resolvedConfig.artifactSha256) {
      throw new Error("Function artifact SHA-256 does not match activation authority");
    }
    return {
      functionPath: candidate,
      projectRoot,
      activeVersion,
      responseVersion,
      verifyJwt: resolvedConfig.verify_jwt,
      artifactSha256: artifact.sha256,
      activationId: resolvedConfig.activationId,
      authorityKind: resolvedConfig.authorityKind,
      attested: authoritative,
      moduleVersion: [
        `active:${activeVersion || "legacy"}`,
        `activation:${resolvedConfig.activationId ?? "legacy"}`,
        `env:${getProjectModuleEpoch(request.projectRef)}`,
        `mtime:${artifact.metadata.mtimeMs}`,
        `ctime:${artifact.metadata.ctimeMs}`,
        `size:${artifact.metadata.size}`,
        `sha256:${artifact.sha256}`,
      ].join(":"),
    };
  }

  throw new Error("Function not found");
}

async function resolveFunctionPath(
  projectRef: string,
  functionName: string,
  requestedVersion?: string | null,
  versionBindingResolver = resolveFunctionVersionBinding,
): Promise<FunctionActivationSnapshot> {
  return resolvedFunctionPath({
    projectRef,
    functionName,
    requestedVersion,
    versionBindingResolver,
  });
}

type FunctionDispatchOptions = {
  background?: boolean;
  tenantEnv?: Record<string, string>;
  tenantEnvLoad?: TenantEnvLoad;
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
      : message.includes("Runtime environment changed")
        ? 503
      : 500;
  const safeMessage = statusCode === 404
      ? "Function not found"
      : statusCode === 504
        ? "Function execution timed out"
        : statusCode === 503
          ? "Runtime environment changed before execution"
        : "Internal Server Error";
  return new Response(JSON.stringify({ error: safeMessage }), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "x-relay-error": "true",
      ...(statusCode === 503 ? { "Retry-After": "1" } : {}),
    },
  });
}

async function dispatchFunction(
  input: FunctionDispatchInput,
  opts?: FunctionDispatchOptions,
) {
  const { projectRef, functionName, request, setHeaders, activation } = input;
  try {
    const { functionPath, projectRoot, activeVersion, responseVersion, moduleVersion } = activation;
    const versionSuffix = activeVersion ? `_v${activeVersion}` : "";
    const functionId = `${projectRef}_${functionName}${versionSuffix}`;
    const targetPool = opts?.background ? backgroundPool : pool;
    const tenantEnvLoad = opts?.tenantEnvLoad || await loadTenantRuntimeEnv(projectRef);
    const dispatchEnv = opts?.tenantEnv || tenantEnvLoad.env;
    const executionProfile = opts?.background ? "background" : "foreground";
    const moduleEnvProof = tenantEnvModuleProof(
      projectRef,
      tenantEnvLoad.env,
      tenantEnvLoad,
      executionProfile,
    );
    if (!isTenantEnvLoadCurrent(projectRef, tenantEnvLoad)) {
      throw new Error("Runtime environment changed before dispatch");
    }
    if (activationFences.has(activationFenceKey(projectRef, functionName))) {
      throw new Error("Runtime environment changed during Function activation");
    }
    await assertDispatchAuthorityCurrent(projectRef, functionName, activation);
    const dispatchReservation = reserveTenantEnvDispatch(projectRef);
    const runtimeLogContext = {
      functionVersion: activeVersion,
      executionId: setHeaders["x-sb-execution-id"] || null,
      background: opts?.background === true,
    };
    const response = await targetPool.dispatch({
      functionId,
      functionPath,
      projectRoot,
      projectRef,
      functionVersion: responseVersion,
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
      artifactSha256: activation.attested ? activation.artifactSha256 : undefined,
      env: dispatchEnv,
      envProof: moduleEnvProof || undefined,
      request,
      cancelKey: opts?.cancelKey,
      signal: request.signal,
      onExecutionStarted: () =>
        recordTenantEnvDispatch(projectRef, tenantEnvLoad, dispatchReservation),
      onLog: (entry) => {
        void appendFunctionRuntimeLog(projectRef, functionName, entry, runtimeLogContext);
        opts?.onLog?.(entry);
      },
    });
    return response;
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
  FunctionConfig & { expiresAt: number }
>();
const CONFIG_CACHE_TTL = 10_000;

type FunctionConfig = {
  verify_jwt: boolean;
  version: string | null;
  activationId: string | null;
  targetState: "active" | "absent" | null;
  artifactSha256: string | null;
  authorityKind: "active" | "historical" | "legacy";
};

type ActivationPoolControl = Awaited<ReturnType<WorkerPool["invalidateProject"]>>;
type ActivationPoolInvalidation = {
  foreground: ActivationPoolControl;
  background: ActivationPoolControl;
};
type RuntimeActivationFence = EdgeFunctionActivationFence & {
  invalidation: Promise<ActivationPoolInvalidation>;
};

const activationFences = new Map<string, RuntimeActivationFence>();

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readFunctionActivationManifest(
  configPath: string,
  projectRoot: string,
): Promise<EdgeFunctionActivationManifest | null> {
  if (!isPathInside(configPath, projectRoot)) {
    throw new Error("Function config path escapes project root");
  }
  try {
    const configFile = await readFunctionFile(configPath);
    return parseEdgeFunctionActivationManifest(configFile.bytes.toString("utf8"));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function getFunctionConfig(
  projectRef: string,
  functionName: string,
  projectRoot: string,
): Promise<FunctionConfig> {
  const key = `${projectRef}/${functionName}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      verify_jwt: cached.verify_jwt,
      version: cached.version,
      activationId: cached.activationId,
      targetState: cached.targetState,
      artifactSha256: cached.artifactSha256,
      authorityKind: cached.authorityKind,
    };
  }

  const configPath = path.resolve(projectRoot, `${functionName}.config.json`);
  if (!isPathInside(configPath, projectRoot)) {
    throw new Error("Function config path escapes project root");
  }
  const manifest = await readFunctionActivationManifest(configPath, projectRoot);
  const config = manifest === null
    ? {
        verify_jwt: true,
        version: null,
        activationId: null,
        targetState: null,
        artifactSha256: null,
        authorityKind: "legacy" as const,
      }
    : {
        verify_jwt: manifest.config.verify_jwt,
        version: manifest.config.version,
        activationId: activationAuthorityId(manifest),
        targetState: manifest.authority?.target_state ?? null,
        artifactSha256: manifest.authority?.artifact_sha256 ?? null,
        authorityKind: manifest.authority === null ? "legacy" as const : "active" as const,
      };
  configCache.set(key, { ...config, expiresAt: Date.now() + CONFIG_CACHE_TTL });
  return config;
}

async function immutableVersionConfig(
  projectRoot: string,
  functionName: string,
  version: string,
): Promise<FunctionConfig> {
  assertCanonicalConfiguredFunctionVersion(version);
  const versionRoot = path.resolve(projectRoot, ".versions", functionName, version);
  const metadataPath = path.join(versionRoot, ".supacloud-version.json");
  const resolvedMetadataPath = await fs.realpath(metadataPath);
  if (!isPathInside(resolvedMetadataPath, versionRoot)) {
    throw new Error("Function version metadata escapes its immutable version directory");
  }
  const metadataFile = await readFunctionFile(resolvedMetadataPath);
  const metadata: unknown = JSON.parse(metadataFile.bytes.toString("utf8"));
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Function version metadata must be an object");
  }
  const record = metadata as Record<string, unknown>;
  if (record.version !== version
    || typeof record.verify_jwt !== "boolean"
    || typeof record.artifact_sha256 !== "string") {
    throw new Error("Function version metadata does not match its immutable version");
  }
  return {
    verify_jwt: record.verify_jwt,
    version,
    activationId: null,
    targetState: "active",
    artifactSha256: record.artifact_sha256,
    authorityKind: "historical",
  };
}

async function assertDispatchAuthorityCurrent(
  projectRef: string,
  functionName: string,
  activation: FunctionActivationSnapshot,
): Promise<void> {
  if (!activation.attested) return;
  const current = activation.authorityKind === "active"
    ? await activeFunctionConfig(activation.projectRoot, functionName)
    : await immutableVersionConfig(
        activation.projectRoot,
        functionName,
        activation.activeVersion!,
      );
  if (current.authorityKind !== activation.authorityKind
    || current.activationId !== activation.activationId
    || current.version !== activation.activeVersion
    || current.verify_jwt !== activation.verifyJwt
    || current.targetState !== "active"
    || current.artifactSha256 !== activation.artifactSha256) {
    configCache.delete(`${projectRef}/${functionName}`);
    throw new Error("Runtime environment changed before dispatch");
  }
  const artifact = await readFunctionFile(activation.functionPath);
  if (artifact.sha256 !== activation.artifactSha256) {
    throw new Error("Function artifact SHA-256 does not match dispatch authority");
  }
}

async function activeFunctionConfig(
  projectRoot: string,
  functionName: string,
): Promise<FunctionConfig> {
  const manifest = await activeActivationManifest(projectRoot, functionName);
  return {
    verify_jwt: manifest.config.verify_jwt,
    version: manifest.config.version,
    activationId: activationAuthorityId(manifest),
    targetState: manifest.authority?.target_state ?? null,
    artifactSha256: manifest.authority?.artifact_sha256 ?? null,
    authorityKind: manifest.authority === null ? "legacy" : "active",
  };
}

async function activeActivationManifest(
  projectRoot: string,
  functionName: string,
): Promise<EdgeFunctionActivationManifest> {
  const configPath = path.resolve(projectRoot, `${functionName}.config.json`);
  return await readFunctionActivationManifest(configPath, projectRoot)
    ?? parseEdgeFunctionActivationManifest("{}");
}

async function preheatActivationSnapshot(
  projectRef: string,
  functionName: string,
  requestedVersion: string | null,
  activationId: string | null,
): Promise<FunctionActivationSnapshot> {
  const projectRoot = await resolveProjectRoot(projectRef);
  if (activationId) {
    const candidate = await readEdgeFunctionActivationGeneration(
      projectRoot,
      functionName,
      activationId,
    );
    if (candidate.authority.target_state !== "active"
      || candidate.config.version !== requestedVersion) {
      throw new Error("Function activation candidate does not match the requested version");
    }
    const activation = await resolvedFunctionPath({
      projectRef,
      functionName,
      requestedVersion,
      configOverride: {
        ...candidate.config,
        activationId: candidate.authority.activation_id,
        targetState: candidate.authority.target_state,
        artifactSha256: candidate.authority.artifact_sha256,
        authorityKind: "active",
      },
    });
    if (activation.artifactSha256 !== candidate.authority.artifact_sha256) {
      throw new Error("Function activation artifact does not match its immutable generation");
    }
    return activation;
  }
  const configOverride = requestedVersion === null
    ? undefined
    : await immutableVersionConfig(projectRoot, functionName, requestedVersion);
  return resolvedFunctionPath({
    projectRef,
    functionName,
    requestedVersion,
    configOverride,
  });
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

const EDGE_RUNTIME_FUNCTION_ACTIVATION_SCHEMA =
  "supacloud.edge-runtime-function-activation.v1" as const;

function activationFenceResponse(projectRef: string, functionSlug: string): Response | null {
  if (!activationFences.has(activationFenceKey(projectRef, functionSlug))) return null;
  return new Response(JSON.stringify({
    error: "Function activation is in progress",
    code: "FUNCTION_ACTIVATION_FENCED",
  }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "1",
    },
  });
}

function activationControlBody(
  activationId: string,
  state: EdgeFunctionActivationState,
  foreground?: ActivationPoolControl,
  background?: ActivationPoolControl,
) {
  return {
    schema: EDGE_RUNTIME_FUNCTION_ACTIVATION_SCHEMA,
    activation_id: activationId,
    state,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    foreground_generation: foreground?.generation ?? pool.generation,
    background_generation: background?.generation ?? backgroundPool.generation,
    cancelled_queued: (foreground?.cancelledQueued ?? 0)
      + (background?.cancelledQueued ?? 0),
  };
}

function activationIdHeader(request: Request): string | null {
  const activationId = request.headers.get("x-supacloud-activation-id");
  return isEdgeFunctionActivationId(activationId) ? activationId : null;
}

function activationControlResponse(
  body: ReturnType<typeof activationControlBody>,
  status = 200,
): Response {
  return Response.json(body, { status });
}

function activeActivationLease(): { key: string; fence: RuntimeActivationFence } | null {
  const entry = activationFences.entries().next().value;
  return entry ? { key: entry[0], fence: entry[1] } : null;
}

function activationLeaseUnavailable(): Response | null {
  if (activationFences.size === 0) return null;
  return Response.json({
    error: "A Function activation lease is active",
    code: "FUNCTION_ACTIVATION_LEASE_ACTIVE",
  }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "1" },
  });
}

async function invalidateActivationPools(projectRef: string): Promise<ActivationPoolInvalidation> {
  const [foreground, background] = await Promise.all([
    pool.invalidateProject(projectRef),
    backgroundPool.invalidateProject(projectRef),
  ]);
  if (foreground.succeeded !== foreground.attempted
    || background.succeeded !== background.attempted) {
    throw new Error("Function activation fence invalidation was incomplete");
  }
  return { foreground, background };
}

async function currentActivationManifest(
  projectRef: string,
  functionSlug: string,
): Promise<EdgeFunctionActivationManifest> {
  return activeActivationManifest(await resolveProjectRoot(projectRef), functionSlug);
}

async function beginFunctionActivation(
  projectRef: string,
  functionSlug: string,
  activationId: string,
) {
  const projectRoot = await resolveProjectRoot(projectRef);
  const candidate = await readEdgeFunctionActivationGeneration(
    projectRoot,
    functionSlug,
    activationId,
  );
  const current = await activeActivationManifest(projectRoot, functionSlug);
  assertActivationSuccessor(candidate, current);
  const key = activationFenceKey(projectRef, functionSlug);
  const existing = activeActivationLease();
  if (existing) {
    if (existing.key !== key
      || existing.fence.candidate.authority.activation_id !== activationId) {
      throw new Error("A foreign Function activation fence is already active");
    }
    const settled = await existing.fence.invalidation;
    return activationControlBody(
      activationId,
      "fenced",
      settled.foreground,
      settled.background,
    );
  }
  const invalidation = invalidateActivationPools(projectRef);
  const fence = {
    candidate,
    preheated: null,
    invalidation,
  } satisfies RuntimeActivationFence;
  activationFences.set(key, fence);
  try {
    const settled = await invalidation;
    return activationControlBody(
      activationId,
      "fenced",
      settled.foreground,
      settled.background,
    );
  } catch (error: unknown) {
    if (activationFences.get(key) === fence) activationFences.delete(key);
    throw error;
  }
}

async function functionActivationState(
  projectRef: string,
  functionSlug: string,
  activationId: string,
): Promise<EdgeFunctionActivationState> {
  const current = await currentActivationManifest(projectRef, functionSlug);
  return activationState(
    activationFences.get(activationFenceKey(projectRef, functionSlug)),
    activationAuthorityId(current),
    activationId,
  );
}

async function commitFunctionActivationFence(
  projectRef: string,
  functionSlug: string,
  activationId: string,
): Promise<EdgeFunctionActivationState> {
  const key = activationFenceKey(projectRef, functionSlug);
  const fence = activationFences.get(key);
  const current = await currentActivationManifest(projectRef, functionSlug);
  const state = activationState(fence, activationAuthorityId(current), activationId);
  if (state === "committed") {
    configCache.set(key, {
      ...current.config,
      activationId,
      targetState: current.authority?.target_state ?? null,
      artifactSha256: current.authority?.artifact_sha256 ?? null,
      authorityKind: current.authority === null ? "legacy" : "active",
      expiresAt: Date.now() + CONFIG_CACHE_TTL,
    });
    return state;
  }
  if (state !== "commit_pending" || !fence) return state;
  const preheated = fence.preheated;
  if (fence.candidate.authority.target_state === "active"
    && (!preheated
      || preheated.runtimeInstanceId !== RUNTIME_INSTANCE_ID
      || preheated.foregroundGeneration !== pool.generation
      || preheated.backgroundGeneration !== backgroundPool.generation)) {
    return "uncertain";
  }
  configCache.set(key, {
    ...fence.candidate.config,
    activationId,
    targetState: fence.candidate.authority.target_state,
    artifactSha256: fence.candidate.authority.artifact_sha256,
    authorityKind: "active",
    expiresAt: Date.now() + CONFIG_CACHE_TTL,
  });
  activationFences.delete(key);
  return "committed";
}

async function abortFunctionActivationFence(
  projectRef: string,
  functionSlug: string,
  activationId: string,
): Promise<EdgeFunctionActivationState> {
  const key = activationFenceKey(projectRef, functionSlug);
  const fence = activationFences.get(key);
  const current = await currentActivationManifest(projectRef, functionSlug);
  const state = activationState(fence, activationAuthorityId(current), activationId);
  if (state === "fenced" && fence) {
    activationFences.delete(key);
    return "aborted";
  }
  return state;
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
  const fencedResponse = activationFenceResponse(projectRef, functionName);
  if (fencedResponse) return fencedResponse;
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
  const activationChangedResponse = activationFenceResponse(projectRef, functionName);
  if (activationChangedResponse) return activationChangedResponse;
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
    instanceId: RUNTIME_INSTANCE_ID,
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

  .post("/internal/function-activation/:ref/:slug/begin", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    const activationId = activationIdHeader(c.request);
    if (!activationId
      || !isSafeProjectRef(c.params.ref)
      || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid Function activation identity");
    }
    try {
      return activationControlResponse(await beginFunctionActivation(
        c.params.ref,
        c.params.slug,
        activationId,
      ));
    } catch {
      return activationControlResponse(
        activationControlBody(activationId, "uncertain"),
        409,
      );
    }
  })

  .post("/internal/function-activation/:ref/:slug/commit", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    const activationId = activationIdHeader(c.request);
    if (!activationId
      || !isSafeProjectRef(c.params.ref)
      || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid Function activation identity");
    }
    const state = await commitFunctionActivationFence(
      c.params.ref,
      c.params.slug,
      activationId,
    );
    return activationControlResponse(
      activationControlBody(activationId, state),
      state === "committed" ? 200 : 409,
    );
  })

  .post("/internal/function-activation/:ref/:slug/abort", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    const activationId = activationIdHeader(c.request);
    if (!activationId
      || !isSafeProjectRef(c.params.ref)
      || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid Function activation identity");
    }
    const state = await abortFunctionActivationFence(
      c.params.ref,
      c.params.slug,
      activationId,
    );
    return activationControlResponse(
      activationControlBody(activationId, state),
      state === "aborted" || state === "committed" ? 200 : 409,
    );
  })

  .get("/internal/function-activation/:ref/:slug/status", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    const activationId = activationIdHeader(c.request);
    if (!activationId
      || !isSafeProjectRef(c.params.ref)
      || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid Function activation identity");
    }
    const state = await functionActivationState(
      c.params.ref,
      c.params.slug,
      activationId,
    );
    return activationControlResponse(
      activationControlBody(activationId, state),
      state === "uncertain" ? 409 : 200,
    );
  })

  .post("/invalidate/:ref/:slug", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    if (!isSafeProjectRef(c.params.ref) || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid project reference or function slug");
    }
    const leaseUnavailable = activationLeaseUnavailable();
    if (leaseUnavailable) return leaseUnavailable;

    const functionId = `${c.params.ref}_${c.params.slug}`;
    configCache.delete(`${c.params.ref}/${c.params.slug}`);
    invalidateTenantEnvCache(c.params.ref);
    const [foreground, background] = await Promise.all([
      pool.invalidateModule(functionId),
      backgroundPool.invalidateModule(functionId),
    ]);
    return {
      invalidated: functionId,
      runtime_instance_id: RUNTIME_INSTANCE_ID,
      module_scope: "legacy-base-only",
      immutable_versions_retained: true,
      config_cache_evicted: true,
      success: foreground.succeeded === foreground.attempted
        && background.succeeded === background.attempted,
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
    const leaseUnavailable = activationLeaseUnavailable();
    if (leaseUnavailable) return leaseUnavailable;

    invalidateTenantEnvCache(c.params.ref);
    const moduleEpoch = bumpProjectModuleEpoch(c.params.ref);
    const [foreground, background] = await Promise.all([
      pool.invalidateProject(c.params.ref),
      backgroundPool.invalidateProject(c.params.ref),
    ]);
    return { invalidated: c.params.ref, moduleEpoch, foreground, background };
  })

  .get("/internal/runtime-env-observation/:ref", (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    if (!isSafeProjectRef(c.params.ref)) {
      return badRequest("Invalid project reference");
    }
    return runtimeEnvObservation(c.params.ref);
  })

  .get("/internal/runtime-activation-epoch", (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    return {
      runtime_instance_id: RUNTIME_INSTANCE_ID,
      foreground_generation: pool.generation,
      background_generation: backgroundPool.generation,
    };
  })

  .post("/preheat/:ref/:slug", async (c) => {
    const authError = requireInternalAuth(c.request);
    if (authError) return authError;
    if (!isSafeProjectRef(c.params.ref) || !isSafeFunctionSlug(c.params.slug)) {
      return badRequest("Invalid project reference or function slug");
    }

    try {
      const requestedVersion = c.request.headers.get("x-supacloud-function-version") || null;
      const rawActivationId = c.request.headers.get("x-supacloud-activation-id");
      const activationId = rawActivationId === null ? null : activationIdHeader(c.request);
      if (rawActivationId !== null && activationId === null) {
        return badRequest("Invalid Function activation identity");
      }
      const fenceKey = activationFenceKey(c.params.ref, c.params.slug);
      const activeLease = activeActivationLease();
      if (activeLease
        && (activeLease.key !== fenceKey
          || activeLease.fence.candidate.authority.activation_id !== activationId)) {
        throw new Error("A foreign Function activation lease is active");
      }
      const activationFence = activationId ? activeLease?.fence : undefined;
      if (activationId
        && activationFence?.candidate.authority.activation_id !== activationId) {
        throw new Error("Function activation is not fenced by the requested candidate");
      }
      const activation = await preheatActivationSnapshot(
        c.params.ref,
        c.params.slug,
        requestedVersion,
        activationId,
      );
      const { functionPath, projectRoot, moduleVersion } = activation;
      const versionSuffix = activation.activeVersion ? `_v${activation.activeVersion}` : "";
      const functionId = `${c.params.ref}_${c.params.slug}${versionSuffix}`;
      const tenantEnvLoad = await loadTenantRuntimeEnv(c.params.ref);
      if (!isTenantEnvLoadCurrent(c.params.ref, tenantEnvLoad)) {
        throw new Error("Runtime environment changed during preheat");
      }
      const tenantEnv = tenantEnvLoad.env;
      const foregroundModuleEnvProof = tenantEnvModuleProof(
        c.params.ref,
        tenantEnv,
        tenantEnvLoad,
        "foreground",
      );
      const backgroundModuleEnvProof = tenantEnvModuleProof(
        c.params.ref,
        tenantEnv,
        tenantEnvLoad,
        "background",
      );
      const foregroundAttestation = runtimePreheatIdentity({
        projectRef: c.params.ref,
        functionSlug: c.params.slug,
        requestedVersion,
        activation,
        tenantEnvLoad,
        executionProfile: "foreground",
        moduleEnvProof: foregroundModuleEnvProof,
      });
      const backgroundAttestation = runtimePreheatIdentity({
        projectRef: c.params.ref,
        functionSlug: c.params.slug,
        requestedVersion,
        activation,
        tenantEnvLoad,
        executionProfile: "background",
        moduleEnvProof: backgroundModuleEnvProof,
      });
      const [foreground, background] = requestedVersion
        ? await Promise.all([
            pool.preheatVersionedIdleWorkers({
              functionId,
              functionPath,
              projectRoot,
              env: tenantEnv,
              projectRef: c.params.ref,
              moduleVersion,
              envProof: foregroundModuleEnvProof || undefined,
              attestation: foregroundAttestation ?? undefined,
            }),
            backgroundPool.preheatVersionedIdleWorkers({
              functionId,
              functionPath,
              projectRoot,
              env: tenantEnv,
              projectRef: c.params.ref,
              moduleVersion,
              envProof: backgroundModuleEnvProof || undefined,
              attestation: backgroundAttestation ?? undefined,
              maxWorkers: resolveBackgroundPreheatWorkers(),
            }),
          ])
        : await Promise.all([
            pool.preheatIdleWorkers(functionId, functionPath, projectRoot, tenantEnv, {
              projectRef: c.params.ref,
              moduleVersion,
              envProof: foregroundModuleEnvProof || undefined,
              attestation: foregroundAttestation ?? undefined,
            }),
            backgroundPool.preheatIdleWorkers(functionId, functionPath, projectRoot, tenantEnv, {
              projectRef: c.params.ref,
              moduleVersion,
              envProof: backgroundModuleEnvProof || undefined,
              attestation: backgroundAttestation ?? undefined,
              maxWorkers: resolveBackgroundPreheatWorkers(),
            }),
          ]);
      const complete = activation.attested
        && hasCompletePreheatAttestation(foreground)
        && hasCompletePreheatAttestation(background)
        && isTenantEnvLoadCurrent(c.params.ref, tenantEnvLoad)
        && (!activationId || activationFences.get(fenceKey) === activationFence);
      const generationProof = activationPreheatProof(foreground, background);
      const generationsCurrent = generationProof !== null
        && generationProof.foregroundGeneration === pool.generation
        && generationProof.backgroundGeneration === backgroundPool.generation;
      if (complete && activationFence && generationsCurrent) {
        activationFence.preheated = generationProof;
      }
      const attestation = complete ? foreground.attestation : null;
      return {
        preheated: functionId,
        version: requestedVersion,
        success: complete
          && tenantEnvLoad.loadState === "loaded"
          && (!activationFence || generationsCurrent),
        attestation,
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
    const fencedResponse = activationFenceResponse(c.params.ref, c.params.functionName);
    if (fencedResponse) return fencedResponse;

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const tenantEnvLoad = await loadTenantRuntimeEnv(c.params.ref);
    const backgroundDispatch = buildBackgroundForwardDispatch(c.request, tenantEnvLoad.env);
    const requestedVersion = backgroundDispatch.forwardedRequest.headers.get("x-supacloud-function-version");
    let response: Response;
    try {
      const activation = await resolveFunctionPath(
        c.params.ref,
        c.params.functionName,
        requestedVersion,
        resolveTrustedBackgroundFunctionVersionBinding,
      );
      const activationChangedResponse = activationFenceResponse(
        c.params.ref,
        c.params.functionName,
      );
      if (activationChangedResponse) return activationChangedResponse;
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
          tenantEnv: backgroundDispatch.tenantEnv,
          tenantEnvLoad,
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
    const fencedResponse = activationFenceResponse(c.params.ref, c.params.functionName);
    if (fencedResponse) return fencedResponse;

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const tenantEnvLoad = await loadTenantRuntimeEnv(c.params.ref);
    const backgroundDispatch = buildBackgroundForwardDispatch(c.request, tenantEnvLoad.env);
    const requestedVersion = backgroundDispatch.forwardedRequest.headers.get("x-supacloud-function-version");
    let response: Response;
    try {
      const activation = await resolveFunctionPath(
        c.params.ref,
        c.params.functionName,
        requestedVersion,
        resolveTrustedBackgroundFunctionVersionBinding,
      );
      const activationChangedResponse = activationFenceResponse(
        c.params.ref,
        c.params.functionName,
      );
      if (activationChangedResponse) return activationChangedResponse;
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
          tenantEnv: backgroundDispatch.tenantEnv,
          tenantEnvLoad,
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
