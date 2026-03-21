import "./url-import-plugin";
import { Elysia } from "elysia";
import { WorkerPool } from "./worker-pool";
import { loadTenantEnv } from "./tenant-env";

const PORT = Number(process.env.PORT) || 9000;
const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE) || 4;

const pool = new WorkerPool({
  size: POOL_SIZE,
  requestTimeout: 20_000,
});

const app = new Elysia()
  .get("/health", () => ({ status: "ok", runtime: "bun-edge" }))
  .get("/metrics", () => pool.getMetrics())

  .all("/functions/v1/:functionName", async (c) => {
    const projectRef = c.headers["x-project-ref"];
    if (!projectRef) return c.error(400, "Missing x-project-ref");

    const functionId = `${projectRef}_${c.params.functionName}`;
    const functionPath = `./functions/${projectRef}/${c.params.functionName}.ts`;

    try {
      return await pool.dispatch({
        functionId,
        functionPath,
        env: await loadTenantEnv(projectRef),
        request: c.request,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal Error";
      return c.error(500, { error: message });
    }
  })

  .listen(PORT);

console.log(`🚀 Edge Runtime on :${PORT} (${POOL_SIZE} workers)`);
