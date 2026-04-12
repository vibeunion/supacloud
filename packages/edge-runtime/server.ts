import "./url-import-plugin";
import { Elysia } from "elysia";
import { WorkerPool } from "./worker-pool";
import { loadTenantEnv } from "./tenant-env";
import path from "path";
import { execSync } from "child_process";

const PORT = Number(process.env.PORT) || 9000;
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;
const FUNCTIONS_DIR = process.env.EDGE_FUNCTIONS_DIR || "./functions";
const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";

if (!process.env.MANAGEMENT_API_URL) {
  console.warn("[EdgeRuntime] WARNING: MANAGEMENT_API_URL is not set. Defaulting to http://127.0.0.1:9090. If edge-runtime runs on a different node than management-api, this will fail!");
}

const MASTER_TOKEN = process.env.MASTER_TOKEN || "";

// Startup Port-Exclusivity Guard is handled by edge-runtime-manager in management-api

const pool = new WorkerPool({
  size: POOL_SIZE,
  requestTimeout: 300_000,  // 5 min — covers long AI streaming responses
});

async function dispatchFunction(
  projectRef: string,
  functionName: string,
  request: Request,
  setHeaders: Record<string, string>,
) {
  const functionId = `${projectRef}_${functionName}`;
  // Prefer bundled .js output from server-side Bun.build(), fall back to raw .ts
  const jsPath = path.resolve(FUNCTIONS_DIR, projectRef, `${functionName}.js`);
  const tsPath = path.resolve(FUNCTIONS_DIR, projectRef, `${functionName}.ts`);
  const functionPath = (await Bun.file(jsPath).exists()) ? jsPath : tsPath;

  try {
    return await pool.dispatch({
      functionId,
      functionPath,
      env: await loadTenantEnv(projectRef),
      request,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Error";

    // x-relay-error tells the SDK this is an infrastructure error,
    // not a response from the user's function
    setHeaders["x-relay-error"] = "true";

    const statusCode = message.includes("not found") || message.includes("ENOENT")
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

// ── Function Config Cache ───────────────────────────────────────────────
// Cache verify_jwt config per function with short TTL to avoid API calls on every invocation
const configCache = new Map<string, { verify_jwt: boolean; expiresAt: number }>();
const CONFIG_CACHE_TTL = 10_000; // 10s

async function getFunctionConfig(projectRef: string, functionName: string): Promise<{ verify_jwt: boolean }> {
  const key = `${projectRef}/${functionName}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { verify_jwt: cached.verify_jwt };
  }

  // Try reading the config file directly (faster than API call)
  try {
    const configPath = path.resolve(FUNCTIONS_DIR, projectRef, `${functionName}.config.json`);
    const raw = await Bun.file(configPath).text();
    const config = JSON.parse(raw);
    const verify_jwt = config.verify_jwt !== false; // default true
    configCache.set(key, { verify_jwt, expiresAt: Date.now() + CONFIG_CACHE_TTL });
    return { verify_jwt };
  } catch {
    // No config file = default (verify_jwt: true)
    configCache.set(key, { verify_jwt: true, expiresAt: Date.now() + CONFIG_CACHE_TTL });
    return { verify_jwt: true };
  }
}

/** Verify JWT token against Management API's project JWT secret */
async function verifyJwt(projectRef: string, authHeader: string | null | undefined): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(`[verifyJwt] Failed to fetch api-keys for ${projectRef}: HTTP ${res.status}`);
      return false;
    }
    const keysArray = await res.json() as { name: string; api_key: string }[];
    const anonKey = keysArray?.find?.(k => k.name === "anon")?.api_key;
    const serviceRoleKey = keysArray?.find?.(k => k.name === "service_role")?.api_key;
    
    // Allow both anon_key and service_role_key as valid bearer tokens
    if (token && (token === anonKey || token === serviceRoleKey)) return true;
    
    // If token is an actual JWT, verify signature via jose
    const { jwtVerify } = await import("jose");
    // Fetch JWT secret
    const detailRes = await fetch(`${MGMT_API}/v1/projects/${projectRef}`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!detailRes.ok) {
      console.warn(`[verifyJwt] Failed to fetch project detail for ${projectRef}: HTTP ${detailRes.status}`);
      return false;
    }
    const detail = await detailRes.json() as { jwt_secret?: string };
    if (!detail.jwt_secret) {
      console.warn(`[verifyJwt] Project ${projectRef} has no jwt_secret or fetch failed`);
      return false;
    }
    
    try {
      await jwtVerify(token, new TextEncoder().encode(detail.jwt_secret));
      return true;
    } catch (e) {
      console.warn(`[verifyJwt] jwtVerify failed for token (starts with ${token.substring(0, 10)}...):`, e);
      return false;
    }
  } catch (err) {
    console.error("[verifyJwt] Uncaught error during verification:", err);
    return false;
  }
}

const app = new Elysia()
  .get("/health", () => ({ status: "ok", runtime: "bun-edge", mt: process.env.MASTER_TOKEN ? "present" : "missing", url: process.env.MANAGEMENT_API_URL || "missing" }))
  .get("/metrics", () => pool.getMetrics())

  // Cache invalidation — called by Management API after deploy
  .post("/invalidate/:ref/:slug", (c) => {
    const functionId = `${c.params.ref}_${c.params.slug}`;
    pool.invalidateModule(functionId);
    return { invalidated: functionId };
  })

  // Pre-heat function — called by Management API after deploy to eliminate cold-start
  .post("/preheat/:ref/:slug", async (c) => {
    const functionId = `${c.params.ref}_${c.params.slug}`;
    const jsPath = path.resolve(FUNCTIONS_DIR, c.params.ref, `${c.params.slug}.js`);
    const tsPath = path.resolve(FUNCTIONS_DIR, c.params.ref, `${c.params.slug}.ts`);
    const functionPath = (await Bun.file(jsPath).exists()) ? jsPath : tsPath;
    const success = await pool.preheat(functionId, functionPath);
    return { preheated: functionId, success };
  })

  // Main function invoke — handles supabase.functions.invoke('name', { body })
  // Supports nested paths: /functions/v1/name/sub/path
  .all("/functions/v1/:functionName/*", async (c) => {
    const projectRef = c.headers["x-project-ref"];
    if (!projectRef) {
      c.set.headers["x-relay-error"] = "true";
      return new Response(JSON.stringify({ error: "Missing x-project-ref" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "x-relay-error": "true" },
      });
    }

    // Check verify_jwt config
    const fnConfig = await getFunctionConfig(projectRef, c.params.functionName);
    if (c.request.method !== "OPTIONS" && fnConfig.verify_jwt) {
      const authorized = await verifyJwt(projectRef, c.headers["authorization"]);
      if (!authorized) {
        return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return dispatchFunction(projectRef, c.params.functionName, c.request, c.set.headers as Record<string, string>);
  })

  .all("/functions/v1/:functionName", async (c) => {
    const projectRef = c.headers["x-project-ref"];
    if (!projectRef) {
      c.set.headers["x-relay-error"] = "true";
      return new Response(JSON.stringify({ error: "Missing x-project-ref" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "x-relay-error": "true" },
      });
    }

    const fnConfig = await getFunctionConfig(projectRef, c.params.functionName);
    if (c.request.method !== "OPTIONS" && fnConfig.verify_jwt) {
      const authorized = await verifyJwt(projectRef, c.headers["authorization"]);
      if (!authorized) {
        return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return dispatchFunction(projectRef, c.params.functionName, c.request, c.set.headers as Record<string, string>);
  })

  // Fallback routes for Kong strip_path: true scenarios
  // e.g. Kong strips /functions/v1 and sends /delegation/ocr directly
  .all("/:functionName/*", async (c) => {
    const projectRef = c.headers["x-project-ref"];
    if (!projectRef) {
      c.set.headers["x-relay-error"] = "true";
      return new Response(JSON.stringify({ error: "Missing x-project-ref" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "x-relay-error": "true" },
      });
    }

    const fnConfig = await getFunctionConfig(projectRef, c.params.functionName);
    if (c.request.method !== "OPTIONS" && fnConfig.verify_jwt) {
      const authorized = await verifyJwt(projectRef, c.headers["authorization"]);
      if (!authorized) {
        return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return dispatchFunction(projectRef, c.params.functionName, c.request, c.set.headers as Record<string, string>);
  })

  .all("/:functionName", async (c) => {
    const projectRef = c.headers["x-project-ref"];
    if (!projectRef) {
      c.set.headers["x-relay-error"] = "true";
      return new Response(JSON.stringify({ error: "Missing x-project-ref" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "x-relay-error": "true" },
      });
    }

    const fnConfig = await getFunctionConfig(projectRef, c.params.functionName);
    if (c.request.method !== "OPTIONS" && fnConfig.verify_jwt) {
      const authorized = await verifyJwt(projectRef, c.headers["authorization"]);
      if (!authorized) {
        return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return dispatchFunction(projectRef, c.params.functionName, c.request, c.set.headers as Record<string, string>);
  })

  .listen({ port: PORT, hostname: "0.0.0.0" });

console.log(`🚀 Edge Runtime on :${PORT} (${POOL_SIZE} workers)`);

// ── Graceful shutdown ───────────────────────────────────────────────
// Allow in-flight requests to complete before exiting.
// Without this, SIGTERM (from systemctl restart) kills immediately,
// dropping active requests mid-flight.
let shuttingDown = false;
const gracefulShutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[EdgeRuntime] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  try { app.stop(); } catch { /* Elysia stop may throw if already stopped */ }

  // Allow in-flight requests up to 10s to complete, then force exit
  const forceExitTimeout = setTimeout(() => {
    console.error("[EdgeRuntime] Force exit after timeout");
    process.exit(1);
  }, 10_000);
  forceExitTimeout.unref(); // Don't keep process alive just for the timeout
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Global error boundaries ─────────────────────────────────────────
// Prevent silent crashes that leave zombie processes bound to the port.
process.on("uncaughtException", (err) => {
  console.error("[EdgeRuntime] FATAL uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[EdgeRuntime] unhandledRejection:", reason);
  // Don't exit — log and continue (may be a user function bug)
});
