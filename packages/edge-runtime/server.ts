import "./url-import-plugin";
import { Elysia } from "elysia";
import { WorkerPool } from "./worker-pool";
import { loadTenantEnv } from "./tenant-env";
import path from "path";
import { execSync } from "child_process";

const PORT = Number(process.env.PORT) || 9000;
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;
const FUNCTIONS_DIR = process.env.EDGE_FUNCTIONS_DIR || "./functions";

// ── Startup Port-Exclusivity Guard ──────────────────────────────────
// Prevent SO_REUSEPORT ghost processes: kill ALL existing listeners on
// our target port before binding.  This eliminates the "zombie process"
// bug where an old Bun runtime co-exists and receives ~50 % of traffic.
function killStaleListeners(port: number): void {
  const myPid = process.pid;
  try {
    // lsof returns lines like: "bun  12345 root ... TCP *:9000 (LISTEN)"
    const out = execSync(
      `lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    if (!out) return;

    const pids = out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((p) => !isNaN(p) && p !== myPid);

    for (const pid of pids) {
      console.warn(
        `[PortGuard] Killing stale listener pid=${pid} on port ${port}`,
      );
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }

    // Brief wait for them to terminate
    if (pids.length > 0) {
      execSync("sleep 0.5");
      // Force-kill any survivors
      for (const pid of pids) {
        try {
          process.kill(pid, 0); // check alive
          process.kill(pid, "SIGKILL");
          console.warn(`[PortGuard] Force-killed pid=${pid}`);
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    // lsof may not be installed — best-effort guard
  }
}

killStaleListeners(PORT);

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

const app = new Elysia()
  .get("/health", () => ({ status: "ok", runtime: "bun-edge" }))
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
    return dispatchFunction(projectRef, c.params.functionName, c.request, c.set.headers as Record<string, string>);
  })

  .listen(PORT);

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
