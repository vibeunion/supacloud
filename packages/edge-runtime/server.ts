import "./url-import-plugin";
import { Elysia } from "elysia";
import { WorkerPool } from "./worker-pool";
import { loadTenantEnv } from "./tenant-env";
import path from "path";

const PORT = Number(process.env.PORT) || 9000;
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;
const FUNCTIONS_DIR = process.env.EDGE_FUNCTIONS_DIR || "./functions";

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

  .listen(PORT);

console.log(`🚀 Edge Runtime on :${PORT} (${POOL_SIZE} workers)`);
