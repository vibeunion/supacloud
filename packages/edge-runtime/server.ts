import "./url-import-plugin";
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { WorkerPool } from "./worker-pool";
import { loadTenantEnv } from "./tenant-env";
import path from "path";
import fs from "fs/promises";

const PORT = Number(process.env.EDGE_RUNTIME_PORT) || Number(process.env.PORT) || 9000;
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;
const BACKGROUND_POOL_SIZE = Number(process.env.BACKGROUND_WORKER_POOL_SIZE) || Math.max(1, Math.min(POOL_SIZE, 2));
const FUNCTIONS_DIR = process.env.EDGE_FUNCTIONS_DIR || "./functions";
const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const VERSIONED_DIR = ".versions";

if (!process.env.MANAGEMENT_API_URL) {
  console.warn(
    "[EdgeRuntime] WARNING: MANAGEMENT_API_URL is not set. Defaulting to http://127.0.0.1:9090. If edge-runtime runs on a different node than management-api, this will fail!",
  );
}

const MASTER_TOKEN = process.env.MASTER_TOKEN || "";

if (!process.env.EDGE_RUNTIME_VERSION) {
  process.env.EDGE_RUNTIME_VERSION = "1.58.3";
}

const pool = new WorkerPool({
  size: POOL_SIZE,
  requestTimeout: 300_000,
});

const backgroundPool = new WorkerPool({
  size: BACKGROUND_POOL_SIZE,
  requestTimeout: 900_000,
});

