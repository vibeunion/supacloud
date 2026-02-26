import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { projectRoutes, organizationRoutes, userRoutes, backupRoutes, monitorRoutes, maintenanceRoutes, extensionRoutes, securityRoutes, storageRoutes, scalingRoutes, taskRoutes } from "./routes";

const app = new Elysia({ strictPath: false })
  // Swagger 文档
  .use(
    swagger({
      documentation: {
        info: {
          title: "SupaCloud Management API",
          version: "1.0.0",
          description: "API for managing SupaCloud multi-tenant projects",
        },
        tags: [
          { name: "projects", description: "Project management endpoints" },
          { name: "organizations", description: "Organization management endpoints" },
          { name: "user", description: "User profile endpoints" },
          { name: "backups", description: "Database backup and restore endpoints" },
          { name: "monitor", description: "Database monitoring and health endpoints" },
          { name: "maintenance", description: "High availability and cluster maintenance" },
          { name: "extensions", description: "PostgreSQL extension management (Market)" },
          { name: "security", description: "Firewall and SSL security management" },
          { name: "storage", description: "JuiceFS storage and S3 migration management" },
          { name: "scaling", description: "Auto-scaling and vertical upgrade management" },
          { name: "tasks", description: "Background task monitoring" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })
  )
  // CORS
  .use(cors())

  // 健康检查 (无需认证)
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // API 版本信息 (无需认证)
  .get("/", () => ({
    name: "SupaCloud Management API",
    version: "1.0.0",
    docs: "/swagger",
  }))

  // 需要认证的路由
  .use(authMiddleware)
  .use(projectRoutes)
  .use(organizationRoutes)
  .use(userRoutes)
  .use(backupRoutes)
  .use(monitorRoutes)
  .use(maintenanceRoutes)
  .use(extensionRoutes)
  .use(securityRoutes)
  .use(storageRoutes)
  .use(scalingRoutes)
  .use(taskRoutes)

  // 错误处理
  .onError(({ code, error, set }) => {
    console.error(`Error [${code}]:`, error);

    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation failed", details: error.message };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }

    set.status = 500;
    return { error: "Internal server error" };
  })

  .listen(config.port);

import { taskWorker } from "./services/task.worker";
taskWorker.start();

console.log(`
╔═══════════════════════════════════════════════════════════╗
║          SupaCloud Management API                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${config.port}                ║
║  Swagger docs at:   http://localhost:${config.port}/swagger        ║
╚═══════════════════════════════════════════════════════════╝
`);

export { app };