async function dispatchFunction(
  projectRef: string,
  functionName: string,
  request: Request,
  setHeaders: Record<string, string>,
  opts?: {
    background?: boolean;
    cancelKey?: string;
    onLog?: (entry: {
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }) => void;
  },
) {
  const requestedVersion = request.headers.get("x-supacloud-function-version") || null;
  const resolvedConfig = await getFunctionConfig(projectRef, functionName);
  const activeVersion = requestedVersion || resolvedConfig.version || null;
  const versionSuffix = requestedVersion ? `_v${requestedVersion}` : "";
  const functionId = `${projectRef}_${functionName}${versionSuffix}`;
  const versionedJsPath = requestedVersion
    ? path.resolve(FUNCTIONS_DIR, projectRef, VERSIONED_DIR, functionName, requestedVersion, "index.js")
    : null;
  const jsPath = path.resolve(FUNCTIONS_DIR, projectRef, `${functionName}.js`);
  const tsPath = path.resolve(FUNCTIONS_DIR, projectRef, `${functionName}.ts`);
  const functionPath = versionedJsPath && (await Bun.file(versionedJsPath).exists())
    ? versionedJsPath
    : (await Bun.file(jsPath).exists())
      ? jsPath
      : tsPath;

  try {
    const targetPool = opts?.background ? backgroundPool : pool;
    const runtimeLogContext = {
      functionVersion: activeVersion,
      executionId: setHeaders["x-sb-execution-id"] || null,
      background: opts?.background === true,
    };
    return await targetPool.dispatch({
      functionId,
      functionPath,
      env: await loadTenantEnv(projectRef),
      request,
      cancelKey: opts?.cancelKey,
      onLog: (entry) => {
        void appendFunctionRuntimeLog(projectRef, functionName, entry, runtimeLogContext);
        opts?.onLog?.(entry);
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Error";

    setHeaders["x-relay-error"] = "true";

    const statusCode =
      message.includes("not found") || message.includes("ENOENT")
        ? 404
        : message.includes("timeout") || message.includes("Timeout")
          ? 504
          : 500;

    return new Response(JSON.stringify({ error: message }), {
      status: statusCode,
      headers: { "Content-Type": "application/json", "x-relay-error": "true" },
    });
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

function verifyInternalBackgroundAuth(request: Request): boolean {
  const internalHeader = request.headers.get("x-supacloud-internal-auth");
  const token = (internalHeader || request.headers.get("authorization"))?.replace(/^Bearer\s+/i, "");
  return !!MASTER_TOKEN && token === MASTER_TOKEN;
}

function buildBackgroundForwardedRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  const originalAuthorization = headers.get("x-supacloud-auth-authorization");
  const originalApikey = headers.get("x-supacloud-auth-apikey");

  headers.delete("x-supacloud-internal-auth");
  headers.delete("x-supacloud-auth-authorization");
  headers.delete("x-supacloud-auth-apikey");

  if (originalAuthorization) {
    headers.set("authorization", originalAuthorization);
  } else {
    headers.delete("authorization");
  }

  if (originalApikey) {
    headers.set("apikey", originalApikey);
  } else {
    headers.delete("apikey");
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    duplex: ["GET", "HEAD"].includes(request.method) ? undefined : "half",
  } as RequestInit & { duplex?: "half" });
}

const configCache = new Map<
  string,
  { verify_jwt: boolean; version: string | null; expiresAt: number }
>();
const CONFIG_CACHE_TTL = 10_000;

async function getFunctionConfig(
  projectRef: string,
  functionName: string,
): Promise<{ verify_jwt: boolean; version: string | null }> {
  const key = `${projectRef}/${functionName}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { verify_jwt: cached.verify_jwt, version: cached.version };
  }

  try {
    const configPath = path.resolve(
      FUNCTIONS_DIR,
      projectRef,
      `${functionName}.config.json`,
    );
    const raw = await Bun.file(configPath).text();
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
  expiresAt: number;
}
const secretsCache = new Map<string, ProjectSecrets>();
const SECRETS_CACHE_TTL = 300_000;

async function getProjectSecrets(
  projectRef: string,
): Promise<ProjectSecrets | null> {
  const cached = secretsCache.get(projectRef);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const [keysRes, detailRes] = await Promise.all([
      fetch(`${MGMT_API}/v1/projects/${projectRef}/api-keys`, {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${MGMT_API}/v1/projects/${projectRef}`, {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (!keysRes.ok || !detailRes.ok) {
      console.warn(
        `[verifyJwt] Failed to fetch secrets for ${projectRef}: keys=${keysRes.status} detail=${detailRes.status}`,
      );
      if (cached) return cached;
      return null;
    }

    const keysArray = (await keysRes.json()) as {
      name: string;
      api_key: string;
    }[];
    const detail = (await detailRes.json()) as { jwt_secret?: string };

    const secrets: ProjectSecrets = {
      anonKey: keysArray?.find?.((k) => k.name === "anon")?.api_key || "",
      serviceRoleKey:
        keysArray?.find?.((k) => k.name === "service_role")?.api_key || "",
      jwtSecret: detail.jwt_secret || "",
      expiresAt: Date.now() + SECRETS_CACHE_TTL,
    };
    secretsCache.set(projectRef, secrets);
    return secrets;
  } catch (err) {
    console.warn(
      `[verifyJwt] Error fetching secrets for ${projectRef}:`,
      err instanceof Error ? err.message : err,
    );
    if (cached) return cached;
    return null;
  }
}

async function verifyJwt(
  projectRef: string,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<boolean> {
  const secrets = await getProjectSecrets(projectRef);
  if (!secrets) return false;

  if (
    apikeyHeader &&
    (apikeyHeader === secrets.anonKey ||
      apikeyHeader === secrets.serviceRoleKey)
  ) {
    return true;
  }

  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  if (token === secrets.anonKey || token === secrets.serviceRoleKey)
    return true;

  if (!secrets.jwtSecret) return false;
  try {
    const { jwtVerify } = await import("jose");
    await jwtVerify(token, new TextEncoder().encode(secrets.jwtSecret));
    return true;
  } catch (e) {
    console.warn(`[verifyJwt] JWT error for ${projectRef}:`, e);
    return false;
  }
}

async function handleFunctionRequest(
  c: { params: Record<string, string>; headers: Record<string, string | undefined>; request: Request; set: { headers: Record<string, string | number> } },
  functionName: string,
) {
  const projectRef = c.headers["x-project-ref"];
  if (!projectRef) {
    c.set.headers["x-relay-error"] = "true";
    return new Response(JSON.stringify({ error: "Missing x-project-ref" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "x-relay-error": "true",
      },
    });
  }

  const fnConfig = await getFunctionConfig(projectRef, functionName);
  if (c.request.method !== "OPTIONS" && fnConfig.verify_jwt) {
    const authorized = await verifyJwt(
      projectRef,
      c.headers["authorization"],
      c.headers["apikey"],
    );
    if (!authorized) {
      return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  c.set.headers["x-sb-execution-id"] = crypto.randomUUID();
  return dispatchFunction(
    projectRef,
    functionName,
    c.request,
    c.set.headers as Record<string, string>,
  );
}

const app = new Elysia()
  .use(cors())
  .get("/health", () => ({
    status: "ok",
    runtime: "bun-edge",
    version: process.env.EDGE_RUNTIME_VERSION,
    mt: process.env.MASTER_TOKEN ? "present" : "missing",
    url: process.env.MANAGEMENT_API_URL || "missing",
    pools: {
      foreground: POOL_SIZE,
      background: BACKGROUND_POOL_SIZE,
    },
  }))
  .get("/metrics", () => {
    const foreground = pool.snapshotMetrics("supacloud_edge");
    const background = backgroundPool.snapshotMetrics("supacloud_edge_background");
    return Object.entries({ ...foreground, ...background })
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
  })

  .post("/invalidate/:ref/:slug", (c) => {
    const functionId = `${c.params.ref}_${c.params.slug}`;
    pool.invalidateModule(functionId);
    return { invalidated: functionId };
  })

  .post("/preheat/:ref/:slug", async (c) => {
    const functionId = `${c.params.ref}_${c.params.slug}`;
    const jsPath = path.resolve(
      FUNCTIONS_DIR,
      c.params.ref,
      `${c.params.slug}.js`,
    );
    const tsPath = path.resolve(
      FUNCTIONS_DIR,
      c.params.ref,
      `${c.params.slug}.ts`,
    );
    const functionPath = (await Bun.file(jsPath).exists()) ? jsPath : tsPath;
    const success = await pool.preheat(functionId, functionPath);
    return { preheated: functionId, success };
  })

  .post("/internal/background/:ref/:functionName/*", async (c) => {
    if (!verifyInternalBackgroundAuth(c.request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const forwardedRequest = buildBackgroundForwardedRequest(c.request);
    const response = await dispatchFunction(
      c.params.ref,
      c.params.functionName,
      forwardedRequest,
      setHeaders,
      {
        background: true,
        cancelKey: c.request.headers.get("x-supacloud-task-id") || undefined,
        onLog: (entry) => {
          logs.push(entry);
          if (logs.length > 200) logs.shift();
        },
      },
    );
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
    if (!verifyInternalBackgroundAuth(c.request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const setHeaders = c.set.headers as Record<string, string>;
    setHeaders["x-sb-execution-id"] = crypto.randomUUID();
    setHeaders["x-supacloud-background-pool"] = "true";
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    const forwardedRequest = buildBackgroundForwardedRequest(c.request);
    const response = await dispatchFunction(
      c.params.ref,
      c.params.functionName,
      forwardedRequest,
      setHeaders,
      {
        background: true,
        cancelKey: c.request.headers.get("x-supacloud-task-id") || undefined,
        onLog: (entry) => {
          logs.push(entry);
          if (logs.length > 200) logs.shift();
        },
      },
    );
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
    if (!verifyInternalBackgroundAuth(c.request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

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

  .listen({ port: PORT, hostname: "0.0.0.0" });

console.log(`🚀 Edge Runtime on :${PORT} (${POOL_SIZE} workers)`);

let shuttingDown = false;
const gracefulShutdown = async (signal: string) => {
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

  process.exit(0);
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
